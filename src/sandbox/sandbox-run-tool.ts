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
import { runSandboxPrompt, type SandboxRuntimeConfig, type StreamSandboxPromptOptions } from './index'

export type SandboxRunFailureCode = 'sandbox_unavailable' | 'sandbox_failed' | 'sandbox_empty' | 'invalid_arguments'

/** A typed `sandbox_run` failure. `code` and `message` are what the model reads. */
export class SandboxRunError extends Error {
  constructor(readonly code: SandboxRunFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SandboxRunError'
  }
}

export interface SandboxRunToolOptions {
  /** The shell the default runner (`runSandboxPrompt`) uses. Required unless `runTask` is given. */
  shell?: SandboxRuntimeConfig
  /** The box this call runs in. The product provisions, binds and bills it; this module never
   *  creates one. A throw is reported to the model as `sandbox_unavailable`, unless it is a
   *  `SandboxRunError`, whose own code and message are kept (an unpaid account, for example). */
  box(signal: AbortSignal): Promise<SandboxInstance>
  /** Options for the box's agent run: session, profile, model and credentials. */
  prompt?: Omit<StreamSandboxPromptOptions, 'signal' | 'history'>
  /** The product's own runner, when its box run needs more than `runSandboxPrompt` (skill
   *  placement, app-tool MCP, a spend tap). Returns the box agent's final answer. */
  runTask?(box: SandboxInstance, task: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<string>
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
  run(args: Record<string, unknown>): Promise<{ answer: string; ms: number }>
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const TASK_LIMIT = 20_000

export const SANDBOX_RUN_DESCRIPTION =
  'Run work that needs a computer in this workspace\'s sandbox: executing code or scripts, reading or converting ' +
  'PDFs, spreadsheets and archives, filling forms with the installed toolkits, or editing many files. Describe the ' +
  'whole task and the result you need; the sandbox agent does it and returns its answer. Takes seconds to minutes, ' +
  'so use it only when the answer needs the computer.'

export function createSandboxRunTool(options: SandboxRunToolOptions): SandboxRunTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const shell = options.shell
  if (!options.runTask && !shell) throw new Error('createSandboxRunTool needs a shell or a runTask')
  const runTask = options.runTask ?? ((box: SandboxInstance, task: string, run: { signal: AbortSignal; timeoutMs: number }) =>
    runSandboxPrompt(shell!, box, task, { ...options.prompt, ...run, disallowQuestions: true }))
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
    async run(args) {
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (!task || task.length > TASK_LIMIT) {
        return fail('invalid_arguments', `task must be 1 to ${TASK_LIMIT} characters`)
      }
      const started = Date.now()
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])])
      if (options.warm) await options.warm.leases.turn(options.warm.key).catch(() => {})
      let box: SandboxInstance
      try {
        box = await options.box(signal)
      } catch (error) {
        if (error instanceof SandboxRunError) return fail(error.code, error.message, error.cause)
        return fail('sandbox_unavailable', 'The sandbox for this workspace could not start, so this work was not done.', error)
      }
      let answer: string
      try {
        // A product runner may not honour the signal; the call still ends at the cap.
        answer = await Promise.race([
          runTask(box, task, { signal, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)) }),
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason)
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
        ])
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
