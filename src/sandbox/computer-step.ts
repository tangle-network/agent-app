/**
 * `createComputerStep`: what one `sandbox_run` call does on the workspace box,
 * owned once for every app. GTM, Creative and Legal each wrote this step, and
 * each break on 2026-10-24 was in one of those copies (agent-app-lessons.md,
 * "Computer steps"). The step:
 *
 * - runs the first of the turn's models the box key allows: the box calls the
 *   Router on its own key, whose models are the payer's sandbox policy
 *   (`readSandboxRouterModels`), so a model outside it is refused before a token;
 *   a run that ends refused for its model (`provider_disabled`, quota) moves to the
 *   next allowed one under its own execution id;
 * - takes its session as one value, `{ id, isolated }`, which sets both
 *   `secretProfileIsolation` and the send witness;
 * - is as durable as the Sandbox runtime, and keeps no ledger of its own. It sends
 *   detached, under a turn id derived from the turn, the session and the tool
 *   call: the run outlives this request, and the runtime's admission makes a
 *   repeated or reattached call with that turn id the same run. The SDK reads a
 *   finished run's answer from the runtime's completed turn, and replays an
 *   unfinished one's events to its end; it never sends a second run;
 * - copies what the box agent wrote under the Vault root since its run started
 *   (the runtime ledger's start time) into the app's Vault (`files`), whenever it
 *   observes the run's end, and appends the receipt line the model may relay;
 * - with `questions`, lets the box agent ask the member: each ask streams to the
 *   turn as a `computer_interaction` event, and the member's answer reaches the
 *   box through the runtime's interaction registry (the app's interaction route).
 *
 * The product keeps the prompt path when it has its own (`run`); otherwise the
 * step uses agent-app's `runSandboxPrompt` over the product's shell.
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { SandboxRuntimeConfig } from './configuration'
import type { StreamSandboxPromptOptions } from './prompt-options'
import { runSandboxPrompt } from './prompt-result'
import { isComputerInteractionEvent } from './prompt-events'
import { SandboxRunError } from './sandbox-run-error'
import { COMPUTER_FILES_GUIDANCE, computerFileContract, saveComputerFiles, type ComputerVault } from './computer-files'
import { modelWithinAllowList } from './router-models'
import { isUpstreamUnavailable } from '../model-resolution/failover'
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
  /** Stable for the turn, the session and the tool call: send under it as both execution and turn id, detached, so the
   *  runtime's admission makes a repeated call the same run. */
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
    | 'signal' | 'timeoutMs' | 'trace' | 'traceParent' | 'disallowQuestions' | 'history' | 'detach'>
  /** The product's own prompt path, instead of `shell`. Returns the box agent's final answer. */
  run?(box: SandboxInstance, task: string, step: ComputerStepRun): Promise<string>
  /** `run` passes `step.onDispatch` to a send that calls it (agent-app's `streamSandboxPrompt`, `runSandboxPrompt`
   *  and `driveSandboxTurn` do), so a failure before it fired was never sent. Without it, every `run` failure is
   *  unconfirmed. The `shell` path always witnesses. */
  runWitnessesDispatch?: boolean
  /** The turn's execution id; with the tool call id it makes the step's turn id. Without it each call sends fresh. */
  parentExecutionId?: string
  /** The session: one value, or prepared per box (a secret-isolated session). A failure there is never sent. Without
   *  a session the `shell` path cannot send detached, and the run ends with this request. */
  session?: ComputerStepSession | ((box: SandboxInstance, signal: AbortSignal) => Promise<ComputerStepSession>)
  /** The turn's models in preference order and the box key's allow-list (`readSandboxRouterModels`). */
  models?: {
    preferred: readonly string[]
    allowed(signal: AbortSignal): Promise<Outcome<readonly string[] | null>>
  }
  /** Copy each file the step wrote under the Vault root into the product's Vault. Omit it when the product already
   *  reconciles the box's Vault directory after a turn (GTM does). */
  files?: ComputerVault
  /** The product's filesystem contract, applied to every task. */
  frame?(task: string): string
  /** Let the box agent ask the member questions instead of failing on the first one. The `shell` path streams each
   *  ask as a `computer_interaction` event; a product `run` emits them itself. */
  questions?: boolean
}

export interface ComputerStep {
  runTask: SandboxRunToolOptions['runTask']
  /** What the Router model must be told about this step's answers. */
  guidance?: string
}

const ALLOW_LIST_BUDGET_MS = 5_000

async function digestHex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/** The models the step tries in order. `undefined` runs the product's own model; it leads when no policy constrains
 *  the turn's models, and each later entry is a fallback for a run its model's provider refused. */
