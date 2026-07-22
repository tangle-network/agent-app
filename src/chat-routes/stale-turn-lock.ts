/**
 * Recovery policy for a `ChatTurnLock` whose holder died.
 *
 * `createChatTurnRoutes` takes the lock as a seam (`acquire`/`release`) and a
 * lock is a single-flight guard: while it is held, a second turn on the same
 * scope is refused. Products give it a TTL measured in tens of minutes, so a
 * turn that dies without releasing wedges chat for that whole window. Every
 * app on the seam inherits that wedge, which is why the way OUT of it is
 * policy this package owns rather than something each app rediscovers.
 *
 * The policy takes PROBES, not clients: it imports no sandbox SDK, opens no
 * connection, and knows nothing about how a product finds its box or talks to
 * a sidecar. That is what makes the rules testable and what keeps the concrete
 * probes — which box key, which session id, which sidecar endpoint — in the
 * product.
 *
 * The rules, in precedence order:
 *
 * 1. The session probe answered and the execution is TERMINAL ⇒ release. The
 *    authority on "is this turn still running" is whatever is actually running
 *    it; a terminal verdict is proof the lock outlived its turn.
 * 2. The session probe answered and the execution is LIVE ⇒ hold, always.
 *    Nothing below may override this. The lock is doing exactly its job.
 * 3. The probes could not reach that authority at all — the sandbox could not
 *    be listed, is gone, is not running, or its session probe failed ⇒ fall
 *    back on the physical argument: an execution runs INSIDE the box, so a box
 *    that is not there is running nothing, and the lock is releasable. Without
 *    this fallback the recovery would depend on the very subsystem whose
 *    failure produced the stale lock.
 *
 * Rule 3 is gated on a grace period because it is an inference, not an
 * observation — see {@link DEFAULT_STALE_TURN_LOCK_GRACE_MS}.
 */

/** Where the box is, as far as the caller can see. `state` on `not-running`
 *  is the platform's own status string, carried through for the log. */
export type StaleTurnLockSandboxProbeResult =
  | { status: 'running' }
  | { status: 'absent' }
  | { status: 'not-running'; state?: string }

/** What the thing running the turn says about it. `terminal: false` means an
 *  execution is LIVE — the strongest signal in the policy. `diagnostics` rides
 *  through to the result and the logs unread. */
export type StaleTurnLockSessionProbeResult =
  | { reachable: true; terminal: boolean; diagnostics?: Record<string, unknown> }
  | { reachable: false; reason?: string }

/**
 * Minimum age a lock must reach before the "sandbox unreachable ⇒ nothing can
 * be running" fallback may force-release it.
 *
 * The lock is acquired BEFORE the box is ensured, so during a cold workspace's
 * first turn there is a real window in which the lock is held and no box exists
 * yet — indistinguishable, from a peek, from a box that vanished. The grace
 * period has to outlast that window (create + bootstrap + whatever the product
 * hydrates) or a concurrent request steals the lock from a turn that is merely
 * still provisioning. Five minutes clears observed cold starts with room to
 * spare while cutting the worst case from a TTL-length wedge down to five
 * minutes. Raising it makes recovery slower; lowering it risks stealing a lock
 * mid-provision.
 */
export const DEFAULT_STALE_TURN_LOCK_GRACE_MS = 5 * 60 * 1000

export interface ReconcileStaleTurnLockOptions {
  /** When the held lock was acquired (epoch ms). The grace period is measured
   *  from here, so it must be the LOCK's start, not the turn's. */
  lockStartedAt: number
  /** Is the box there and running? Never provisions — a peek, not an ensure.
   *  A throw is treated as unreachable, same as `absent`. */
  probeSandbox(): Promise<StaleTurnLockSandboxProbeResult>
  /** Ask the running box whether the execution is still live. Only called when
   *  `probeSandbox` reported `running`. A throw is treated as unreachable. */
  probeSession(): Promise<StaleTurnLockSessionProbeResult>
  /** Release the lock. Returns whether the release actually landed — `false`
   *  when the lock was already gone (someone else got there first), which is
   *  reported, never treated as a release. */
  release(): boolean | Promise<boolean>
  /** Override {@link DEFAULT_STALE_TURN_LOCK_GRACE_MS}. */
  graceMs?: number
  /** Identity fields merged into every log line (workspace, thread, execution
   *  id — whatever makes the entry findable in the product's logs). */
  context?: Record<string, unknown>
  /** Defaults to `console.warn`. Both the withheld and the force-released
   *  branches log; a force-release is never silent. */
  log?(message: string, meta: Record<string, unknown>): void
  /** Injectable clock, for tests. */
  now?(): number
}

