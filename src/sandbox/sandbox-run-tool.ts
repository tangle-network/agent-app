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
 * box's lease (`leases.turn(key)`), so an `escalation-likely` warm from
 * `createEscalationSpeculator` is recorded as used. The default name is the
 * one the speculator listens for (`DEFAULT_ESCALATION_TOOLS`).
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import type { TurnSpan, TurnTrace } from '../turn-trace/recorder'
import { runSandboxPrompt, type SandboxRuntimeConfig, type StreamSandboxPromptOptions } from './index'

export type SandboxRunFailureCode = 'sandbox_unavailable' | 'sandbox_failed' | 'sandbox_empty' | 'invalid_arguments'

/** A typed `sandbox_run` failure. `code` and `message` are what the model reads. */
export class SandboxRunError extends Error {
  constructor(readonly code: SandboxRunFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SandboxRunError'
  }
}

/** The engine's per-call tool context (`RouterTurnToolContext`), kept structural so this module does not import the engine. */
export interface SandboxToolContext {
  emit(kind: string, data?: unknown): void
  /** The turn's trace and this call's `tool.call` span (`runRouterTurn` supplies both). The box claim, the box run and the
   *  trace id sent to the Sandbox API follow from them; without them nothing is recorded. */
  trace?: TurnTrace
  span?: TurnSpan
}

export interface SandboxTaskOptions {
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
  /** Wall-clock cap for one call, box start included. Default 5 minutes. */
  timeoutMs?: number
  /** Cancels a call in flight, for example the turn's own signal. */
  signal?: AbortSignal
  /** The box's warm lease, so the call is recorded as a turn on it. */
  warm?: { leases: { turn(key: string): Promise<unknown> }; key: string }
  /** Every failure with its cause, for the product's logs. The model only reads the typed message. */
  onFailure?(error: SandboxRunError): void
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
  'whole task and the result you need; the sandbox agent does it and returns its answer. Takes seconds to minutes, ' +
  'so use it only when the answer needs the computer.'

/** The default `runTask`: the shell's own `runSandboxPrompt`, unattended (questions refused). */
export function sandboxPromptRunner(shell: SandboxRuntimeConfig, prompt: Omit<StreamSandboxPromptOptions, 'signal' | 'history'> = {}): SandboxRunToolOptions['runTask'] {
  return (box, task, { signal, timeoutMs, trace, span }) => runSandboxPrompt(shell, box, task, {
    ...prompt, signal, timeoutMs, disallowQuestions: true,
    ...(trace ? { trace } : {}), ...(span ? { traceParent: span } : {}),
  })
}

export function createSandboxRunTool(options: SandboxRunToolOptions): SandboxRunTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const runTask = options.runTask
  const fail = (code: SandboxRunFailureCode, message: string, cause?: unknown): never => {
    const error = new SandboxRunError(code, message, cause === undefined ? undefined : { cause })
    options.onFailure?.(error)
    throw error
  }
  return {
    name: options.name ?? 'sandbox_run',
    description: options.description ?? SANDBOX_RUN_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The complete task for the sandbox agent, with the result you need back.' } },
      required: ['task'],
      additionalProperties: false,
    },
    async run(args, context) {
      const emit = (kind: string, data?: unknown) => { try { context?.emit(kind, data) } catch { /* a view never fails the call */ } }
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (!task || task.length > TASK_LIMIT) {
        return fail('invalid_arguments', `task must be 1 to ${TASK_LIMIT} characters`)
      }
      const started = Date.now()
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])])
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
        return fail('sandbox_unavailable', 'The sandbox for this workspace could not start, so this work was not done.', error)
      }
      emit('box_ready', { ms: Date.now() - started })
      let answer: string
      try {
        // A product runner may not honour the signal; the call still ends at the cap.
        answer = await capped(runTask(box, task, {
          signal, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), emit,
          ...(context?.trace ? { trace: context.trace } : {}), ...(context?.span ? { span: context.span } : {}),
        }))
      } catch (error) {
        const timedOut = signal.aborted && !options.signal?.aborted
        return fail('sandbox_failed', timedOut
          ? `The sandbox did not finish within ${Math.round(timeoutMs / 1000)} s, so this work was not done.`
          : 'The sandbox run failed, so this work was not done.', error)
      }
      if (!answer.trim()) return fail('sandbox_empty', 'The sandbox finished without an answer.')
      return { answer, ms: Date.now() - started }
    },
  }
}