async function modelChain(models: ComputerStepOptions['models'], signal: AbortSignal): Promise<Array<string | undefined>> {
  if (!models?.preferred.length) return [undefined]
  const policy = await models.allowed(AbortSignal.any([signal, AbortSignal.timeout(ALLOW_LIST_BUDGET_MS)]))
    .catch((error: unknown): Outcome<never> => ({ succeeded: false, error: error instanceof Error ? error : new Error(String(error)) }))
  if (!policy.succeeded) {
    // An unread policy keeps the product's model; a refusal then names itself in the step's failure.
    console.warn(JSON.stringify({ event: 'agent_app_computer_model_policy_unread', error: errorText(policy.error) }))
  }
  if (!policy.succeeded || policy.value === null) return [undefined, ...models.preferred.slice(1)]
  const allowed = policy.value
  const first = modelWithinAllowList(models.preferred, allowed)
  if (first !== models.preferred[0]) {
    console.info(JSON.stringify({ event: 'agent_app_computer_model_within_policy', requested: models.preferred[0], model: first ?? null }))
  }
  return [...new Set([first, ...models.preferred.filter(model => allowed.includes(model))])]
}

/** A run that reached its end refused for its model: nothing is left running, and another model may serve. */
function refusedForModel(error: unknown): boolean {
  if (error instanceof SandboxRunError && error.code !== 'sandbox_failed') return false
  for (let cause: unknown = error, depth = 0; cause && depth < 5; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (isUpstreamUnavailable(cause)) return true
  }
  return false
}

/** When the step's first run started, from the runtime's execution ledger: the box's clock, as its files' times are. */
async function runStartedAt(box: SandboxInstance, sessionId: string | undefined, executionIds: readonly string[]): Promise<number | undefined> {
  if (!sessionId || executionIds.length === 0) return undefined
  try {
    const started = (await box.session(sessionId).runs())
      .filter(run => executionIds.includes(run.executionId)).map(run => run.startedAt).filter(Number.isFinite)
    return started.length ? Math.min(...started) : undefined
  } catch (error) {
    console.warn(JSON.stringify({ event: 'agent_app_computer_run_ledger_unread', sessionId, error: errorText(error) }))
    return undefined
  }
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
    // The runtime's admission is keyed by this id: the same turn, session and tool call is the same run.
    const stepId = parent ? await digestHex([parent, session?.id, call || crypto.randomUUID()]) : undefined
    const report = (state: string, extra: Record<string, unknown>) => taskOptions.emit('computer_receipt', {
      stepId: stepId ?? null, sessionId: session?.id ?? null, state, ...extra })

    const models = await modelChain(options.models, signal)
    let model = models[0]
    const framed = vault ? computerFileContract(vault.root.replace(/\/+$/, ''), frame(task)) : frame(task)
    const attempted: string[] = []
    const send = (attemptModel: string | undefined, executionId: string | undefined): Promise<string> => {
      if (executionId) attempted.push(executionId)
      if (options.run) {
        return options.run(box, framed, { ...taskOptions, ...(executionId ? { executionId } : {}),
          ...(session ? { session } : {}), ...(attemptModel ? { model: attemptModel } : {}), onDispatch: () => { sent = true } })
      }
      const prompt = options.prompt ?? {}
      return runSandboxPrompt(options.shell!, box, framed, {
        ...prompt, ...(attemptModel ? { model: attemptModel } : {}),
        ...(executionId ? { executionId, turnId: executionId } : {}),
        ...(session ? { sessionId: session.id } : {}),
        ...(session?.isolated ? { secretProfileIsolation: true as const } : {}),
        // The run outlives this request; a repeated call reattaches to it through the runtime's admission.
        ...(session && executionId ? { detach: true } : {}),
        ...(options.questions
          ? { interactions: { ...prompt.interactions, question: true } }
          : { disallowQuestions: true }),
        signal, timeoutMs,
        ...(trace ? { trace } : {}), ...(span ? { traceParent: span } : {}),
        onDispatch: () => { sent = true; prompt.onDispatch?.() },
      }, options.questions
        ? event => { if (isComputerInteractionEvent(event)) taskOptions.emit('computer_interaction', event) }
        : undefined)
    }
    let answer: string
    for (let attempt = 0; ; attempt++) {
      model = models[attempt]
      try {
        // A fallback is a new run: its own execution id, so a repeat attaches to the same attempt.
        answer = await send(model, stepId && attempt > 0 ? `${stepId}-f${attempt + 1}` : stepId)
        break
      } catch (error) {
        // A run without a witness counts as sent; one refused for its model has ended, so the next may go.
        if ((sent || !witnessed) && attempt + 1 < models.length && !signal.aborted && refusedForModel(error)) {
          console.warn(JSON.stringify({ event: 'agent_app_computer_model_fallback', stepId: stepId ?? null,
            from: model ?? null, to: models[attempt + 1] ?? null, error: errorText(error) }))
          sent = false
          continue
        }
        if (sent || !witnessed) throw error
        return notSent(error)
      }
    }
    // An empty answer stays empty, so the tool reports `sandbox_empty`; a file receipt must not hide it.
    if (!answer.trim()) return answer
    const files = vault
      ? await saveComputerFiles({ box, vault, since: await runStartedAt(box, session?.id, attempted), executionId: stepId ?? 'unnamed-step' })
      : undefined
    const final = files ? `${answer}\n\n${files.text}` : answer
    report('settled', { model: model ?? null, saved: files?.saved ?? [], computerOnly: files?.computerOnly.length ?? 0 })
    return final
  }
  return { runTask, ...(vault ? { guidance: COMPUTER_FILES_GUIDANCE } : {}) }
}
