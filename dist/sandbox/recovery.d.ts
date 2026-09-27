/**
 * What an app does after the platform hands back a sandbox it cannot use.
 *
 * `replaceUnbringableBox` (see `./index`) decides whether to abandon a dead box.
 * This decides everything around that: which box key the next attempt uses,
 * whether the old box's snapshot is safe to restore from, whether an owner has
 * to confirm the loss first, and what the person waiting is told. It is
 * bookkeeping, not I/O — the app supplies storage through
 * {@link WorkspaceSandboxRecoveryStore}.
 *
 * ── Why the tables ──────────────────────────────────────────────────────────
 * Every fact about an action or a code lives in ACTIONS/CODES below, and the
 * types are DERIVED from those tables. That is deliberate, and it is the whole
 * reliability argument for this module.
 *
 * The hand-maintained alternative — a union type plus a separate `x === 'a' ||
 * x === 'b' || …` list per question — silently drops anything not on the list.
 * A recovery recorded under an unlisted action is written to storage, read
 * back, discarded as malformed, and the workspace re-provisions the box it just
 * abandoned. Nothing throws. The fix looks correct, ships, and does nothing.
 * That failure was hit twice inside one change before this module existed.
 *
 * With the tables, adding an action or code is a compile error until every
 * question about it is answered. There is no list to forget.
 */
/** The box exists and still holds unsnapshotted state, so discarding it is an
 *  owner's decision, not the runtime's. */
export declare const EGRESS_PROXY_RECOVERY_REQUIRED = "EGRESS_PROXY_RECOVERY_REQUIRED";
export declare const EGRESS_PROXY_RECOVERY_PHASE = "egress_proxy_recovery";
/** The platform no longer has the box. Nothing to confirm, delete, or restore. */
export declare const WORKSPACE_SANDBOX_MISSING = "WORKSPACE_SANDBOX_MISSING";
/** The box exists but its host has no free slot, so it can never be resumed
 *  where it is. A replacement can be placed on a host with room. */
export declare const WORKSPACE_SANDBOX_HOST_EXHAUSTED = "WORKSPACE_SANDBOX_HOST_EXHAUSTED";
/** The platform ran its own recovery, failed, and asked for a replacement.
 *  Covers every way a box ends up unbringable with no more specific cause. */
export declare const WORKSPACE_SANDBOX_UNRECOVERABLE = "WORKSPACE_SANDBOX_UNRECOVERABLE";
export declare const WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS: number;
/**
 * Every recovery cause, and the one thing the runtime must know about each:
 * whether the box it names can still be read from.
 *
 * `snapshotUsable: false` is not a preference. A snapshot is addressed by the
 * sandbox it was taken from, so when that sandbox cannot be started the restore
 * fails exactly the way the resume did — and an app that tried it would turn a
 * recoverable workspace into a stuck one.
 */
declare const CODES: {
    readonly EGRESS_PROXY_RECOVERY_REQUIRED: {
        readonly snapshotUsable: true;
    };
    readonly WORKSPACE_SANDBOX_MISSING: {
        readonly snapshotUsable: false;
    };
    readonly WORKSPACE_SANDBOX_HOST_EXHAUSTED: {
        readonly snapshotUsable: false;
    };
    readonly WORKSPACE_SANDBOX_UNRECOVERABLE: {
        readonly snapshotUsable: false;
    };
};
export type WorkspaceSandboxRecoveryCode = keyof typeof CODES;
/**
 * Every recovery action, and whether it means a replacement box has been
 * CHOSEN — the single question that decides which box key the next provisioning
 * attempt uses.
 *
 * `replacementChosen: false` covers the states where a key may be recorded but
 * must not be used yet: an owner has been asked and has not answered, or has
 * answered no. Handing back a key in those states replaces a box the owner
 * declined to lose.
 */
declare const ACTIONS: {
    readonly confirmation_required: {
        readonly replacementChosen: false;
    };
    readonly deletion_declined: {
        readonly replacementChosen: false;
    };
    readonly replacement_authorized: {
        readonly replacementChosen: false;
    };
    readonly snapshot_replacement_authorized: {
        readonly replacementChosen: false;
    };
    readonly replacement_started: {
        readonly replacementChosen: true;
    };
    readonly replacement_completed: {
        readonly replacementChosen: true;
    };
    readonly snapshot_replacement_started: {
        readonly replacementChosen: true;
    };
    readonly snapshot_restore_failed: {
        readonly replacementChosen: true;
    };
    readonly snapshot_replacement_completed: {
        readonly replacementChosen: true;
    };
    readonly missing_replacement_started: {
        readonly replacementChosen: true;
    };
    readonly missing_replacement_completed: {
        readonly replacementChosen: true;
    };
    readonly unrecoverable_replacement_started: {
        readonly replacementChosen: true;
    };
    readonly unrecoverable_replacement_completed: {
        readonly replacementChosen: true;
    };
};
export type WorkspaceSandboxRecoveryAction = keyof typeof ACTIONS;
export type WorkspaceSandboxSnapshotAvailability = 'available' | 'missing' | 'stale';
export type WorkspaceSandboxSnapshotFreshness = 'fresh' | 'stale' | 'unknown';
/** A snapshot the app took of a box, addressed by the box it came from. */
export interface WorkspaceSandboxSnapshot {
    fromSandboxId: string;
    createdAt: string;
    [key: string]: unknown;
}
export interface WorkspaceSandboxSnapshotAssessment {
    availability: WorkspaceSandboxSnapshotAvailability;
    freshness: WorkspaceSandboxSnapshotFreshness;
    snapshot?: WorkspaceSandboxSnapshot;
}
export interface WorkspaceSandboxRecoveryState {
    code: WorkspaceSandboxRecoveryCode;
    sandboxId: string;
    detectedAt: string;
    snapshot: WorkspaceSandboxSnapshotAssessment;
    action: WorkspaceSandboxRecoveryAction;
    replacementBoxKey?: string;
    replacementSandboxId?: string;
    confirmedAt?: string;
}
export type WorkspaceSandboxRecoveryDecision = 'replace' | 'decline';
/** Raised when chat cannot continue until an owner decides about the box. */
export declare class WorkspaceSandboxRecoveryRequiredError extends Error {
    readonly code = "EGRESS_PROXY_RECOVERY_REQUIRED";
    readonly status = 409;
    readonly phase = "egress_proxy_recovery";
    readonly recovery: WorkspaceSandboxRecoveryState;
    constructor(recovery: WorkspaceSandboxRecoveryState, cause: Error);
}
export declare function isEgressProxyRecoveryRequiredError(error: unknown): boolean;
export declare function isWorkspaceSandboxSnapshotRestoreError(error: unknown): boolean;
/**
 * Judge a snapshot against the box being replaced.
 *
 * Fresh means BOTH that it came from this exact sandbox and that it is inside
 * the age bound — a snapshot from a different box restores someone else's
 * filesystem, which is worse than starting empty.
 */
