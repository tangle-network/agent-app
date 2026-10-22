/**
 * Prewarm on open: when a member opens a workspace page, ask the product to
 * warm that workspace (resume its box, prepare its profile) so the first turn
 * does not pay for it. The server half is `createWorkspacePrewarmRoute` in
 * `/sandbox`.
 *
 * Fires only from a visible, non-prerendered document. A tab opened in the
 * background fires when it first becomes visible. Requests for the same URL
 * and reason are spaced by `minIntervalMs` across every mount in the tab, so
 * navigating between pages of one workspace sends one request, not one per
 * page. Call `reassert()` on composer focus: a box can suspend while a tab sits
 * open, and focus warms the thread itself. While the tab stays visible it sends
 * a `heartbeat` every `heartbeatMs`, so what is warm stays warm; the route's
 * receipts make a heartbeat over warm state cost one read.
 *
 * Failures are silent by design. A warm is an optimization; the turn itself
 * still places the box, so nothing here may surface to the member.
 */

import { createContext, useCallback, useContext, useEffect } from 'react'

export interface WorkspacePrewarmRequestOptions {
  /** Minimum gap between requests for the same URL in this tab. Default 60 000 ms. */
  minIntervalMs?: number
  /** Sent to the route so a product can budget page opens apart from composer focus. Default `page-open`. */
  reason?: 'page-open' | 'composer-focus' | 'heartbeat'
  /** The thread the composer belongs to, so composer focus can warm that thread. */
  threadId?: string
}

export interface UseWorkspacePrewarmOptions extends WorkspacePrewarmRequestOptions {
  /** The product's prewarm route for this workspace. Empty disables. */
  url: string | null | undefined
  /** False until the member is known to be signed in and allowed to chat. Default true. */
  enabled?: boolean
  /** Re-warm this often while the tab is visible. Default 240 000 ms; 0 disables. */
  heartbeatMs?: number
}

export interface WorkspacePrewarmHandle {
  /** Ask again, subject to the same visibility and spacing rules. */
  reassert(): void
}

const DEFAULT_MIN_INTERVAL_MS = 60_000
const DEFAULT_HEARTBEAT_MS = 240_000
const lastSent = new Map<string, number>()
const inFlight = new Set<string>()

function documentIsVisible(): boolean {
  if (typeof document === 'undefined') return false
  if ((document as Document & { prerendering?: boolean }).prerendering) return false
  return document.visibilityState === 'visible'
}

/**
 * Send one prewarm request for `url` unless the tab is hidden, a request for it
 * is in flight, or one was sent within `minIntervalMs`. Returns whether it sent.
 */
export function requestWorkspacePrewarm(url: string, options: WorkspacePrewarmRequestOptions = {}): boolean {
  const reason = options.reason ?? 'page-open'
  // Page open, composer focus and heartbeat warm different things, so each is spaced on its own.
  const slot = `${reason} ${options.threadId ?? ''} ${url}`
  if (!url || !documentIsVisible() || inFlight.has(slot)) return false
  const now = Date.now()
  const last = lastSent.get(slot)
  if (last !== undefined && now - last < (options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return false
  lastSent.set(slot, now)
  inFlight.add(slot)
  void fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason, ...(options.threadId ? { threadId: options.threadId } : {}) }),
  })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
    .finally(() => inFlight.delete(slot))
  return true
}

/** Prewarm `url` when the page opens or becomes visible; `reassert` on composer focus. */
export function useWorkspacePrewarm(options: UseWorkspacePrewarmOptions): WorkspacePrewarmHandle {
  const { url, enabled = true, minIntervalMs, threadId } = options
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const active = enabled && Boolean(url)

  useEffect(() => {
    if (!active || !url || typeof document === 'undefined') return
    const fire = () => {
      requestWorkspacePrewarm(url, { minIntervalMs })
    }
    fire()
    document.addEventListener('visibilitychange', fire)
    // A hidden tab skips its beats (requestWorkspacePrewarm checks visibility); the member's return fires page-open.
    const beat = heartbeatMs > 0
      ? setInterval(() => requestWorkspacePrewarm(url, { minIntervalMs: heartbeatMs / 2, reason: 'heartbeat' }), heartbeatMs)
      : undefined
    return () => {
      document.removeEventListener('visibilitychange', fire)
      if (beat) clearInterval(beat)
    }
  }, [active, url, minIntervalMs, heartbeatMs])

  const reassert = useCallback(() => {
    if (active && url) requestWorkspacePrewarm(url, { minIntervalMs, reason: 'composer-focus', ...(threadId ? { threadId } : {}) })
  }, [active, url, minIntervalMs, threadId])

  return { reassert }
}

/**
 * The prewarm handle of the workspace shell around this component. `AgentWorkspaceLayout` provides it when the
 * product passes `prewarm`; `ChatComposer` reasserts through it on focus unless the product passes its own
 * `onFocusWithin`. Outside a shell that warms, `reassert` does nothing.
 */
export const WorkspacePrewarmContext = createContext<WorkspacePrewarmHandle | null>(null)

export function useWorkspacePrewarmHandle(): WorkspacePrewarmHandle | null {
  return useContext(WorkspacePrewarmContext)
}
