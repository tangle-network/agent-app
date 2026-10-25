/**
 * `createComputerStep`: what one `sandbox_run` call does on the workspace box,
 * owned once for every app. GTM, Creative and Legal each wrote this step, and
 * each break on 2026-10-24 was in one of those copies (agent-app-lessons.md,
 * "Computer steps"). The step:
 *
 * - runs the first of the turn's models the box key allows: the box calls the
 *   Router on its own key, whose models are the payer's sandbox policy
 *   (`readSandboxRouterModels`), so a model outside it is refused before a token;
 * - takes its session as one value, `{ id, isolated }`, which sets both
 *   `secretProfileIsolation` and the send witness;
 * - sends under a step id derived from the turn, the session and the tool call,
 *   so a repeated call attaches to its run instead of sending a second one;
 * - keeps a durable receipt (`receipts`): a repeated call returns it and sends nothing;
 * - copies what the box agent wrote under the Vault root into the app's Vault
 *   (`files`) and appends the receipt line the model may relay.
 *
 * The product keeps the prompt path when it has its own (`run`); otherwise the
 * step uses agent-app's `runSandboxPrompt` over the product's shell.
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { SandboxRuntimeConfig } from './configuration'
import type { StreamSandboxPromptOptions } from './prompt-options'
import { runSandboxPrompt } from './prompt-result'
import { SandboxRunError } from './sandbox-run-error'
import { COMPUTER_FILES_GUIDANCE, computerFileContract, listComputerFiles, saveComputerFiles, type ComputerFileListing, type ComputerVault } from './computer-files'
import type { ComputerStepReceipts } from './computer-receipts'
import { modelWithinAllowList } from './router-models'
import type { Outcome } from './outcome'
import type { SandboxRunToolOptions, SandboxTaskOptions } from './sandbox-run-tool'

/** The box session one computer step runs in. */
export interface ComputerStepSession {
  id: string
  /** A secret-isolated native session the product prepared before the send. */
  isolated?: boolean
}

/** What a product's own prompt path receives for one step. */
export interface ComputerStepRun extends SandboxTaskOptions {
  /** Stable for the turn, the session and the tool call: send under it as both execution and turn id. */
  executionId?: string
  session?: ComputerStepSession
  /** Set only when the box key's policy constrains the turn's models; otherwise run the product's model. */
  model?: string
  /** The send witness: pass it as the prompt's `onDispatch`, or call it exactly at the send. */
  onDispatch(): void
}

export interface ComputerStepOptions {
  /** agent-app's prompt path over the product's shell. */
  shell?: SandboxRuntimeConfig
  /** That path's options, other than the ones the step owns. `onDispatch` here observes the step's own witness. */
  prompt?: Omit<StreamSandboxPromptOptions, 'sessionId' | 'executionId' | 'turnId' | 'secretProfileIsolation'
    | 'signal' | 'timeoutMs' | 'trace' | 'traceParent' | 'disallowQuestions' | 'history'>
  /** The product's own prompt path, instead of `shell`. Returns the box agent's final answer. */
  run?(box: SandboxInstance, task: string, step: ComputerStepRun): Promise<string>
  /** `run` passes `step.onDispatch` to a send that calls it (agent-app's `streamSandboxPrompt`, `runSandboxPrompt`
   *  and `driveSandboxTurn` do), so a failure before it fired was never sent. Without it, every `run` failure is
   *  unconfirmed. The `shell` path always witnesses. */
  runWitnessesDispatch?: boolean
  /** The turn's execution id; with the tool call id it makes the step id. Without it each call sends fresh. */
  parentExecutionId?: string
  /** The session: one value, or prepared per box (a secret-isolated session). A failure there is never sent. */
  session?: ComputerStepSession | ((box: SandboxInstance, signal: AbortSignal) => Promise<ComputerStepSession>)
  /** The turn's models in preference order and the box key's allow-list (`readSandboxRouterModels`). */
  models?: {
    preferred: readonly string[]
    allowed(signal: AbortSignal): Promise<Outcome<readonly string[] | null>>
  }
  /** Copy each file the step wrote under the Vault root into the product's Vault. */
  files?: ComputerVault
  /** The product's filesystem contract, applied to every task. */
  frame?(task: string): string
  /** Durable step receipts (`createD1ComputerStepReceipts`). */
  receipts?: ComputerStepReceipts
}

export interface ComputerStep {
  runTask: SandboxRunToolOptions['runTask']
  /** What the Router model must be told about this step's answers. */
  guidance?: string
}

const ALLOW_LIST_BUDGET_MS = 5_000
// A listing larger than this is not kept in the prepared receipt; the live request still diffs it.
const RECEIPT_LISTING_LIMIT = 2_000

async function digestHex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

