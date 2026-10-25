/**
 * `createSandboxRunTool`: the `sandbox_run` tool a Router turn calls when the
 * work needs a computer — run code, read a PDF or a sheet, fill a form with a
 * Python toolkit. The conversational turn stays on the Router engine
 * (`./router-turn`); only this call enters the box, and its final answer comes
 * back to the model as the tool result.
 *
 * NEVER SILENT. A box that cannot start, a run that fails and a run that ends
 * with no answer each come back as a typed failure (`sandbox_unavailable`,
 * `sandbox_failed`, `sandbox_empty`) that the model reads and must report. A
 * product that leaves this tool out when it cannot place a box drops the
 * capability without the model or the user knowing; mount the tool and let it
 * fail instead.
 *
 * WARM LEASES. When the product passes `warm`, the call counts as a turn on the
 * box's lease (`leases.turn(key)`), so an `escalation-likely` warm the product
 * signalled is recorded as used. The default name is the one the speculator
 * listens for (`DEFAULT_ESCALATION_TOOLS`). `createHybridTurnProducer` in
 * `/chat-routes` mounts this tool with the turn's single box start.
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { TurnSpan, TurnTrace } from '../turn-trace/recorder'
import { runSandboxPrompt, type SandboxRuntimeConfig, type StreamSandboxPromptOptions } from './index'
import { SandboxRunError, type SandboxRunFailureCode } from './sandbox-run-error'
import { serializeSandboxProvisioningError } from './diagnostics'
export { SandboxRunError, type SandboxRunFailureCode } from './sandbox-run-error'

/** The engine's per-call tool context (`RouterTurnToolContext`), kept structural so this module does not import the engine. */
export interface SandboxToolContext {
  /** The Router engine's call identity; never derived from task text. */
  callId?: string
  signal?: AbortSignal
  /** The engine-resolved member request, including checkpoint continuation. */
  userMessage?: string
  emit(kind: string, data?: unknown): void
  /** The turn's trace and this call's `tool.call` span (`runRouterTurn` supplies both). The box claim, the box run and the
   *  trace id sent to the Sandbox API follow from them; without them nothing is recorded. */
  trace?: TurnTrace
  span?: TurnSpan
}

export interface SandboxTaskOptions {
  /** Stable identity of this tool invocation, when the calling engine supplies it. */
  callId?: string
  signal: AbortSignal
  timeoutMs: number
  /** Streams a typed side event from the box run (a progress step, a file written) as the turn's `tool_event`. */
  emit(kind: string, data?: unknown): void
  /** The turn's trace and this call's span, for a runner that streams a prompt (`sandboxPromptRunner` does). */
  trace?: TurnTrace
  span?: TurnSpan
}

export interface SandboxRunToolOptions {
  /** The box this call runs in. The product provisions, binds and bills it; this module never
   *  creates one. A throw is reported to the model as `sandbox_unavailable`, unless it is a
   *  `SandboxRunError`, whose own code and message are kept (an unpaid account, for example). */
  box(signal: AbortSignal): Promise<SandboxInstance>
  /** Runs the task on the box and returns the box agent's final answer: {@link sandboxPromptRunner}
   *  for the shell's own prompt path, or the product's runner (skill placement, app-tool MCP, a spend tap). */
  runTask(box: SandboxInstance, task: string, options: SandboxTaskOptions): Promise<string>
  /** The member's original message, preserved verbatim before the Router task. */
  memberRequest?: string
  /** Wall-clock cap for one call, box start included. Default 5 minutes. */
  timeoutMs?: number
  /** Cancels a call in flight, for example the turn's own signal. */
  signal?: AbortSignal
  /** The box's warm lease, so the call is recorded as a turn on it. */
  warm?: { leases: { turn(key: string): Promise<unknown> }; key: string }
  /** Every failure with its cause and the tool call it belongs to. The model only reads the typed message;
   *  {@link sandboxRunFailureDetail} is the redacted cause chain to keep. `createHybridTurnProducer` already
   *  persists that chain on the turn's warning notice. */
  onFailure?(error: SandboxRunError, call: { callId?: string }): void
  name?: string
  description?: string
}

/** The tool shape `runRouterTurn` takes (`RouterTurnTool`), kept structural so this module does not import the engine. */
export interface SandboxRunTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, context?: SandboxToolContext): Promise<{ answer: string; ms: number }>
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const TASK_LIMIT = 20_000

export const SANDBOX_RUN_DESCRIPTION =
  'Run work that needs a computer in this workspace\'s sandbox: executing code or scripts, reading or converting ' +
  'PDFs, spreadsheets and archives, filling forms with the installed toolkits, or editing many files. Describe the ' +
  "member's requirements, file paths and exact field names, not model-written code; the sandbox agent writes and " +
  'runs the code and returns its answer. Takes seconds to minutes, ' +
  'so use it only when the answer needs the computer.'

/** The redacted cause chain of a computer-step failure, one line, for a durable record: each cause's name, code,
 *  status and message, outermost first, credentials and signed URLs removed. */
