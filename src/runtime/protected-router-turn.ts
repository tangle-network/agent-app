/**
 * A Router turn under a protected model grant.
 *
 * Runtime resolves, reserves, activates and settles the grant around exactly
 * one `runRouterTurn` (`runProtectedAgentCandidateModelGrant`); the turn's model
 * calls use the grant's scoped key and base URL; the settled ledger is the
 * turn's only usage. GTM's bounded lane and Legal's paid consultations run here
 * through `createProtectedRuntimeChatProducer`, on the same engine as every
 * other Router turn. This module stays off the `./router-turn` entry: the grant
 * client pulls agent-runtime chunks a Worker bundle cannot build
 * (tests/router-turn-entry.test.ts).
 *
 * Every refusal and failure is a typed outcome. Codes:
 * - `grant_deadline`, `grant_model_unsupported`, `grant_activation_missing`:
 *   refused before any model call.
 * - `grant_failed`: the grant could not be resolved, reserved or activated.
 * - `grant_unsettled`: the turn failed and its grant did not settle either.
 * - `settlement_over_limit`, `settlement_unauthorized_reasoning`,
 *   `settlement_audit_failed`: the turn answered, but its settled ledger failed
 *   a check; the answer stands and the turn still fails.
 * - `turn_deadline`: the grant's deadline ended the turn.
 * - Anything else is the turn's own failure (`turn_aborted`, `turn_tool_limit`,
 *   `model_http_<status>`, ...), settled as `failed`.
 */
import {
  runProtectedAgentCandidateModelGrant,
  type RunProtectedAgentCandidateModelGrantOptions,
} from '@tangle-network/agent-runtime/candidate-execution'
import { ProtectedModelSettlementError } from './protected-model'
import { runRouterTurn, type RouterTurnFailure, type RouterTurnOptions, type RouterTurnOutcome } from './router-turn'

/** Runtime's grant inputs for one turn: the port, the model request, the reservation and its deadline. */
export type RouterTurnGrant = Omit<RunProtectedAgentCandidateModelGrantOptions<void>, 'execute'>

type GrantSettlement = Awaited<ReturnType<RouterTurnGrant['port']['settleGrant']>>

/** A turn under a grant. The grant supplies the key and base URL; one grant never repeats a turn. */
export type ProtectedRouterTurnOptions = Omit<RouterTurnOptions, 'apiKey' | 'baseUrl' | 'repeat'> & {
  grant: RouterTurnGrant
}

export interface ProtectedRouterTurnOutcome extends RouterTurnOutcome {
  /** What the grant settled, present whenever it settled, including for a failed turn. */
  settlement?: RouterTurnSettlement
}

/** What the grant settled for the turn. */
export interface RouterTurnSettlement {
  /** Runtime's settled ledger, retained even when a check on it fails. */
  receipt: GrantSettlement
  /** The model the grant resolved and reserved. */
  model?: string
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number }
  /** Router certified the usage within the grant's limits, and no call reasoned under a grant
   *  that disabled reasoning. */
  budgetEnforced: boolean
}

/**
 * Providers whose client function tools are verified over Chat Completions with
 * reasoning disabled. Router refuses provider-hosted tools and cache markers on
 * candidate grants, so tool-result text is billed as input and accounted input
 * covers OpenAI's automatic cached prefix.
 */
const GRANT_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai'])

class GrantRefusal extends Error {
  constructor(readonly failure: RouterTurnFailure) {
    super(failure.message)
    this.name = 'GrantRefusal'
  }
}

const refuse = (code: string, message: string) => new GrantRefusal({ code, message })

function failureOf(error: unknown): RouterTurnFailure {
  if (error instanceof GrantRefusal) return error.failure
  if (error instanceof ProtectedModelSettlementError) return { code: 'settlement_audit_failed', message: error.message }
  if (error instanceof AggregateError) return { code: 'grant_unsettled', message: error.message }
  return { code: 'grant_failed', message: error instanceof Error ? error.message : 'The model grant failed.' }
}