export interface ReconcileStaleTurnLockResult {
  released: boolean
  /** Why the policy decided what it did — the probe's own diagnostics on the
   *  reachable path, the unreachable reason and lock age on the fallback. */
  diagnostics: Record<string, unknown>
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Decide whether a held lock is stale and, if so, release it.
 *
 * Never provisions and never mutates anything but the lock: a reconciliation
 * attempt on a cold workspace leaves it cold.
 */
export async function reconcileStaleTurnLock(
  options: ReconcileStaleTurnLockOptions,
): Promise<ReconcileStaleTurnLockResult> {
  let sandbox: StaleTurnLockSandboxProbeResult
  try {
    sandbox = await options.probeSandbox()
  } catch (err) {
    return forceReleaseUnreachable(options, {
      unreachableReason: 'SANDBOX_PROBE_FAILED',
      unreachableDetail: messageOf(err),
    })
  }
  if (sandbox.status !== 'running') {
    return forceReleaseUnreachable(options, {
      unreachableReason: sandbox.status === 'absent' ? 'SANDBOX_ABSENT' : 'SANDBOX_NOT_RUNNING',
      ...(sandbox.status === 'not-running' && sandbox.state !== undefined
        ? { sandboxState: sandbox.state }
        : {}),
    })
  }

  // Snapshot the clock BEFORE the probe: the release is only valid against the
  // lock as it was when the state was observed, not after an arbitrarily slow
  // round trip.
  const observedAt = (options.now ?? Date.now)()
  let session: StaleTurnLockSessionProbeResult
  try {
    session = await options.probeSession()
  } catch (err) {
    return forceReleaseUnreachable(options, {
      unreachableReason: 'SESSION_PROBE_FAILED',
      unreachableDetail: messageOf(err),
    })
  }
  if (!session.reachable) {
    return forceReleaseUnreachable(options, {
      unreachableReason: 'SESSION_UNREACHABLE',
      ...(session.reason !== undefined ? { sessionProbeError: session.reason } : {}),
    })
  }

  const diagnostics: Record<string, unknown> = {
    sandboxReachable: true,
    sessionTerminal: session.terminal,
    ...(session.diagnostics ?? {}),
  }
  // The authority answered and says the execution is live: the lock is doing
  // its job. Nothing below this point may override that.
  if (!session.terminal) return { released: false, diagnostics }

  const released = await options.release()
  return { released, diagnostics: { ...diagnostics, released, observedAt } }
}

/**
 * The fallback: the session authority could not attest to the execution's
 * state because the box is gone, stopped, or unreachable. Release the lock
 * once it is old enough that it cannot belong to a turn still provisioning its
 * box — and say so either way, with the reason, the lock's age, and the grace
 * period it was measured against.
 */
async function forceReleaseUnreachable(
  options: ReconcileStaleTurnLockOptions,
  reason: Record<string, unknown> & { unreachableReason: string },
): Promise<ReconcileStaleTurnLockResult> {
  const log = options.log ?? ((message, meta) => console.warn(message, meta))
  const graceMs = options.graceMs ?? DEFAULT_STALE_TURN_LOCK_GRACE_MS
  const at = (options.now ?? Date.now)()
  const lockAgeMs = at - options.lockStartedAt
  const diagnostics: Record<string, unknown> = {
    ...reason,
    sandboxReachable: false,
    lockAgeMs,
    forceReleaseGraceMs: graceMs,
  }

  if (lockAgeMs < graceMs) {
    log('[chat-routes] stale turn lock held: sandbox unreachable but lock is inside the grace period', {
      ...(options.context ?? {}),
      ...diagnostics,
    })
    return { released: false, diagnostics: { ...diagnostics, forceReleaseWithheld: 'LOCK_WITHIN_GRACE_PERIOD' } }
  }

  const released = await options.release()
  log('[chat-routes] force-released stale turn lock: sandbox unreachable, no turn can be executing', {
    ...(options.context ?? {}),
    ...diagnostics,
    released,
  })
  return { released, diagnostics: { ...diagnostics, forceReleased: released } }
}
