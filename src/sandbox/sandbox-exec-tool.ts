/**
 * `createSandboxExecTool`: the `sandbox_exec` tool a Router turn calls to run
 * one command in the product's box — a toolkit script, a converter, a check —
 * and read its exit code and output. Unlike `sandbox_run` it starts no box
 * agent: the Router model stays in charge and the box only executes.
 *
 * WHY. Tax's Router default lost its Python form toolkit because the lane had
 * no way to reach a box: 685 tool calls, 0 form fills (2026-10). A toolkit
 * the product mounts in the box is reachable from the Router lane only
 * through a command tool.
 *
 * NEVER SILENT. A box that cannot start or be prepared, and a command that
 * cannot run or outruns its cap, come back as a typed `SandboxRunError`
 * (`sandbox_unavailable`, `sandbox_failed`) the model must report. A command
 * that runs and exits non-zero is a result, not a failure: the model reads
 * its exit code and stderr and can correct itself.
 *
 * `prepare` runs once per tool, before the first command (install a runtime,
 * copy the session's documents in). `allow` is the product's command policy.
 */
import type { SandboxInstance } from '@tangle-network/sandbox'
import { SandboxRunError, type SandboxToolContext } from './sandbox-run-tool'

export interface SandboxExecToolOptions {
  /** The box commands run in. The product provisions, binds and bills it. A throw is
   *  `sandbox_unavailable`, unless it is a `SandboxRunError`, which is kept as it is. */
  box(signal: AbortSignal): Promise<SandboxInstance>
  /** Once per tool, before the first command: install a runtime, sync files in. */
  prepare?(box: SandboxInstance, signal: AbortSignal): Promise<void>
  /** Default working directory. */
  cwd?: string
  env?: Record<string, string>
  /** Cap for one command, box start and prepare included. Default 2 minutes. */
  timeoutMs?: number
  /** Characters of stdout and of stderr returned to the model, each; the tail is kept. Default 4 000, so
   *  one result stays inside `runRouterTurn`'s default 12 000-character tool-result limit, which keeps the
   *  head and would otherwise cut the tail, where errors are. Raise both together. */
  maxOutputChars?: number
  /** The product's command policy: a string refuses the command with that reason. */
  allow?(command: string): string | null
  /** After each command, the files the product wants the model to know about (e.g. its output folder). */
  listFiles?(box: SandboxInstance, signal: AbortSignal): Promise<string[]>
  signal?: AbortSignal
  /** The box's warm lease, so a call is recorded as a turn on it. */
  warm?: { leases: { turn(key: string): Promise<unknown> }; key: string }
  onFailure?(error: SandboxRunError): void
  name?: string
  description?: string
}

export interface SandboxExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when stdout or stderr was cut to `maxOutputChars`. */
  truncated: boolean
  ms: number
  files?: string[]
}

export interface SandboxExecTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, context?: SandboxToolContext): Promise<SandboxExecResult>
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000
const DEFAULT_OUTPUT_CHARS = 4_000
const COMMAND_LIMIT = 10_000

export const SANDBOX_EXEC_DESCRIPTION =
  "Run one shell command in this workspace's sandbox and get its exit code, stdout and stderr. Use it for the " +
  'installed toolkits and scripts, file conversion and checks. A non-zero exit code is a result to read and fix, ' +
  'not a reason to stop.'

function tail(text: string, limit: number): { text: string; cut: boolean } {
  return text.length > limit ? { text: `…${text.slice(-limit)}`, cut: true } : { text, cut: false }
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })])
}

export function createSandboxExecTool(options: SandboxExecToolOptions): SandboxExecTool {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const outputChars = options.maxOutputChars ?? DEFAULT_OUTPUT_CHARS
  const fail = (code: 'sandbox_unavailable' | 'sandbox_failed' | 'invalid_arguments', message: string, cause?: unknown): never => {
    const error = new SandboxRunError(code, message, cause === undefined ? undefined : { cause })
    options.onFailure?.(error)
    throw error
  }
  let ready: Promise<SandboxInstance> | null = null
  const place = (signal: AbortSignal) => {
    ready ??= (async () => {
      let box: SandboxInstance
      try {
        box = await options.box(signal)
      } catch (error) {
        if (error instanceof SandboxRunError) throw error
        throw new SandboxRunError('sandbox_unavailable', 'The sandbox for this workspace could not start, so the command did not run.', { cause: error })
      }
      try {
        await options.prepare?.(box, signal)
      } catch (error) {
        throw new SandboxRunError('sandbox_unavailable', 'The sandbox could not be prepared for commands, so the command did not run.', { cause: error })
      }
      return box
    })()
    // A failed start is not cached: the next call tries again.
    ready.catch(() => { ready = null })
    return ready
  }
  return {
    name: options.name ?? 'sandbox_exec',
    description: options.description ?? SANDBOX_EXEC_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'One shell command, e.g. `tax-python fill_form.py --form 1040`.' },
        cwd: { type: 'string', description: 'Working directory; defaults to the workspace directory.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(args, context) {
      const emit = (kind: string, data?: unknown) => { try { context?.emit(kind, data) } catch { /* a view never fails the call */ } }
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (!command || command.length > COMMAND_LIMIT) return fail('invalid_arguments', `command must be 1 to ${COMMAND_LIMIT} characters`)
      const refusal = options.allow?.(command)
      if (refusal) return fail('invalid_arguments', refusal)
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : options.cwd
      const started = Date.now()
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])])
      if (options.warm) await options.warm.leases.turn(options.warm.key).catch(() => {})
      let box: SandboxInstance
      const starting = place(signal)
      try {
        box = await raceAbort(starting, signal)
      } catch (error) {
        // A start that outlived this call's cap may never settle; the next call starts again.
        if (ready === starting) ready = null
        if (error instanceof SandboxRunError) {
          options.onFailure?.(error)
          throw error
        }
        return fail('sandbox_unavailable', 'The sandbox did not start in time, so the command did not run.', error)
      }
      emit('box_ready', { ms: Date.now() - started })
      let result: { exitCode: number; stdout: string; stderr: string }
      try {
        result = await raceAbort(box.exec(command, {
          ...(cwd ? { cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
          timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)),
        }), signal)
      } catch (error) {
        const timedOut = signal.aborted && !options.signal?.aborted
        return fail('sandbox_failed', timedOut
          ? `The command did not finish within ${Math.round(timeoutMs / 1000)} s.`
          : 'The command could not run in the sandbox.', error)
      }
      const stdout = tail(result.stdout ?? '', outputChars)
      const stderr = tail(result.stderr ?? '', outputChars)
      const files = options.listFiles ? await options.listFiles(box, signal).catch(() => undefined) : undefined
      return { exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text, truncated: stdout.cut || stderr.cut,
        ms: Date.now() - started, ...(files ? { files } : {}) }
    },
  }
}