async function chooseModel(models: ComputerStepOptions['models'], signal: AbortSignal): Promise<string | undefined> {
  if (!models?.preferred.length) return undefined
  const policy = await models.allowed(AbortSignal.any([signal, AbortSignal.timeout(ALLOW_LIST_BUDGET_MS)]))
    .catch((error: unknown): Outcome<never> => ({ succeeded: false, error: error instanceof Error ? error : new Error(String(error)) }))
  if (!policy.succeeded) {
    // An unread policy keeps the product's model; a refusal then names itself in the step's failure.
    console.warn(JSON.stringify({ event: 'agent_app_computer_model_policy_unread', error: errorText(policy.error) }))
    return undefined
  }
  if (policy.value === null) return undefined
  const model = modelWithinAllowList(models.preferred, policy.value)
  if (model !== models.preferred[0]) {
    console.info(JSON.stringify({ event: 'agent_app_computer_model_within_policy', requested: models.preferred[0], model: model ?? null }))
  }
  return model
}

export function createComputerStep(options: ComputerStepOptions): ComputerStep {
  if (!options.run && !options.shell) throw new Error('A computer step needs the product shell or its own run')
  const vault = options.files
  const frame = options.frame ?? ((task: string) => task)
  const runTask: ComputerStep['runTask'] = async (box, task, taskOptions) => {
    const { callId, signal, timeoutMs, trace, span } = taskOptions
    let sent = false
    const witnessed = options.run ? options.runWitnessesDispatch === true : true
    const notSent = (error: unknown): never => {
      if (error instanceof SandboxRunError || signal.aborted) throw error
      throw new SandboxRunError('sandbox_unavailable', 'The computer step was refused before it was sent to the box.', { cause: error })
    }
    const session = typeof options.session === 'function'
      ? await options.session(box, signal).catch(notSent)
      : options.session
    const parent = options.parentExecutionId?.trim()
    const call = callId?.trim()
    const stepId = parent ? await digestHex([parent, session?.id, call || crypto.randomUUID()]) : undefined
    // Only a step named by its tool call can be repeated, so only that one reads a receipt.
    const receipts = stepId && call ? options.receipts : undefined
    const prior = await receipts?.read(stepId!).catch((error: unknown) => {
      console.warn(JSON.stringify({ event: 'agent_app_computer_receipt_unread', stepId, error: errorText(error) }))
      return null
    })
    const report = (state: string, extra: Record<string, unknown>) => taskOptions.emit('computer_receipt', {
      stepId: stepId ?? null, sessionId: session?.id ?? null, state, ...extra })
    if (prior?.state === 'settled' && prior.answer?.trim()) {
      report('settled', { model: prior.model ?? null, saved: prior.files?.saved ?? [], repeated: true })
      return prior.answer
    }

    const model = await chooseModel(options.models, signal)
    const before: ComputerFileListing | undefined = vault
      ? prior?.before ?? await listComputerFiles(box, vault.root.replace(/\/+$/, ''))
      : undefined
    if (receipts) {
      const kept = before?.succeeded && Object.keys(before.files).length > RECEIPT_LISTING_LIMIT ? undefined : before
      await receipts.write({ stepId: stepId!, state: 'prepared', sessionId: session?.id ?? '', ...(model ? { model } : {}),
        ...(kept ? { before: kept } : {}), updatedAt: Date.now() }).catch((error: unknown) => {
        console.warn(JSON.stringify({ event: 'agent_app_computer_receipt_unwritten', stepId, state: 'prepared', error: errorText(error) }))
      })
    }

    const framed = vault ? computerFileContract(vault.root.replace(/\/+$/, ''), frame(task)) : frame(task)
    let answer: string
    try {
      if (options.run) {
        answer = await options.run(box, framed, { ...taskOptions, ...(stepId ? { executionId: stepId } : {}),
          ...(session ? { session } : {}), ...(model ? { model } : {}), onDispatch: () => { sent = true } })
      } else {
        const prompt = options.prompt ?? {}
        answer = await runSandboxPrompt(options.shell!, box, framed, {
          ...prompt, ...(model ? { model } : {}),
          ...(stepId ? { executionId: stepId, turnId: stepId } : {}),
          ...(session ? { sessionId: session.id } : {}),
          ...(session?.isolated ? { secretProfileIsolation: true as const } : {}),
          signal, timeoutMs, disallowQuestions: true,
          ...(trace ? { trace } : {}), ...(span ? { traceParent: span } : {}),
          onDispatch: () => { sent = true; prompt.onDispatch?.() },
        })
      }
    } catch (error) {
      if (sent || !witnessed) throw error
      return notSent(error)
    }
    // An empty answer stays empty, so the tool reports `sandbox_empty`; a file receipt must not hide it.
    if (!answer.trim()) return answer
    const files = vault && before ? await saveComputerFiles({ box, vault, before, executionId: stepId ?? 'unnamed-step' }) : undefined
    const final = files ? `${answer}\n\n${files.text}` : answer
    if (receipts) {
      await receipts.write({ stepId: stepId!, state: 'settled', sessionId: session?.id ?? '', ...(model ? { model } : {}),
        answer: final, ...(files ? { files } : {}), updatedAt: Date.now() }).catch((error: unknown) => {
        console.warn(JSON.stringify({ event: 'agent_app_computer_receipt_unwritten', stepId, state: 'settled', error: errorText(error) }))
      })
    }
    report('settled', { model: model ?? null, saved: files?.saved ?? [], computerOnly: files?.computerOnly.length ?? 0 })
    return final
  }
  return { runTask, ...(vault ? { guidance: COMPUTER_FILES_GUIDANCE } : {}) }
}
