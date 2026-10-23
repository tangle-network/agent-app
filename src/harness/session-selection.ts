/** Pure session admission. Harness identity is not deployment availability. */
export interface SelectionAvailability<H extends string> {
  /** Server-owned selection for new sessions. An empty list disables all starts. */
  readonly newSessions: readonly H[]
  /** Includes draining harnesses. Omission uses newSessions, never all known IDs. */
  readonly existingSessions?: readonly H[]
}

export interface SessionHarnessSelectionInput<H extends string> {
  sessionHarness?: unknown
  requested?: unknown
  workspaceDefault?: unknown
  fallback?: H
  /** Omit only when the caller deliberately admits every known harness. */
  availability?: SelectionAvailability<H>
}

export interface SessionHarnessSelection<H extends string> {
  harness: H
  locked: boolean
  swapAttempted: boolean
}

type SelectionSource = 'session' | 'requested' | 'workspace' | 'fallback'

/** An admission failure, never permission to retry on another harness. */
export class HarnessSelectionError extends Error {
  readonly code: 'harness_unknown' | 'harness_unavailable'
  readonly harness: string | null
  readonly source: SelectionSource

  constructor(
    code: 'harness_unknown' | 'harness_unavailable',
    value: unknown,
    source: SelectionSource,
  ) {
    const harness = typeof value === 'string' ? value : null
    super(`${code}: ${source} harness ${harness === null ? '<invalid>' : JSON.stringify(harness)}`)
    this.name = 'HarnessSelectionError'
    this.code = code
    this.harness = harness
    this.source = source
  }
}

/**
 * Null/undefined mean no choice. Every other value is an explicit choice and must
 * validate. A retired or unrecognized saved identity must never become a new session.
 * Availability is supplied by the authenticated server, not by a request body.
 */
export function selectSessionHarness<H extends string>(
  input: SessionHarnessSelectionInput<H>,
  knownHarnesses: readonly H[],
  defaultHarness: H,
): SessionHarnessSelection<H> {
  const known = new Set<string>(knownHarnesses)
  const resolve = (value: unknown, source: SelectionSource): H => {
    if (typeof value !== 'string' || !known.has(value)) {
      throw new HarnessSelectionError('harness_unknown', value, source)
    }
    return value as H
  }
  const admit = (harness: H, source: SelectionSource, existing: boolean): void => {
    if (input.availability === undefined) return
    const allowed = existing
      ? input.availability.existingSessions ?? input.availability.newSessions
      : input.availability.newSessions
    if (!allowed.includes(harness)) {
      throw new HarnessSelectionError('harness_unavailable', harness, source)
    }
  }

  if (input.sessionHarness !== undefined && input.sessionHarness !== null) {
    const harness = resolve(input.sessionHarness, 'session')
    admit(harness, 'session', true)
    // A known different request remains a swap attempt; it is not executed. An
    // invalid request is refused rather than being misreported as no swap.
    const requested = input.requested === undefined || input.requested === null
      ? undefined : resolve(input.requested, 'requested')
    return { harness, locked: true, swapAttempted: requested !== undefined && requested !== harness }
  }

  const source: SelectionSource = input.requested !== undefined && input.requested !== null
    ? 'requested'
    : input.workspaceDefault !== undefined && input.workspaceDefault !== null
      ? 'workspace' : 'fallback'
  const value = source === 'requested' ? input.requested
    : source === 'workspace' ? input.workspaceDefault : input.fallback ?? defaultHarness
  const harness = resolve(value, source)
  admit(harness, source, false)
  return { harness, locked: false, swapAttempted: false }
}
