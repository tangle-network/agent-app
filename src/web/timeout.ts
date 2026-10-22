/**
 * Race an async operation against a timeout. The operation receives an
 * AbortSignal that fires when the timeout elapses, so a hung request is
 * aborted and rejected with `message` instead of hanging forever. The timer is
 * cleared the moment the operation settles, so wrapping a streaming `fetch`
 * (which resolves at response headers) guards only the connect/first-byte
 * phase and never truncates a long-lived response body. Browser-safe.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true
      controller.abort(message)
      reject(new Error(message))
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise])
  } catch (err) {
    // A timeout must always surface as `message`; the merged fetch signal can
    // reject with a bare AbortError before the timeout promise rejects.
    if (timedOut || controller.signal.aborted) throw new Error(message)
    throw err
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