/** Run one `runRouterTurn` under `options.grant`. */
export async function runProtectedRouterTurn(options: ProtectedRouterTurnOptions): Promise<ProtectedRouterTurnOutcome> {
  const { grant, ...turnOptions } = options
  let turn: RouterTurnOutcome | undefined
  let settlement: RouterTurnSettlement | undefined
  let resolvedModel: string | undefined
  const result = (failure?: RouterTurnFailure): ProtectedRouterTurnOutcome => {
    const base: RouterTurnOutcome = turn
      ?? { text: '', servedModel: null, toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, modelCalls: 0 } }
    // The grant's verdict replaces the turn's own failure.
    const { failure: _turnFailure, ...rest } = base
    return { ...rest, ...(settlement ? { settlement } : {}), ...(failure ? { failure } : {}) }
  }
  if (options.signal?.aborted) return result({ code: 'turn_aborted', message: 'The turn was cancelled.' })
  if (Date.now() >= grant.deadlineAtMs) return result({ code: 'grant_deadline', message: 'Protected execution deadline expired' })
  try {
    await runProtectedAgentCandidateModelGrant({
      ...grant,
      port: {
        resolve: async input => {
          const resolved = await grant.port.resolve(input)
          resolvedModel = resolved.model
          return resolved
        },
        reserveGrant: input => grant.port.reserveGrant(input),
        activateGrant: input => grant.port.activateGrant(input),
        // Runtime settles failed executions before rethrowing. Retain that receipt too.
        settleGrant: async input => {
          let auditError: ProtectedModelSettlementError | undefined
          const receipt = await grant.port.settleGrant(input).catch(error => {
            if (!(error instanceof ProtectedModelSettlementError)) throw error
            auditError = error
            return error.settlement
          })
          const usage = {
            inputTokens: receipt.calls.reduce((sum, call) => sum + call.accountedInputTokens, 0),
            outputTokens: receipt.calls.reduce((sum, call) => sum + call.outputTokens, 0),
            reasoningTokens: receipt.calls.reduce((sum, call) => sum + call.reasoningTokens, 0),
            costUsd: receipt.calls.reduce((sum, call) => sum + call.costUsdNanos, 0) / 1e9,
          }
          // Execution limits carry no reasoning allowance, so a provider that
          // reasons under a disabled-reasoning grant exceeded what was authorized.
          const unauthorizedReasoning = usage.reasoningTokens > 0 && grant.resolve.reasoningEffort === 'none'
          const budgetEnforced = receipt.usageWithinLimits && !unauthorizedReasoning
          settlement = { receipt, ...(resolvedModel ? { model: resolvedModel } : {}), usage, budgetEnforced }
          if (unauthorizedReasoning) {
            throw refuse('settlement_unauthorized_reasoning', 'Provider reported reasoning tokens although reasoning was disabled')
          }
          if (!budgetEnforced) throw refuse('settlement_over_limit', 'Provider settlement exceeded execution limits')
          if (auditError) throw auditError
          return receipt
        },
      },
      execute: async ({ activation, resolved }) => {
        if (options.signal?.aborted) throw refuse('turn_aborted', 'The turn was cancelled.')
        if (Date.now() >= grant.deadlineAtMs) throw refuse('grant_deadline', 'Protected execution deadline expired')
        if (!GRANT_PROVIDERS.has(resolved.provider) || resolved.reasoningEffort !== 'none') {
          throw refuse('grant_model_unsupported', 'Protected chat currently requires an Anthropic or OpenAI model without reasoning')
        }
        const apiKey = activation.env.OPENAI_API_KEY
        const baseUrl = activation.env.OPENAI_BASE_URL
        if (!apiKey || !baseUrl) throw refuse('grant_activation_missing', 'Protected Router activation is missing')
        const remainingMs = Math.max(1, grant.deadlineAtMs - Date.now())
        // One grant is one bounded unit: no automatic second billable call, and the
        // grant's deadline ends the model call in flight.
        turn = await runRouterTurn({
          ...turnOptions, apiKey, baseUrl, repeat: false,
          budgetMs: Math.min(options.budgetMs ?? remainingMs, remainingMs),
          signal: AbortSignal.any([AbortSignal.timeout(remainingMs), ...(options.signal ? [options.signal] : [])]),
        })
        // The grant's timeout aborts the call in flight; that is the deadline, not a cancellation.
        // A turn past its deadline fails here: finishing it would need a second grant.
        if (turn.failure?.code === 'turn_aborted' && Date.now() >= grant.deadlineAtMs) {
          throw refuse('turn_deadline', 'Protected execution deadline expired')
        }
        if (turn.failure) throw new GrantRefusal(turn.failure)
      },
    })
  } catch (error) {
    return result(failureOf(error))
  }
  return result()
}
