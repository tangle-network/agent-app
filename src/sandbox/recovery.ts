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
export const EGRESS_PROXY_RECOVERY_REQUIRED = 'EGRESS_PROXY_RECOVERY_REQUIRED'
export const EGRESS_PROXY_RECOVERY_PHASE = 'egress_proxy_recovery'
/** The platform no longer has the box. Nothing to confirm, delete, or restore. */
export const WORKSPACE_SANDBOX_MISSING = 'WORKSPACE_SANDBOX_MISSING'
/** The box exists but its host has no free slot, so it can never be resumed
 *  where it is. A replacement can be placed on a host with room. */
export const WORKSPACE_SANDBOX_HOST_EXHAUSTED = 'WORKSPACE_SANDBOX_HOST_EXHAUSTED'
/** The platform ran its own recovery, failed, and asked for a replacement.
 *  Covers every way a box ends up unbringable with no more specific cause. */
export const WORKSPACE_SANDBOX_UNRECOVERABLE = 'WORKSPACE_SANDBOX_UNRECOVERABLE'

export const WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Every recovery cause, and the one thing the runtime must know about each:
 * whether the box it names can still be read from.
 *
 * `snapshotUsable: false` is not a preference. A snapshot is addressed by the
 * sandbox it was taken from, so when that sandbox cannot be started the restore
 * fails exactly the way the resume did — and an app that tried it would turn a
 * recoverable workspace into a stuck one.
 */
const CODES = {
  [EGRESS_PROXY_RECOVERY_REQUIRED]: { snapshotUsable: true },
  [WORKSPACE_SANDBOX_MISSING]: { snapshotUsable: false },
  [WORKSPACE_SANDBOX_HOST_EXHAUSTED]: { snapshotUsable: false },
  [WORKSPACE_SANDBOX_UNRECOVERABLE]: { snapshotUsable: false },
} as const

export type WorkspaceSandboxRecoveryCode = keyof typeof CODES

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
const ACTIONS = {
  confirmation_required: { replacementChosen: false },
  deletion_declined: { replacementChosen: false },
  replacement_authorized: { replacementChosen: false },
  snapshot_replacement_authorized: { replacementChosen: false },
  replacement_started: { replacementChosen: true },
  replacement_completed: { replacementChosen: true },
  snapshot_replacement_started: { replacementChosen: true },
  snapshot_restore_failed: { replacementChosen: true },
  snapshot_replacement_completed: { replacementChosen: true },
  missing_replacement_started: { replacementChosen: true },
  missing_replacement_completed: { replacementChosen: true },
  unrecoverable_replacement_started: { replacementChosen: true },
  unrecoverable_replacement_completed: { replacementChosen: true },
} as const

export type WorkspaceSandboxRecoveryAction = keyof typeof ACTIONS

export type WorkspaceSandboxSnapshotAvailability = 'available' | 'missing' | 'stale'
export type WorkspaceSandboxSnapshotFreshness = 'fresh' | 'stale' | 'unknown'

/** A snapshot the app took of a box, addressed by the box it came from. */
export interface WorkspaceSandboxSnapshot {
  fromSandboxId: string
  createdAt: string
  [key: string]: unknown
}

export interface WorkspaceSandboxSnapshotAssessment {
  availability: WorkspaceSandboxSnapshotAvailability
  freshness: WorkspaceSandboxSnapshotFreshness
  snapshot?: WorkspaceSandboxSnapshot
}

export interface WorkspaceSandboxRecoveryState {
  code: WorkspaceSandboxRecoveryCode
  sandboxId: string
  detectedAt: string
  snapshot: WorkspaceSandboxSnapshotAssessment
  action: WorkspaceSandboxRecoveryAction
  replacementBoxKey?: string
  replacementSandboxId?: string
  confirmedAt?: string
}

export type WorkspaceSandboxRecoveryDecision = 'replace' | 'decline'