export declare function assessWorkspaceSandboxSnapshot(snapshot: WorkspaceSandboxSnapshot | undefined, sandboxId: string, now?: number): WorkspaceSandboxSnapshotAssessment;
export declare function isWorkspaceSandboxRecoveryAction(value: unknown): value is WorkspaceSandboxRecoveryAction;
export declare function isWorkspaceSandboxRecoveryCode(value: unknown): value is WorkspaceSandboxRecoveryCode;
export declare function isWorkspaceSandboxRecoveryState(value: unknown): value is WorkspaceSandboxRecoveryState;
export declare function workspaceSandboxRecoveryFromError(error: unknown): WorkspaceSandboxRecoveryState | undefined;
/** What to tell the person waiting. Never names the product, so an app can
 *  surface it verbatim. */
export declare function workspaceSandboxRecoveryMessage(recovery: WorkspaceSandboxRecoveryState): string;
export declare function workspaceSandboxRecoveryRecommendedActions(recovery: WorkspaceSandboxRecoveryState): string[];
/** Flat key/value shape for a log line — no nesting, no secrets. */
export declare function workspaceSandboxRecoveryDiagnostic(recovery: WorkspaceSandboxRecoveryState): Record<string, string | undefined>;
/**
 * The box key the next provisioning attempt should use, or undefined to keep
 * using the workspace's own key.
 *
 * Reads {@link ACTIONS} rather than a hand-kept list, because the failure mode
 * of a hand-kept list here is invisible: the key is recorded, silently ignored,
 * and provisioning goes back to the box the app just decided to abandon.
 */
export declare function preferredWorkspaceSandboxRecoveryBoxKey(recovery: WorkspaceSandboxRecoveryState | undefined): string | undefined;
/** Whether the replacement should be restored from the old box's snapshot. */
export declare function shouldRestoreWorkspaceSandboxRecovery(recovery: WorkspaceSandboxRecoveryState | undefined): boolean;
/**
 * Where an app keeps recovery state. One row per workspace, last write wins —
 * a recovery is a current situation, not a history.
 */
export interface WorkspaceSandboxRecoveryStore {
    read: (workspaceId: string) => Promise<WorkspaceSandboxRecoveryState | undefined>;
    write: (workspaceId: string, recovery: WorkspaceSandboxRecoveryState) => Promise<void>;
}
export interface WorkspaceSandboxRecoveryManager {
    read: (workspaceId: string) => Promise<WorkspaceSandboxRecoveryState | undefined>;
    record: (workspaceId: string, recovery: WorkspaceSandboxRecoveryState) => Promise<void>;
    /** Record an owner's decision. Returns undefined when the stored recovery does
     *  not name this sandbox — a decision about a box that has already been
     *  replaced must not resurrect it. */
    decide: (args: {
        workspaceId: string;
        sandboxId: string;
        decision: WorkspaceSandboxRecoveryDecision;
        replacementBoxKey?: string;
    }) => Promise<WorkspaceSandboxRecoveryState | undefined>;
    /** Mark a replacement finished and name the box that took over. */
    complete: (args: {
        workspaceId: string;
        replacementSandboxId: string;
    }) => Promise<WorkspaceSandboxRecoveryState | undefined>;
}
/**
 * Bind the recovery bookkeeping to an app's storage.
 *
 * The app owns persistence — a D1 column, a KV key, a Postgres row — and
 * nothing else. Every rule about which action means what stays here, so it
 * cannot drift between apps.
 */
export declare function createWorkspaceSandboxRecoveryManager(store: WorkspaceSandboxRecoveryStore): WorkspaceSandboxRecoveryManager;
/** Every declared action, for exhaustiveness tests in apps and here. */
export declare const WORKSPACE_SANDBOX_RECOVERY_ACTIONS: readonly WorkspaceSandboxRecoveryAction[];
/** Every declared cause. */
export declare const WORKSPACE_SANDBOX_RECOVERY_CODES: readonly WorkspaceSandboxRecoveryCode[];
export {};
