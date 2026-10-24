/** Settle a caller's read/wait promptly. The operation must forward the signal
 * to its transport; this wrapper alone never proves remote absence. Do not use
 * it to abandon a lease acquisition or a lifecycle ownership transition. */
export function awaitSandboxRead<T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return operation()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) }).then(
      value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) },
    )
  })
}

/** Cancel a polling delay without leaving a default timer or listener. */
export function waitForSandboxPoll(ms: number, signal?: AbortSignal, wait?: (ms: number) => Promise<void>): Promise<void> {
  signal?.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const aborted = () => finish(signal!.reason)
    signal?.addEventListener('abort', aborted, { once: true })
    if (wait) Promise.resolve().then(() => { signal?.throwIfAborted(); return wait(ms) }).then(() => finish(), finish)
    else timer = setTimeout(() => finish(), ms)
  })
}
