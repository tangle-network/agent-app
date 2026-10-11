/**
 * Prewarm on open: when a member opens a workspace page, ask the product to
 * warm that workspace (resume its box, prepare its profile) so the first turn
 * does not pay for it. The server half is `createWorkspacePrewarmRoute` in
 * `/sandbox`.
 *
 * Fires only from a visible, non-prerendered document. A tab opened in the
 * background fires when it first becomes visible. Requests for the same URL
 * are spaced by `minIntervalMs` across every mount in the tab, so navigating
 * between pages of one workspace sends one request, not one per page. Call
 * `reassert()` on composer focus: a box can suspend while a tab sits open.
 *
 * Failures are silent by design. A warm is an optimization; the turn itself
 * still places the box, so nothing here may surface to the member.
 */

import { useCallback, useEffect } from 'react'

export interface WorkspacePrewarmRequestOptions {
  /** Minimum gap between requests for the same URL in this tab. Default 60 000 ms. */
  minIntervalMs?: number
}

export interface UseWorkspacePrewarmOptions extends WorkspacePrewarmRequestOptions {
  /** The product's prewarm route for this workspace. Empty disables. */
  url: string | null | undefined
  /** False until the member is known to be signed in and allowed to chat. Default true. */
  enabled?: boolean
}

export interface WorkspacePrewarmHandle {
  /** Ask again, subject to the same visibility and spacing rules. */
  reassert(): void
}

const DEFAULT_MIN_INTERVAL_MS = 60_000
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
  if (!url || !documentIsVisible() || inFlight.has(url)) return false
  const now = Date.now()
  const last = lastSent.get(url)
  if (last !== undefined && now - last < (options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return false
  lastSent.set(url, now)
  inFlight.add(url)
  void fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
    .finally(() => inFlight.delete(url))
  return true
}

/** Prewarm `url` when the page opens or becomes visible; `reassert` on composer focus. */
export function useWorkspacePrewarm(options: UseWorkspacePrewarmOptions): WorkspacePrewarmHandle {
  const { url, enabled = true, minIntervalMs } = options
  const active = enabled && Boolean(url)

  useEffect(() => {
    if (!active || !url || typeof document === 'undefined') return
    const fire = () => {
      requestWorkspacePrewarm(url, { minIntervalMs })
    }
    fire()
    document.addEventListener('visibilitychange', fire)
    return () => document.removeEventListener('visibilitychange', fire)
  }, [active, url, minIntervalMs])

  const reassert = useCallback(() => {
    if (active && url) requestWorkspacePrewarm(url, { minIntervalMs })
  }, [active, url, minIntervalMs])

  return { reassert }
}
