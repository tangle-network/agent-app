/**
 * Send a Platform request through a busy writer. Platform answers 503 `PLATFORM_BUSY` with `Retry-After` when its
 * one SQLite writer is backed up past about 1 s (agent-container #19577, #19603, #19614): a service key write such as
 * `POST /v1/keys/delegate` is refused before it queues, and a write that met a locked writer is rolled back. That
 * answer carries no verdict, so the same request is sent again after Retry-After × (1 + U[0, 1)), spread so a shed
 * burst does not come back in lockstep, while the deadline leaves the next attempt room. Any other answer, or a fetch
 * that throws, is returned at once. The Sandbox Worker's Platform client waits the same way inside its 8 s delegation
 * budget (agent-container `products/sandbox/api/src/lib/platform-client-errors.ts`).
 */

/** Longest one Platform call waits out a busy writer, from its first attempt. */
const PLATFORM_BUSY_BUDGET_MS = 8_000
/** Longest one attempt waits for Platform; an attempt after a busy answer also ends at the deadline. */
const PLATFORM_REQUEST_TIMEOUT_MS = 10_000
/** Least time a further attempt needs to be worth sending. */
const MIN_ATTEMPT_MS = 250

/** A caller's own end for the wait, when it comes before the 8 s budget, and a signal that stops it early. */
export interface PlatformBusyWait { deadline?: number; signal?: AbortSignal }

/** Wait `ms`, or less when `signal` aborts first; answers whether the wait ran its course. */
export async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal?.aborted) await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
  return !signal?.aborted
}

/** The wait a busy answer asks for, jittered, or null when the answer is not busy. */
async function busyWaitMs(response: Response): Promise<number | null> {
  if (response.status !== 503) return null
  const body = await response.clone().json().catch(() => null) as { error?: { code?: unknown } } | null
  if (body?.error?.code !== 'PLATFORM_BUSY') return null
  // Retry-After is whole seconds; a missing, past or unreadable one means Platform's usual 1 s.
  return Math.max(1, Number(response.headers.get('retry-after')) || 0) * 1_000 * (1 + Math.random())
}

export async function sendThroughPlatformBusy(send: (signal: AbortSignal) => Promise<Response>, wait: PlatformBusyWait = {}): Promise<Response> {
  const deadline = Math.min(Date.now() + PLATFORM_BUSY_BUDGET_MS, wait.deadline ?? Number.POSITIVE_INFINITY)
  let response = await send(AbortSignal.timeout(PLATFORM_REQUEST_TIMEOUT_MS))
  for (;;) {
    const delay = await busyWaitMs(response)
    if (delay === null || Date.now() + delay + MIN_ATTEMPT_MS > deadline) return response
    if (!(await sleepUnlessAborted(delay, wait.signal))) return response
    await response.body?.cancel().catch(() => {})
    response = await send(AbortSignal.timeout(Math.min(PLATFORM_REQUEST_TIMEOUT_MS, deadline - Date.now())))
  }
}
