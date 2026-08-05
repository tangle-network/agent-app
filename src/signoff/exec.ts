import { spawn } from 'node:child_process'

/**
 * The subprocess primitive every sign-off step runs through.
 *
 * Three properties the gate depends on, none of which `execSync` gives:
 *
 * 1. **Cancellable.** Under fail-fast, a build still running when typecheck
 *    fails is killed rather than waited out — otherwise the "faster than CI"
 *    claim is spent waiting for work whose verdict no longer matters.
 * 2. **Process-group kill.** Steps run through `sh -c`, so killing the shell
 *    leaves `vitest`'s forks and `tsup`'s dts worker orphaned and holding CPU.
 *    The child is spawned as a group leader and the whole group is signalled.
 * 3. **Bounded, non-silent capture.** Output is capped, and when the cap is hit
 *    the elision is stated in the captured text. A gate that quietly drops the
 *    middle of a failure log is a gate that hides the failure.
 */

export interface CommandResult {
  readonly command: string
  readonly cwd: string
  readonly exitCode: number
  readonly signal: string | null
  readonly durationMs: number
  readonly output: string
  readonly truncated: boolean
  readonly timedOut: boolean
}

export interface RunCommandOptions {
  readonly command: string
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** Retained bytes before elision. Default 2 MiB. */
  readonly maxOutputBytes?: number
  /** Grace between SIGTERM and SIGKILL. Default 5 s. */
  readonly killGraceMs?: number
  readonly onData?: (chunk: string) => void
}

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_KILL_GRACE_MS = 5_000
/** Fraction of the budget kept from the head; the rest is the tail. The head
 *  carries the command echo and the first error, the tail carries the summary. */
const HEAD_SHARE = 0.25

/**
 * Ring-ish buffer that keeps a head window and a tail window, so both the first
 * error and the final summary survive a very long log.
 */
class BoundedOutput {
  private head = ''
  private tail = ''
  private total = 0
  private readonly headBudget: number
  private readonly tailBudget: number

  constructor(private readonly budget: number) {
    this.headBudget = Math.floor(budget * HEAD_SHARE)
    this.tailBudget = budget - this.headBudget
  }

  push(chunk: string): void {
    this.total += chunk.length
    if (this.head.length < this.headBudget) {
      const room = this.headBudget - this.head.length
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
      if (chunk.length === 0) return
    }
    this.tail = (this.tail + chunk).slice(-this.tailBudget)
  }

  get truncated(): boolean {
    return this.total > this.budget
  }

  text(): string {
    if (!this.truncated) return this.head + this.tail
    const elided = this.total - this.head.length - this.tail.length
    return `${this.head}\n\n[signoff] ${elided} bytes elided (output exceeded ${this.budget} bytes)\n\n${this.tail}`
  }
}

/** Signal a whole process group, tolerating the race where it already exited. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (err) {
    // ESRCH means the group is already gone, which is the outcome we wanted.
    // Anything else is a real failure to signal and must not be swallowed.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
  }
}

/**
 * Run one shell command to completion and report what happened.
 *
 * Never throws on a non-zero exit — a failing step is data, not an exception.
 * It throws only when the process could not be started at all.
 */
export function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const {
    command,
    cwd,
    env,
    timeoutMs,
    signal,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    onData,
  } = options

  return new Promise<CommandResult>((resolve, reject) => {
    const startedAt = Date.now()
    const buffer = new BoundedOutput(maxOutputBytes)
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined

    const child = spawn(command, {
      cwd,
      env: env as NodeJS.ProcessEnv | undefined,
      shell: true,
      // Group leader: lets one signal reach `sh` and everything it spawned.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const pid = child.pid
    const terminate = (): void => {
      if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
      killGroup(pid, 'SIGTERM')
      graceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killGroup(pid, 'SIGKILL')
      }, killGraceMs)
      graceTimer.unref()
    }

    const onAbort = (): void => terminate()
    signal?.addEventListener('abort', onAbort, { once: true })

    if (timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        timedOut = true
        terminate()
      }, timeoutMs)
      killTimer.unref()
    }

    const collect = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      buffer.push(text)
      onData?.(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer)
      if (graceTimer) clearTimeout(graceTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (err) => {
      cleanup()
      reject(new Error(`signoff: could not start \`${command}\` in ${cwd}: ${err.message}`))
    })

    child.on('close', (code, sig) => {
      cleanup()
      resolve({
        command,
        cwd,
        // A signalled process reports code `null`; 128+n is the shell's own
        // convention and keeps the field a number a caller can compare.
        exitCode: code ?? (sig === 'SIGKILL' ? 137 : 143),
        signal: sig,
        durationMs: Date.now() - startedAt,
        output: buffer.text(),
        truncated: buffer.truncated,
        timedOut,
      })
    })
  })
}
