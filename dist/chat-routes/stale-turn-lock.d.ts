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
 * 1. The session probe answered and the execution is TERMINAL ⇒ release, once
 *    the lock is past a short grace period. The authority on "is this turn
 *    still running" is whatever is actually running it; a terminal verdict is
 *    proof the lock outlived its turn — but only if the verdict is about THIS
 *    turn, which is what the grace buys (see
 *    {@link DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS}).
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
export type StaleTurnLockSandboxProbeResult = {
    status: 'running';
} | {
    status: 'absent';
} | {
    status: 'not-running';
    state?: string;
};
/** What the thing running the turn says about it. `terminal: false` means an
 *  execution is LIVE — the strongest signal in the policy. `diagnostics` rides
 *  through to the result and the logs unread. */
export type StaleTurnLockSessionProbeResult = {
    reachable: true;
    terminal: boolean;
    diagnostics?: Record<string, unknown>;
} | {
    reachable: false;
    reason?: string;
};
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
export declare const DEFAULT_STALE_TURN_LOCK_GRACE_MS: number;
/**
 * Minimum age a lock must reach before a TERMINAL session verdict may release
 * it.
 *
 * The session probe is keyed on the THREAD, not on the execution the lock
 * holds: a sidecar that has nothing running reports `terminal` with
 * `activeExecutionId: null`, so there is no id to match the lock against. The
 * lock, meanwhile, is acquired BEFORE the box is ensured and before the
 * execution registers with the sidecar. Between those two moments a second
 * request that reconciles the lock asks the sidecar about a turn it has not
 * heard of yet and gets back the PREVIOUS turn's terminal state — proof about
 * the wrong execution. Releasing on that verdict hands the second request a
 * lock the first one is still using, which is two concurrent turns on a scope
 * whose single-flight guard just voted for itself.
 *
 * One minute covers the acquire → box-ensure → sidecar-registration window on
 * a warm box (the cold-box case is Rule 3's, and has its own, much longer
 * grace). Deliberately NOT
 * {@link DEFAULT_STALE_TURN_LOCK_GRACE_MS}: this branch has a positive
 * observation behind it, so it should recover fast, and stretching it to five
 * minutes would leave a genuinely dead turn wedged for the whole window that
 * the session probe exists to shortcut. Raising it delays recovery from a
 * crashed turn; lowering it narrows the registration window it protects.
 */
export declare const DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS: number;
/** Resolve options for probing and releasing stale TURN locks based on lock start time and sandbox state */
export interface ReconcileStaleTurnLockOptions {
    /** When the held lock was acquired (epoch ms). The grace period is measured
     *  from here, so it must be the LOCK's start, not the turn's. */
    lockStartedAt: number;
    /** Is the box there and running? Never provisions — a peek, not an ensure.
     *  A throw is treated as unreachable, same as `absent`. */
    probeSandbox(): Promise<StaleTurnLockSandboxProbeResult>;
    /** Ask the running box whether the execution is still live. Only called when
     *  `probeSandbox` reported `running`. A throw is treated as unreachable. */
    probeSession(): Promise<StaleTurnLockSessionProbeResult>;
    /** Release the lock, fenced by the instant the releasing evidence was
     *  observed. `fence.observedAt` is snapshotted BEFORE the probe that
     *  justified the release, so a store that can compare it against the held
     *  lock's start refuses to delete a SUCCESSOR lock acquired while the probe
     *  was in flight. A store that cannot make that comparison may ignore the
     *  fence, but must not substitute its own `Date.now()` — that timestamp is
     *  by construction newer than any successor and makes the check vacuous.
     *
     *  Returns whether the release actually landed — `false` when the lock was
     *  already gone (someone else got there first), which is reported, never
     *  treated as a release. */
    release(fence: {
        observedAt: number;
    }): boolean | Promise<boolean>;
    /** Override {@link DEFAULT_STALE_TURN_LOCK_GRACE_MS} (Rule 3's fallback). */
    graceMs?: number;
    /** Override {@link DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS} (Rule 1's release). */
    terminalGraceMs?: number;
    /** Identity fields merged into every log line (workspace, thread, execution
     *  id — whatever makes the entry findable in the product's logs). */
    context?: Record<string, unknown>;
    /** Defaults to `console.warn`. Both the withheld and the force-released
     *  branches log; a force-release is never silent. */
    log?(message: string, meta: Record<string, unknown>): void;
    /** Injectable clock, for tests. */
    now?(): number;
}
/** Describe the outcome of reconciling a stale turn lock including release status and diagnostics */
export interface ReconcileStaleTurnLockResult {
    released: boolean;
    /** Why the policy decided what it did — the probe's own diagnostics on the
     *  reachable path, the unreachable reason and lock age on the fallback. */
    diagnostics: Record<string, unknown>;
}
/**
 * Decide whether a held lock is stale and, if so, release it.
 *
 * Never provisions and never mutates anything but the lock: a reconciliation
 * attempt on a cold workspace leaves it cold.
 */
export declare function reconcileStaleTurnLock(options: ReconcileStaleTurnLockOptions): Promise<ReconcileStaleTurnLockResult>;