export function sandboxRunFailureDetail(error: unknown): string {
  return serializeSandboxProvisioningError(error).causes
    .map(cause => [cause.name, cause.code !== undefined ? `code=${cause.code}` : '',
      cause.status !== undefined ? `status=${cause.status}` : '', cause.message].filter(Boolean).join(' '))
    .join(' <- ')
    .slice(0, 2_000)
}

/** The shell's unattended runner. A supplied execution/turn id seeds child
 * identity with the actual tool callId: different calls stay separate and a
 * retry of that exact call stays idempotent. Without callId, use a fresh child.
 *
 * Its failure follows the send witness, in a shared and an isolated session alike: a failure before the prompt
 * was handed to the SDK is `sandbox_unavailable` (nothing runs on the box, so the turn may use it again); after
 * it, the step stays unconfirmed. */
export function sandboxPromptRunner(shell: SandboxRuntimeConfig, prompt: Omit<StreamSandboxPromptOptions, 'signal' | 'history'> = {}): SandboxRunToolOptions['runTask'] {
  return async (box, task, { callId, signal, timeoutMs, trace, span }) => {
    const parent = prompt.executionId?.trim() || prompt.turnId?.trim()
    const identity = parent ? new TextEncoder().encode(JSON.stringify([parent, prompt.sessionId, callId?.trim() || crypto.randomUUID()])) : undefined
    const digest = identity ? await crypto.subtle.digest('SHA-256', identity) : undefined
    const child = digest ? Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') : undefined
    let sent = false
    try {
      return await runSandboxPrompt(shell, box, task, {
        ...prompt, ...(child ? { executionId: child, turnId: child } : {}), signal, timeoutMs, disallowQuestions: true,
        ...(trace ? { trace } : {}), ...(span ? { traceParent: span } : {}),
        onDispatch: () => { sent = true; prompt.onDispatch?.() },
      })
    } catch (error) {
      if (sent || error instanceof SandboxRunError || signal.aborted) throw error
      throw new SandboxRunError('sandbox_unavailable', 'The computer step was refused before it was sent to the box.', { cause: error })
    }
  }
}

export function createSandboxRunTool(options: SandboxRunToolOptions): SandboxRunTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const runTask = options.runTask
  return {
    name: options.name ?? 'sandbox_run',
    description: options.description ?? SANDBOX_RUN_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The member requirements, file paths and exact output field names. The sandbox agent writes and runs the code.' } },
      required: ['task'],
      additionalProperties: false,
    },
    async run(args, context) {
      const fail = (code: SandboxRunFailureCode, message: string, cause?: unknown): never => {
        const error = new SandboxRunError(code, message, cause === undefined ? undefined : { cause })
        options.onFailure?.(error, { ...(context?.callId ? { callId: context.callId } : {}) })
        throw error
      }
      const emit = (kind: string, data?: unknown) => { try { context?.emit(kind, data) } catch { /* a view never fails the call */ } }
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (!task || task.length > TASK_LIMIT) {
        return fail('invalid_arguments', `task must be 1 to ${TASK_LIMIT} characters`)
      }
      const started = Date.now()
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs),
        ...(options.signal ? [options.signal] : []), ...(context?.signal ? [context.signal] : [])])
      if (options.warm) await options.warm.leases.turn(options.warm.key).catch(() => {})
      // A product's box() may not honour the signal either (a hung provision); the cap still holds.
      const capped = <T,>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })])
      let box: SandboxInstance
      const claim = context?.span?.child('sandbox.claim', 'sandbox')
      try {
        box = await capped(options.box(signal))
        claim?.end()
      } catch (error) {
        claim?.end(undefined, error instanceof SandboxRunError ? error.code : 'sandbox_unavailable')
        if (error instanceof SandboxRunError) return fail(error.code, error.message, error.cause)
        return fail('sandbox_unavailable', 'The workspace computer could not be acquired. Its availability could not be confirmed.', error)
      }
      emit('box_ready', { ms: Date.now() - started })
      let answer: string
      try {
        // A product runner may not honour the signal; the call still ends at the cap.
        const memberRequest = context?.userMessage ?? options.memberRequest
        const prefix = memberRequest === undefined ? ''
          : `The member's request (verbatim):\n${memberRequest}\n\nYour part of it:\n`
        // The member contract is never truncated, even when it alone exceeds the task budget.
        const boxTask = prefix + task.slice(0, Math.max(0, TASK_LIMIT - prefix.length))
        answer = await capped(runTask(box, boxTask, {
          signal, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), emit,
          ...(context?.callId ? { callId: context.callId } : {}),
          ...(context?.trace ? { trace: context.trace } : {}), ...(context?.span ? { span: context.span } : {}),
        }))
      } catch (error) {
        if (error instanceof SandboxRunError) return fail(error.code, error.message, error.cause)
        const timedOut = signal.aborted && !options.signal?.aborted && !context?.signal?.aborted
        return fail('sandbox_unconfirmed', timedOut
          ? `The computer step did not return an answer within ${Math.round(timeoutMs / 1000)} s. Its completion could not be confirmed.`
          : 'The computer step failed to return an answer. Its completion could not be confirmed.', error)
      }
      if (!answer.trim()) return fail('sandbox_empty', 'The sandbox finished without an answer.')
      return { answer, ms: Date.now() - started }
    },
  }
}