/** Raised when chat cannot continue until an owner decides about the box. */
export class WorkspaceSandboxRecoveryRequiredError extends Error {
  readonly code = EGRESS_PROXY_RECOVERY_REQUIRED
  readonly status = 409
  readonly phase = EGRESS_PROXY_RECOVERY_PHASE
  readonly recovery: WorkspaceSandboxRecoveryState

  constructor(recovery: WorkspaceSandboxRecoveryState, cause: Error) {
    super(workspaceSandboxRecoveryMessage(recovery), { cause })
    this.name = 'WorkspaceSandboxRecoveryRequiredError'
    this.recovery = recovery
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Walk `cause` and `errors` breadth-first, cycle-safe. */
function errorChain(error: unknown): unknown[] {
  const pending = [error]
  const visited = new Set<unknown>()
  const chain: unknown[] = []

  while (pending.length > 0) {
    const current = pending.shift()
    if (current === undefined || current === null || visited.has(current)) continue
    visited.add(current)
    chain.push(current)
    if (!isRecord(current)) continue
    if (current.cause !== undefined) pending.push(current.cause)
    if (Array.isArray(current.errors)) pending.push(...current.errors)
  }

  return chain
}

export function isEgressProxyRecoveryRequiredError(error: unknown): boolean {
  return errorChain(error).some((current) =>
    isRecord(current) && current.code === EGRESS_PROXY_RECOVERY_REQUIRED,
  )
}

export function isWorkspaceSandboxSnapshotRestoreError(error: unknown): boolean {
  return errorChain(error).some((current) => {
    const message = current instanceof Error
      ? current.message
      : isRecord(current) && typeof current.message === 'string'
        ? current.message
        : ''
    return /snapshot|fromSnapshot|restore/i.test(message)
  })
}

/**
 * Judge a snapshot against the box being replaced.
 *
 * Fresh means BOTH that it came from this exact sandbox and that it is inside
 * the age bound — a snapshot from a different box restores someone else's
 * filesystem, which is worse than starting empty.
 */
export function assessWorkspaceSandboxSnapshot(
  snapshot: WorkspaceSandboxSnapshot | undefined,
  sandboxId: string,
  now = Date.now(),
): WorkspaceSandboxSnapshotAssessment {
  if (!snapshot) return { availability: 'missing', freshness: 'unknown' }

  const createdAt = Date.parse(snapshot.createdAt)
  const ageMs = now - createdAt
  const isFresh = snapshot.fromSandboxId === sandboxId
    && Number.isFinite(createdAt)
    && ageMs >= 0
    && ageMs <= WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS

  return isFresh
    ? { availability: 'available', freshness: 'fresh', snapshot }
    : { availability: 'stale', freshness: 'stale', snapshot }
}

function isSnapshotAssessment(value: unknown): value is WorkspaceSandboxSnapshotAssessment {
  if (!isRecord(value)) return false
  const availability = value.availability
  const freshness = value.freshness
  return (availability === 'available' || availability === 'missing' || availability === 'stale')
    && (freshness === 'fresh' || freshness === 'stale' || freshness === 'unknown')
}

export function isWorkspaceSandboxRecoveryAction(
  value: unknown,
): value is WorkspaceSandboxRecoveryAction {
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value)
}

export function isWorkspaceSandboxRecoveryCode(
  value: unknown,
): value is WorkspaceSandboxRecoveryCode {
  return typeof value === 'string' && Object.hasOwn(CODES, value)
}

export function isWorkspaceSandboxRecoveryState(
  value: unknown,
): value is WorkspaceSandboxRecoveryState {
  if (!isRecord(value)) return false
  return isWorkspaceSandboxRecoveryCode(value.code)
    && !!asNonEmptyString(value.sandboxId)
    && !!asNonEmptyString(value.detectedAt)
    && isSnapshotAssessment(value.snapshot)
    && isWorkspaceSandboxRecoveryAction(value.action)
}

export function workspaceSandboxRecoveryFromError(
  error: unknown,
): WorkspaceSandboxRecoveryState | undefined {
  for (const current of errorChain(error)) {
    if (!isRecord(current) || !isWorkspaceSandboxRecoveryState(current.recovery)) continue
    return current.recovery
  }
  return undefined
}

/** What to tell the person waiting. Never names the product, so an app can
 *  surface it verbatim. */
export function workspaceSandboxRecoveryMessage(recovery: WorkspaceSandboxRecoveryState): string {
  if (recovery.code === WORKSPACE_SANDBOX_MISSING) {
    return 'The sandbox behind this workspace no longer exists on the platform. A replacement is being provisioned and your saved work is restored into it.'
  }
  if (!CODES[recovery.code].snapshotUsable) {
    return 'The sandbox behind this workspace could not be started again. A replacement is being provisioned and your saved work is restored into it.'
  }
  if (recovery.action === 'deletion_declined') {
    return 'Sandbox recovery remains paused because replacement was declined. The stopped sandbox has not been deleted.'
  }
  if (recovery.action === 'confirmation_required') {
    const snapshotReason = recovery.snapshot.availability === 'missing'
      ? 'No restorable sandbox snapshot is available.'
      : 'The available sandbox snapshot is stale.'
    return `Sandbox recovery requires owner confirmation before replacement. ${snapshotReason} The stopped sandbox has not been deleted.`
  }
  if (recovery.action === 'snapshot_restore_failed') {
    return 'Sandbox replacement could not restore its verified snapshot, and an empty fallback was not created because it could lose workspace state.'
  }
  return 'Sandbox recovery is required before chat can continue. The stopped sandbox has not been deleted.'
}

export function workspaceSandboxRecoveryRecommendedActions(
  recovery: WorkspaceSandboxRecoveryState,
): string[] {
  if (!CODES[recovery.code].snapshotUsable) {
    return ['Retry after the replacement sandbox finishes provisioning.']
  }
  if (recovery.action === 'deletion_declined') {
    return ['Keep the stopped sandbox for support or ask a workspace owner to authorize replacement.']
  }
  if (recovery.action === 'confirmation_required') {
    return ['An owner can explicitly replace the sandbox after accepting loss of unsnapshotted sandbox-local changes.']
  }
  if (recovery.action === 'snapshot_restore_failed') {
    return ['Retry snapshot restoration or contact support. An empty replacement is not created automatically.']
  }
  return ['Retry after sandbox recovery completes.']
}

/** Flat key/value shape for a log line — no nesting, no secrets. */
export function workspaceSandboxRecoveryDiagnostic(
  recovery: WorkspaceSandboxRecoveryState,
): Record<string, string | undefined> {
  return {
    sandboxId: recovery.sandboxId,
    recoveryCode: recovery.code,
    snapshotAvailability: recovery.snapshot.availability,
    snapshotFreshness: recovery.snapshot.freshness,
    selectedRecoveryAction: recovery.action,
    replacementSandboxId: recovery.replacementSandboxId,
  }
}

/**
 * The box key the next provisioning attempt should use, or undefined to keep
 * using the workspace's own key.
 *
 * Reads {@link ACTIONS} rather than a hand-kept list, because the failure mode
 * of a hand-kept list here is invisible: the key is recorded, silently ignored,
 * and provisioning goes back to the box the app just decided to abandon.
 */
export function preferredWorkspaceSandboxRecoveryBoxKey(
  recovery: WorkspaceSandboxRecoveryState | undefined,
): string | undefined {
  if (!recovery?.replacementBoxKey) return undefined
  return ACTIONS[recovery.action].replacementChosen ? recovery.replacementBoxKey : undefined
}

/** Whether the replacement should be restored from the old box's snapshot. */
export function shouldRestoreWorkspaceSandboxRecovery(
  recovery: WorkspaceSandboxRecoveryState | undefined,
): boolean {
  if (!recovery) return false
  if (!CODES[recovery.code].snapshotUsable) return false
  return !!preferredWorkspaceSandboxRecoveryBoxKey(recovery)
    && recovery.snapshot.availability === 'available'
}

/**
 * Where an app keeps recovery state. One row per workspace, last write wins —
 * a recovery is a current situation, not a history.
 */
export interface WorkspaceSandboxRecoveryStore {
  read: (workspaceId: string) => Promise<WorkspaceSandboxRecoveryState | undefined>
  write: (workspaceId: string, recovery: WorkspaceSandboxRecoveryState) => Promise<void>
}

export interface WorkspaceSandboxRecoveryManager {
  read: (workspaceId: string) => Promise<WorkspaceSandboxRecoveryState | undefined>
  record: (workspaceId: string, recovery: WorkspaceSandboxRecoveryState) => Promise<void>
  /** Record an owner's decision. Returns undefined when the stored recovery does
   *  not name this sandbox — a decision about a box that has already been
   *  replaced must not resurrect it. */
  decide: (args: {
    workspaceId: string
    sandboxId: string
    decision: WorkspaceSandboxRecoveryDecision
    replacementBoxKey?: string
  }) => Promise<WorkspaceSandboxRecoveryState | undefined>
  /** Mark a replacement finished and name the box that took over. */
  complete: (args: {
    workspaceId: string
    replacementSandboxId: string
  }) => Promise<WorkspaceSandboxRecoveryState | undefined>
}

/**
 * Bind the recovery bookkeeping to an app's storage.
 *
 * The app owns persistence — a D1 column, a KV key, a Postgres row — and
 * nothing else. Every rule about which action means what stays here, so it
 * cannot drift between apps.
 */
export function createWorkspaceSandboxRecoveryManager(
  store: WorkspaceSandboxRecoveryStore,
): WorkspaceSandboxRecoveryManager {
  async function record(workspaceId: string, recovery: WorkspaceSandboxRecoveryState) {
    await store.write(workspaceId, recovery)
  }

  return {
    read: store.read,
    record,
    async decide({ workspaceId, sandboxId, decision, replacementBoxKey }) {
      const current = await store.read(workspaceId)
      if (!current || current.sandboxId !== sandboxId) return undefined
      const next: WorkspaceSandboxRecoveryState = {
        ...current,
        action: decision === 'replace'
          ? (current.snapshot.availability === 'available'
              ? 'snapshot_replacement_authorized'
              : 'replacement_authorized')
          : 'deletion_declined',
        confirmedAt: new Date().toISOString(),
        ...(decision === 'replace' && replacementBoxKey ? { replacementBoxKey } : {}),
      }
      await record(workspaceId, next)
      return next
    },
    async complete({ workspaceId, replacementSandboxId }) {
      const current = await store.read(workspaceId)
      if (!current) return undefined
      const next: WorkspaceSandboxRecoveryState = {
        ...current,
        action: completionFor(current.action),
        replacementSandboxId,
      }
      await record(workspaceId, next)
      return next
    },
  }
}

/** The finished form of an in-flight replacement action. */
function completionFor(action: WorkspaceSandboxRecoveryAction): WorkspaceSandboxRecoveryAction {
  switch (action) {
    case 'missing_replacement_started':
      return 'missing_replacement_completed'
    case 'unrecoverable_replacement_started':
      return 'unrecoverable_replacement_completed'
    case 'snapshot_replacement_started':
    case 'snapshot_replacement_authorized':
      return 'snapshot_replacement_completed'
    default:
      return 'replacement_completed'
  }
}

/** Every declared action, for exhaustiveness tests in apps and here. */
export const WORKSPACE_SANDBOX_RECOVERY_ACTIONS = Object.keys(
  ACTIONS,
) as readonly WorkspaceSandboxRecoveryAction[]

/** Every declared cause. */
export const WORKSPACE_SANDBOX_RECOVERY_CODES = Object.keys(
  CODES,
) as readonly WorkspaceSandboxRecoveryCode[]
