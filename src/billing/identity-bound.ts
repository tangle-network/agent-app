import { createWorkspaceKeyLocks } from './identity-locks'
import { assertWorkspaceKeyCryptoUsable } from './crypto-probe'
import type { KeyCrypto, KeyProvisioner } from './index'

/** Lifecycle state for a durable delegated key row. */
export type WorkspaceKeyStatus =
  | 'legacy'
  | 'provisioning'
  | 'active'
  | 'revocation_pending'
  | 'revoked'
  | 'orphaned'

/** Product partition used by the key store and remote provisioner. */
export type WorkspaceKeyProduct = string

/** The identity fields that bind a child key to its paying owner and source. */
export interface WorkspaceKeyIdentity {
  workspaceId: string
  ownerUserId: string
  platformUserId: string
  sourceKeyId?: string | null
  /** A non-secret digest of the source credential. */
  sourceKeyFingerprint: string
}

/** A product/workspace/owner lookup scope. */
export interface DurableWorkspaceKeyScope {
  workspaceId: string
  ownerUserId: string
  product: WorkspaceKeyProduct
}

/** A persisted child-key row owned by this manager. */
export interface DurableWorkspaceKeyRecord {
  id: string
  workspaceId: string
  ownerUserId: string
  product: WorkspaceKeyProduct
  platformUserId: string
  sourceKeyId: string | null
  sourceKeyFingerprint: string
  /** The remote name, used to recover a create after a crash. A store may return null: the placeholder id carries it. */
  name: string | null
  /** The persisted retry identity for the remote create. Absent on legacy rows without a persisted create identity. */
  idempotencyKey?: string | null
  keyId: string
  keyEncrypted: string
  /** A provisioning row keeps the requested budget. An active row: 0 for a confirmed spend-through child, which spends its source's cap. */
  budgetUsd: number
  expiresAt: Date
  status: WorkspaceKeyStatus
  revocationAttempts: number
  nextRevocationAt: Date | null
  lastRevocationError: string | null
  createdAt: Date
}

/** A row that has been written before its remote child key exists. */
export interface DurableWorkspaceKeyProvisioningRecord extends DurableWorkspaceKeyRecord {
  status: 'provisioning'
}

/** `spendThrough: true` confirms the child has no budget of its own; without it the child is sized at the requested budget. */
type DurableWorkspaceKeyCreateResult = Awaited<ReturnType<KeyProvisioner['createKey']>> & {
  budgetUsd?: number | null; spendThrough?: true; expiresAt?: string | null
}

/** The exact request identity that must be reused when recovering a create. */
export interface DurableWorkspaceKeyCreateInput {
  name: string
  product: string
  budgetUsd: number
  /** Mint a child that spends the source's cap and reserves nothing. A provisioner that ignores it mints `budgetUsd`. */
  spendThrough?: true
  expiresAt: string
  /** Stable across process restarts for one persisted provisioning row. */
  idempotencyKey: string
}

/** The remote operations required by the durable manager. */
export interface DurableWorkspaceKeyProvisioner {
  /** True only when replay returns the original child for the persisted request identity. */
  supportsIdempotentCreate?: true
  /** Create one child key. Non-idempotent providers recover through stable-name discovery only. */
  createKey(input: DurableWorkspaceKeyCreateInput): Promise<DurableWorkspaceKeyCreateResult>
  /** `budgetRemaining` is what the key can still spend; for a spend-through child, its source's remainder. */
  getKey(id: string): Promise<{ budgetUsd?: number | null; budgetSpent?: number; budgetRemaining?: number; expiresAt?: string | null }>
  /**
   * Retire one child. `slot` is the row that minted it: its name, its own source and Platform user, so a child minted
   * under an earlier source is retired through that source's slot. A typed refusal carries `refusal.status`.
   */
  revokeKey(id: string, slot?: Pick<DurableWorkspaceKeyRecord, 'name' | 'sourceKeyId' | 'platformUserId'>): Promise<unknown>
  /** Find remote keys for a specific persisted provisioning attempt. */
  findCreatedKeys(input: {
    name: string
    product: string
    sourceKeyId?: string | null
  }): Promise<Array<{ id: string }>>
}

/** Optional compare-and-set lifecycle writes for stores that support fencing. */
export interface DurableWorkspaceKeyConditionalWrites {
  /** Return false when the row was no longer provisioning. */
  markProvisioningRemote(input: { id: string; keyId: string }): Promise<boolean>
  /** Return false when the row was no longer provisioning. */
  markActive(input: Parameters<DurableWorkspaceKeyStore['markActive']>[0]): Promise<boolean>
}

/** Persistence operations for identity-bound key lifecycle state. */
export interface DurableWorkspaceKeyStore {
  /** Return the active row for this exact product scope. */
  getActive(scope: DurableWorkspaceKeyScope): Promise<DurableWorkspaceKeyRecord | null>
  /** Return every unfinished provisioning row for this exact product scope. */
  listProvisioning(scope: DurableWorkspaceKeyScope): Promise<DurableWorkspaceKeyProvisioningRecord[]>
  /** Insert before the remote create so a crashed create can be recovered. */
  insertProvisioning(record: DurableWorkspaceKeyProvisioningRecord): Promise<void>
  /** Save the remote id while the row remains in provisioning state. */
  markProvisioningRemote(input: { id: string; keyId: string }): Promise<void>
  /** Promote a fully encrypted row to active state. */
  markActive(input: {
    id: string
    keyId: string
    keyEncrypted: string
    expiresAt: Date
    budgetUsd: number
  }): Promise<void>
  /**
   * Optional fenced writes. The manager uses false to compensate a stale
   * creator. Stores without this field retain the pre-fence behavior.
   */
  conditionalWrites?: DurableWorkspaceKeyConditionalWrites
  /** Keep a failed cleanup visible and schedule a later retry. Terminal rows are immutable. */
  markRevocationPending(input: {
    id: string
    error?: string | null
    nextAttemptAt: Date
    incrementAttempts: boolean
  }): Promise<void>
  /** Mark a remote key as revoked. Missing remote keys count as revoked. */
  markRevoked(id: string, now: Date): Promise<void>
  /** Mark a provisioning row terminal when no remote key remains to clean. */
  markOrphaned(id: string, error: string): Promise<void>
  /** Query due cleanup rows. The implementation should filter by the supplied scope. */
  listPendingRevocations(input: {
    product: WorkspaceKeyProduct
    workspaceId?: string
    ownerUserId?: string
    now: Date
    limit: number
    /** Include rows scheduled for a later retry when checking before issuance. */
    includeFuture?: boolean
  }): Promise<DurableWorkspaceKeyRecord[]>
  /** Acquire a cross-process lease for one product/workspace/owner scope. */
  acquireLease(scope: string, operationId: string, now: Date, leaseMs: number): Promise<boolean>
  /** Renew an acquired lease before its expiry. */
  renewLease(scope: string, operationId: string, now: Date, leaseMs: number): Promise<boolean>
  /** Release an acquired lease. */
  releaseLease(scope: string, operationId: string): Promise<void>
}

/** Live budget information for a child key. */
export interface WorkspaceKeyUsage {
  keyId: string
  budgetUsd: number
  budgetSpent: number
  budgetRemaining: number
  expiresAt: string
  exhausted: boolean
}

/** The decrypted key plus the usage snapshot used to issue it. */
export interface WorkspaceRuntimeKey {
  key: string
  usage: WorkspaceKeyUsage
  /** True when this call minted a new remote key. */
  refreshed: boolean
}

/** Identity-bound durable key manager API. */
export interface DurableWorkspaceKeyManager {
  /**
   * Reuse a matching active key or reconcile and mint one under a lease. Pass `spendThrough` when Platform reports a
   * budget on the source: the child then reserves nothing, so live children never hold the source's cap several times
   * over, and Platform refuses each request once that cap is spent. `budgetUsd` is then the remainder reported at mint.
   */
  ensureKey(identity: WorkspaceKeyIdentity, options?: { budgetUsd?: number; spendThrough?: boolean }): Promise<WorkspaceRuntimeKey>
  /** Read usage without returning the child secret. */
  getUsage(identity: WorkspaceKeyIdentity): Promise<WorkspaceKeyUsage | null>
  /**
   * Retry due cleanup rows. A supplied owner/workspace limits the retry to its
   * scope. Empty provisioning rows also require the full identity so a retry
   * can use the original source binding safely.
   */
  retryPendingRevocations(
    scope?: Pick<WorkspaceKeyIdentity, 'ownerUserId' | 'workspaceId'>,
    identity?: WorkspaceKeyIdentity,
  ): Promise<number>
}

/** Configuration for {@link createIdentityBoundWorkspaceKeyManager}. */
export interface DurableWorkspaceKeyManagerOptions {
  store: DurableWorkspaceKeyStore
  provisioner: DurableWorkspaceKeyProvisioner
  /**
   * Control-plane client for historical get/revoke/list operations. Use this
   * when the source credential can rotate or disappear. It never mints keys.
   */
  recoveryProvisioner?: Pick<DurableWorkspaceKeyProvisioner, 'getKey' | 'revokeKey' | 'findCreatedKeys'>
  crypto: KeyCrypto
  /** Product partition. Products must use separate values. */
  product: WorkspaceKeyProduct
  defaultBudgetUsd: number
  now?: () => Date
  /** Local lifetime used when the remote response omits an expiry. */
  keyLifetimeMs?: number
  /**
   * Least remaining life a reused key needs: the app's longest turn plus a margin, shorter than `keyLifetimeMs`. Below
   * it a fresh key is minted and the old one retired at its own expiry, never revoked under a turn that holds it.
   */
  minRemainingLifetimeMs?: number
  /** Lease lifetime for remote operations. */
  leaseMs?: number
  /** Maximum time to wait for another issuer to release the scope lease. */
  leaseWaitMs?: number
  /** Poll delay while waiting for a scope lease. */
  leasePollMs?: number
  /** Renewal interval. It must be shorter than `leaseMs`. */
  leaseRenewIntervalMs?: number
  /** Initial delay for a failed remote revoke. */
  revocationRetryBaseMs?: number
  /** Maximum delay for a failed remote revoke. */
  revocationRetryMaxMs?: number
  /** Remote name; the mint's operation id is appended when absent, as a create under a held name revokes its key. */
  nameForIdentity?: (identity: WorkspaceKeyIdentity, operationId: string) => string
  /** Resolve names for rows written before a mint stored its name. Null blocks issuance safely. */
  legacyNameForRecord?: (record: DurableWorkspaceKeyRecord) => string | null | undefined
  /** Recognize a missing remote key without depending on a provider SDK. */
  isRemoteMissing?: (error: unknown) => boolean
}

const DEFAULT_KEY_LIFETIME_MS = 55 * 60_000
/** Default child-key reuse floor; set minRemainingLifetimeMs to cover the caller's execution policy and safety margin. */
export const DEFAULT_MIN_REMAINING_KEY_LIFETIME_MS = 20 * 60_000
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_LEASE_WAIT_MS = 15_000
const DEFAULT_LEASE_POLL_MS = 50
const DEFAULT_LEASE_RENEW_INTERVAL_MS = Math.floor(DEFAULT_LEASE_MS / 3)
const DEFAULT_REVOCATION_RETRY_BASE_MS = 2_000
const DEFAULT_REVOCATION_RETRY_MAX_MS = 60_000
const PENDING_REVOCATION_BATCH_SIZE = 20
// Covers clock skew between this host and the platform that enforces the child's expiry.
const ORPHAN_AFTER_EXPIRY_GRACE_MS = 5 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function operationId(): string {
  return globalThis.crypto.randomUUID()
}

function requirePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`)
  return value
}

function requireNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`)
  return value
}

function normalizeIdentity(identity: WorkspaceKeyIdentity): WorkspaceKeyIdentity {
  const workspaceId = identity.workspaceId.trim()
  const ownerUserId = identity.ownerUserId.trim()
  const platformUserId = identity.platformUserId.trim()
  const sourceKeyFingerprint = identity.sourceKeyFingerprint.trim()
  const sourceKeyId = identity.sourceKeyId?.trim() || null
  if (!workspaceId || !ownerUserId || !platformUserId || !sourceKeyFingerprint) {
    throw new Error('workspace child key identity is incomplete')
  }
  return { workspaceId, ownerUserId, platformUserId, sourceKeyId, sourceKeyFingerprint }
}

function scopeFor(identity: Pick<WorkspaceKeyIdentity, 'workspaceId' | 'ownerUserId'>, product: string): DurableWorkspaceKeyScope {
  return { workspaceId: identity.workspaceId, ownerUserId: identity.ownerUserId, product }
}

function scopeKey(scope: DurableWorkspaceKeyScope): string {
  return JSON.stringify([scope.product, scope.workspaceId, scope.ownerUserId])
}

function safeNamePart(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-')
  return normalized.slice(0, 80) || 'unknown'
}

function defaultKeyName(identity: WorkspaceKeyIdentity, product: string, operationId: string): string {
  return `agent-app:${safeNamePart(product)}:${safeNamePart(identity.workspaceId)}:${safeNamePart(identity.platformUserId)}:${operationId}`
}

function sourceKeyId(identity: WorkspaceKeyIdentity): string | null {
  return identity.sourceKeyId?.trim() || null
}

function sameIdentity(row: DurableWorkspaceKeyRecord, identity: WorkspaceKeyIdentity, product: string): boolean {
  return row.workspaceId === identity.workspaceId
    && row.ownerUserId === identity.ownerUserId
    && row.product === product
    && row.platformUserId === identity.platformUserId
    && row.sourceKeyId === sourceKeyId(identity)
    && row.sourceKeyFingerprint === identity.sourceKeyFingerprint
}

/**
 * Whether an ACTIVE child may be reused: it belongs to its workspace, owner, product and Platform user, not to the
 * source credential that minted it. Every sign-in presents a new source credential (sourceKeyId, sourceKeyFingerprint),
 * so matching on it made the same member's second sign-in revoke the child a running turn held. The payer cannot
 * differ for one Platform user: delegation refuses a child not paid by that user (`platform/delegated-keys.ts`:
 * non-user payer and payer id checks). A revoked source takes its children with it: their read-back is a definite
 * gone verdict. Cleanup goes through the row's own slot (`slotOf`). Recovery of a half-provisioned row still needs the
 * exact minting source (`sameIdentity`).
 */
function sameOwner(row: DurableWorkspaceKeyRecord, owner: Pick<DurableWorkspaceKeyRecord, 'workspaceId' | 'ownerUserId' | 'platformUserId'>,
  product: string): boolean {
  return row.workspaceId === owner.workspaceId
    && row.ownerUserId === owner.ownerUserId
    && row.product === product
    && row.platformUserId === owner.platformUserId
}

/** The slot a child was minted in, for the provisioner's revoke. Never the secret. */
function slotOf(row: DurableWorkspaceKeyRecord): Pick<DurableWorkspaceKeyRecord, 'name' | 'sourceKeyId' | 'platformUserId'> {
  return { name: row.name, sourceKeyId: row.sourceKeyId, platformUserId: row.platformUserId }
}

/**
 * A refused cleanup of a live child waits for the child's own expiry and blocks no issuance meanwhile. Only that
 * deferral schedules the row AT the expiry (`settleFailedRevoke`); a transient retry that lands at or past it still
 * blocks, so a second child never mints while the first is live.
 */
function waitsForExpiry(row: DurableWorkspaceKeyRecord): boolean {
  return row.nextRevocationAt !== null && row.nextRevocationAt.getTime() === row.expiresAt.getTime()
}

function errorMessage(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : fallback)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*)(?!Bearer\b)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 240)
}

function isProvisioningId(value: string): boolean {
  return value.startsWith('provisioning:')
}

/**
 * The name a mint writes into its placeholder id (`provisioning:<operation>:<name>`) before the remote create, so
 * recovery finds a half-created child by that name even in a store with no name column. Older placeholders carry none.
 */
function placeholderName(keyId: string): string | undefined {
  return isProvisioningId(keyId) ? keyId.split(':').slice(2).join(':').trim() || undefined : undefined
}

/** A spend-through mint marks its placeholder (`provisioning:<operation>+spend-through:<name>`); 4.0.14 wrote budget 0. */
function requestedSpendThrough(row: DurableWorkspaceKeyRecord): boolean {
  return row.budgetUsd === 0 || (isProvisioningId(row.keyId) && row.keyId.split(':')[1]!.endsWith('+spend-through'))
}

async function markProvisioningRemote(store: DurableWorkspaceKeyStore, input: { id: string; keyId: string }): Promise<boolean> {
  if (store.conditionalWrites) return store.conditionalWrites.markProvisioningRemote(input)
  await store.markProvisioningRemote(input)
  return true
}

async function markActive(store: DurableWorkspaceKeyStore, input: Parameters<DurableWorkspaceKeyStore['markActive']>[0]): Promise<boolean> {
  if (store.conditionalWrites) return store.conditionalWrites.markActive(input)
  await store.markActive(input)
  return true
}

function usageFromRemote(
  row: DurableWorkspaceKeyRecord,
  remote: Awaited<ReturnType<DurableWorkspaceKeyProvisioner['getKey']>>,
  now: Date,
): WorkspaceKeyUsage {
  // A spend-through child has no budget to exhaust: a spent source is refused per request, and retiring the child for
  // it would only mint another child that Platform refuses. Only its expiry retires it.
  const spendThrough = row.budgetUsd === 0
  const budgetUsd = spendThrough ? 0 : remote.budgetUsd ?? row.budgetUsd
  const budgetSpent = spendThrough ? 0 : remote.budgetSpent ?? 0
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error('workspace child key budget is malformed')
  if (!Number.isFinite(budgetSpent) || budgetSpent < 0) throw new Error('workspace child key usage is malformed')
  const expiresAt = remote.expiresAt ?? row.expiresAt.toISOString()
  const expiryMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiryMs)) throw new Error('workspace child key expiry is malformed')
  const budgetRemaining = Math.max(0, spendThrough ? remote.budgetRemaining ?? 0 : budgetUsd - budgetSpent) || 0
  return {
    keyId: row.keyId,
    budgetUsd,
    budgetSpent,
    budgetRemaining,
    expiresAt,
    exhausted: (!spendThrough && budgetRemaining <= 0) || expiryMs <= now.getTime(),
  }
}

function defaultRemoteMissing(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown } | null
  return value?.status === 404 || value?.code === 'not_found'
}

/** `<status> <code>` for a typed refusal Platform decided (a 4xx other than 408 and 429): a retry gets the same answer. */
function definiteRefusal(error: unknown): string | null {
  const refusal = (error as { refusal?: { status?: unknown; code?: unknown; platformCode?: unknown } } | null)?.refusal
  const status = refusal?.status
  if (typeof status !== 'number' || status < 400 || status > 499 || status === 408 || status === 429) return null
  return `${status} ${String(refusal?.platformCode ?? refusal?.code ?? 'refused')}`
}

/**
 * Create a product-neutral manager for child-key issuance and cleanup.
 *
 * The provisioner must already be authenticated for the current source
 * credential. The manager persists the source id and its non-secret
 * fingerprint with each row, reuses an active row for the same workspace,
 * owner, product and Platform user, and cleans each row through its own slot.
 */
export function createIdentityBoundWorkspaceKeyManager(
  options: DurableWorkspaceKeyManagerOptions,
): DurableWorkspaceKeyManager {
  const product = options.product.trim()
  if (!product) throw new Error('workspace child key product is required')
  const defaultBudgetUsd = requirePositive(options.defaultBudgetUsd, 'defaultBudgetUsd')
  const keyLifetimeMs = requirePositive(options.keyLifetimeMs ?? DEFAULT_KEY_LIFETIME_MS, 'keyLifetimeMs')
  const minRemainingLifetimeMs = requireNonNegative(
    options.minRemainingLifetimeMs ?? Math.min(DEFAULT_MIN_REMAINING_KEY_LIFETIME_MS, Math.floor(keyLifetimeMs / 2)),
    'minRemainingLifetimeMs',
  )
  if (minRemainingLifetimeMs >= keyLifetimeMs) throw new Error('minRemainingLifetimeMs must be shorter than keyLifetimeMs')
  const leaseMs = requirePositive(options.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs')
  const leaseWaitMs = requireNonNegative(options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS, 'leaseWaitMs')
  const leasePollMs = requirePositive(options.leasePollMs ?? DEFAULT_LEASE_POLL_MS, 'leasePollMs')
  const leaseRenewIntervalMs = requirePositive(
    options.leaseRenewIntervalMs ?? Math.min(DEFAULT_LEASE_RENEW_INTERVAL_MS, Math.floor(leaseMs / 3)),
    'leaseRenewIntervalMs',
  )
  if (leaseRenewIntervalMs >= leaseMs) throw new Error('leaseRenewIntervalMs must be shorter than leaseMs')
  const revocationRetryBaseMs = requirePositive(
    options.revocationRetryBaseMs ?? DEFAULT_REVOCATION_RETRY_BASE_MS,
    'revocationRetryBaseMs',
  )
  const revocationRetryMaxMs = requirePositive(
    options.revocationRetryMaxMs ?? DEFAULT_REVOCATION_RETRY_MAX_MS,
    'revocationRetryMaxMs',
  )
  if (revocationRetryMaxMs < revocationRetryBaseMs) throw new Error('revocationRetryMaxMs must cover the base delay')

  const now = options.now ?? (() => new Date())
  const isRemoteMissing = options.isRemoteMissing ?? defaultRemoteMissing
  const recoveryProvisioner = options.recoveryProvisioner ?? options.provisioner
  const { withLocalLock, withDurableLease } = createWorkspaceKeyLocks(leaseWaitMs, options, now, leaseMs, leasePollMs, leaseRenewIntervalMs, operationId, sleep)

  const { revokePending, markPending, cleanupProvisioning, reconcileProvisioning } = createWorkspaceKeyRecovery(revocationRetryMaxMs, revocationRetryBaseMs, options, now, recoveryProvisioner, isRemoteMissing, product)

  async function retryPendingRevocationsUnlocked(
    scopeFilter?: Pick<WorkspaceKeyIdentity, 'ownerUserId' | 'workspaceId'>,
    activeIdentity?: WorkspaceKeyIdentity,
  ): Promise<{ completed: number; pending: number }> {
    const rows = await options.store.listPendingRevocations({
      product,
      workspaceId: scopeFilter?.workspaceId,
      ownerUserId: scopeFilter?.ownerUserId,
      now: now(),
      limit: PENDING_REVOCATION_BATCH_SIZE,
    })
    let completed = 0
    let pending = 0
    for (const row of rows) {
      if (row.product !== product) continue
      if (scopeFilter && (row.workspaceId !== scopeFilter.workspaceId || row.ownerUserId !== scopeFilter.ownerUserId)) continue
      if (await revokePending(row, activeIdentity)) completed += 1
      else pending += 1
    }
    return { completed, pending }
  }

  async function assertNoPendingRevocations(identity: WorkspaceKeyIdentity): Promise<void> {
    const rows = await options.store.listPendingRevocations({
      product,
      workspaceId: identity.workspaceId,
      ownerUserId: identity.ownerUserId,
      now: now(),
      limit: PENDING_REVOCATION_BATCH_SIZE,
      includeFuture: true,
    })
    if (rows.some((row) => row.product === product
      && row.workspaceId === identity.workspaceId
      && row.ownerUserId === identity.ownerUserId && !waitsForExpiry(row))) {
      throw new Error('a previous workspace child-key cleanup is pending; issuance is blocked until it completes')
    }
  }

  async function retryPendingRevocations(
    scopeInput?: Pick<WorkspaceKeyIdentity, 'ownerUserId' | 'workspaceId'>,
    identityInput?: WorkspaceKeyIdentity,
  ): Promise<number> {
    const identity = identityInput ? normalizeIdentity(identityInput) : undefined
    if (identity && scopeInput
      && (identity.workspaceId !== scopeInput.workspaceId || identity.ownerUserId !== scopeInput.ownerUserId)) {
      throw new Error('workspace child key retry identity does not match its scope')
    }
    if (scopeInput) {
      const workspaceId = scopeInput.workspaceId.trim()
      const ownerUserId = scopeInput.ownerUserId.trim()
      if (!workspaceId || !ownerUserId) throw new Error('workspace child key retry scope is incomplete')
      const scope = scopeKey({ workspaceId, ownerUserId, product })
      return withLocalLock(scope, () => withDurableLease(scope, async () => (
        await retryPendingRevocationsUnlocked({ workspaceId, ownerUserId }, identity)).completed))
    }

    if (identity) {
      const scope = scopeKey(scopeFor(identity, product))
      return withLocalLock(scope, () => withDurableLease(scope, async () => (
        await retryPendingRevocationsUnlocked({ workspaceId: identity.workspaceId, ownerUserId: identity.ownerUserId }, identity)).completed))
    }

    const rows = await options.store.listPendingRevocations({ product, now: now(), limit: PENDING_REVOCATION_BATCH_SIZE })
    let completed = 0
    const scopes = new Set<string>()
    for (const row of rows) {
      if (row.product !== product) continue
      const scope = scopeKey({ workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, product })
      if (scopes.has(scope)) continue
      scopes.add(scope)
      completed += await withLocalLock(scope, () => withDurableLease(scope, async () => (await retryPendingRevocationsUnlocked({
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
      })).completed))
    }
    return completed
  }

  async function readActive(identity: WorkspaceKeyIdentity): Promise<{ row: DurableWorkspaceKeyRecord; usage: WorkspaceKeyUsage } | null> {
    const row = await options.store.getActive(scopeFor(identity, product))
    if (!row) return null
    if (!sameOwner(row, identity, product)) {
      await options.store.markRevocationPending({
        id: row.id,
        error: 'active child key belongs to another workspace owner or Platform user',
        nextAttemptAt: now(),
        incrementAttempts: false,
      })
      return null
    }

    let remote: Awaited<ReturnType<DurableWorkspaceKeyProvisioner['getKey']>>
    try {
      remote = await recoveryProvisioner.getKey(row.keyId)
    } catch (error) {
      if (isRemoteMissing(error)) {
        await options.store.markRevoked(row.id, now())
        return null
      }
      throw error
    }
    const usage = usageFromRemote(row, remote, now())
    if (usage.exhausted) {
      await options.store.markRevocationPending({
        id: row.id,
        error: 'active child key is expired or exhausted',
        nextAttemptAt: now(),
        incrementAttempts: false,
      })
      return null
    }
    return { row, usage }
  }

  const { mint } = createWorkspaceKeyMinter(options, now, keyLifetimeMs, product, markPending, cleanupProvisioning, revokePending)

  async function ensureKey(identityInput: WorkspaceKeyIdentity, keyOptions?: { budgetUsd?: number; spendThrough?: boolean }): Promise<WorkspaceRuntimeKey> {
    const identity = normalizeIdentity(identityInput)
    const budgetUsd = keyOptions?.budgetUsd ?? defaultBudgetUsd
    requirePositive(budgetUsd, 'budgetUsd')
    const scope = scopeKey(scopeFor(identity, product))
    let mintedRemote: { row: DurableWorkspaceKeyProvisioningRecord; remoteId: string } | null = null
    return withLocalLock(scope, () => withDurableLease(scope, async () => {
      const initialCleanup = await retryPendingRevocationsUnlocked(identity, identity)
      if (initialCleanup.pending > 0) throw new Error('a previous workspace child-key cleanup is pending; issuance is blocked until it completes')
      await reconcileProvisioning(identity)
      const active = await readActive(identity)
      if (active) {
        const key = await options.crypto.decrypt(active.row.keyEncrypted)
        if (!key.trim()) throw new Error('workspace child key secret is empty')
        // Checked after the awaited decrypt: a key handed out must outlive the turn that takes it.
        const remainingMs = Date.parse(active.usage.expiresAt) - now().getTime()
        if (remainingMs > 0 && remainingMs >= minRemainingLifetimeMs) return { key, usage: active.usage, refreshed: false }
        // A running turn may hold a key below the floor: retire it at its expiry (`waitsForExpiry`), never revoke it.
        await options.store.markRevocationPending({
          id: active.row.id,
          error: remainingMs > 0 ? 'active child key is below the reuse floor; it is retired at its expiry'
            : 'active child key expired while it was read',
          nextAttemptAt: remainingMs > 0 ? active.row.expiresAt : now(),
          incrementAttempts: false,
        })
      }
      const finalCleanup = await retryPendingRevocationsUnlocked(identity, identity)
      if (finalCleanup.pending > 0) throw new Error('a previous workspace child-key cleanup is pending; issuance is blocked until it completes')
      await assertNoPendingRevocations(identity)
      return mint(identity, budgetUsd, keyOptions?.spendThrough === true, (row, remoteId) => {
        mintedRemote = { row, remoteId }
      })
    }, async () => {
      const remote = mintedRemote
      if (!remote) return
      const cleaned = await revokePending({
        ...remote.row,
        keyId: remote.remoteId,
        status: 'revocation_pending',
      }, identity)
      if (!cleaned) throw new Error('lease-loss child-key cleanup is pending')
    }))
  }

  async function getUsage(identityInput: WorkspaceKeyIdentity): Promise<WorkspaceKeyUsage | null> {
    const identity = normalizeIdentity(identityInput)
    const scope = scopeKey(scopeFor(identity, product))
    return withLocalLock(scope, () => withDurableLease(scope, async () => {
      const active = await readActive(identity)
      return active?.usage ?? null
    }))
  }

  return { ensureKey, getUsage, retryPendingRevocations }
}

function createWorkspaceKeyRecovery(
  revocationRetryMaxMs: ReturnType<typeof requirePositive>,
  revocationRetryBaseMs: ReturnType<typeof requirePositive>,
  options: DurableWorkspaceKeyManagerOptions,
  now: () => Date,
  recoveryProvisioner: Pick<DurableWorkspaceKeyProvisioner, "getKey" | "revokeKey" | "findCreatedKeys">,
  isRemoteMissing: (error: unknown) => boolean,
  product: string,
) {
  function retryDelay(attempts: number): number {
    return Math.min(revocationRetryMaxMs, revocationRetryBaseMs * 2 ** Math.min(Math.max(attempts - 1, 0), 5))
  }

  async function markPending(id: string, error: unknown, incrementAttempts: boolean): Promise<void> {
    const delay = incrementAttempts ? retryDelay(1) : 0
    await options.store.markRevocationPending({
      id,
      error: errorMessage(error, 'remote key cleanup failed'),
      nextAttemptAt: new Date(now().getTime() + delay),
      incrementAttempts,
    })
  }

  /**
   * A refusal to revoke never blocks the scope. Missing is gone. After a definite refusal the child's own verdict
   * decides: past its expiry, or unable to authenticate or spend, it is gone; live or refused for now, it is retired
   * at its expiry. Null keeps today's retry: a transient failure, or a verdict read that failed transiently.
   */
  async function settleFailedRevoke(row: DurableWorkspaceKeyRecord, keyId: string, error: unknown): Promise<'gone' | 'waits' | null> {
    // An expired child can neither authenticate nor spend, whatever answered: it never holds the scope.
    if (isRemoteMissing(error) || now().getTime() >= row.expiresAt.getTime()) return 'gone'
    const refused = definiteRefusal(error)
    if (!refused) return null
    try {
      if (usageFromRemote(row, await recoveryProvisioner.getKey(keyId), now()).exhausted) return 'gone'
    } catch (readError) {
      if (isRemoteMissing(readError)) return 'gone'
      if (!definiteRefusal(readError)) return null
    }
    await options.store.markRevocationPending({
      id: row.id,
      error: errorMessage(new Error(`cleanup refused (${refused}); the child is retired at its expiry`), 'cleanup refused'),
      nextAttemptAt: row.expiresAt,
      incrementAttempts: true,
    })
    return 'waits'
  }

  async function revokePending(row: DurableWorkspaceKeyRecord, identity?: WorkspaceKeyIdentity): Promise<boolean> {
    if (!row.keyId || isProvisioningId(row.keyId)) return cleanupProvisioning(row, identity)
    const active = await options.store.getActive({
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
      product: row.product,
    })
    if (active && active.id !== row.id && active.keyId === row.keyId) {
      await options.store.markRevoked(row.id, now())
      return true
    }
    try {
      await recoveryProvisioner.revokeKey(row.keyId, slotOf(row))
      await options.store.markRevoked(row.id, now())
      return true
    } catch (error) {
      const settled = await settleFailedRevoke(row, row.keyId, error)
      if (settled === 'gone') await options.store.markRevoked(row.id, now())
      if (settled) return true
      await options.store.markRevocationPending({
        id: row.id,
        error: errorMessage(error, 'remote key revocation failed'),
        nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
        incrementAttempts: true,
      })
      return false
    }
  }

  async function provisioningCandidates(row: DurableWorkspaceKeyRecord): Promise<{
    name: string
    candidates: Array<{ id: string }>
  } | null> {
    if (row.keyId && !isProvisioningId(row.keyId)) {
      return { name: row.name?.trim() ?? '', candidates: [{ id: row.keyId }] }
    }
    const name = row.name?.trim() || placeholderName(row.keyId) || options.legacyNameForRecord?.(row)?.trim()
    if (!name) return null
    return {
      name,
      candidates: await recoveryProvisioner.findCreatedKeys({
        name,
        product: row.product,
        sourceKeyId: row.sourceKeyId,
      }),
    }
  }

  async function probeProvisioning(
    row: DurableWorkspaceKeyRecord,
    identity: WorkspaceKeyIdentity | undefined,
    name: string,
  ): Promise<Array<{ id: string }> | null> {
    const idempotencyKey = row.idempotencyKey?.trim()
    if (!identity || !sameIdentity(row, identity, product)
      || !options.provisioner.supportsIdempotentCreate || !idempotencyKey) return []
    try {
      const created = await options.provisioner.createKey({
        name,
        product: row.product,
        budgetUsd: row.budgetUsd,
        ...(requestedSpendThrough(row) ? { spendThrough: true as const } : {}),
        expiresAt: row.expiresAt.toISOString(),
        idempotencyKey,
      })
      const remoteId = created.id?.trim()
      if (remoteId) return [{ id: remoteId }]
    } catch (error) {
      await options.store.markRevocationPending({
        id: row.id,
        error: errorMessage(error, 'remote provisioning recovery failed'),
        nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
        incrementAttempts: true,
      })
      return null
    }
    return (await provisioningCandidates({ ...row, name, keyId: `provisioning:${idempotencyKey}` }))?.candidates ?? []
  }

  async function cleanupProvisioning(row: DurableWorkspaceKeyRecord, identity?: WorkspaceKeyIdentity): Promise<boolean> {
    const resolved = await provisioningCandidates(row)
    if (!resolved) {
      await options.store.markRevocationPending({
        id: row.id,
        error: 'provisioning row has no recoverable remote name; migrate the row or configure legacyNameForRecord',
        nextAttemptAt: now(),
        incrementAttempts: false,
      })
      return false
    }
    let { name, candidates } = resolved
    if (candidates.length === 0) {
      const probed = await probeProvisioning(row, identity, name)
      if (probed === null) return false
      candidates = probed
    }

    const scope = { workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, product: row.product }
    const active = await options.store.getActive(scope)
    const activeMatches = active && sameOwner(active, identity ?? row, product)
    const activeKeyId = activeMatches ? active.keyId : null
    const toRevoke = candidates
      .map((candidate) => candidate.id.trim())
      .filter((candidateId) => candidateId && candidateId !== activeKeyId)

    for (const keyId of toRevoke) {
      try {
        await recoveryProvisioner.revokeKey(keyId, slotOf({ ...row, name: name || row.name }))
      } catch (error) {
        const settled = await settleFailedRevoke(row, keyId, error)
        if (settled === 'gone') continue
        if (settled) return true
        await options.store.markRevocationPending({
          id: row.id,
          error: errorMessage(error, 'remote provisioning cleanup failed'),
          nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
          incrementAttempts: true,
        })
        return false
      }
    }

    if (candidates.length > 0) {
      await options.store.markRevoked(row.id, now())
    } else if (now().getTime() >= row.expiresAt.getTime() + ORPHAN_AFTER_EXPIRY_GRACE_MS) {
      // An empty lookup cannot prove no child exists, but any child this row's create made
      // carries this expiry and can no longer spend; retrying forever would block issuance.
      await options.store.markOrphaned(row.id, 'no remote child matched the durable provisioning record before its expiry')
    } else {
      await options.store.markRevocationPending({
        id: row.id,
        error: 'no remote child matched the durable provisioning record; retrying crash recovery',
        nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
        incrementAttempts: true,
      })
      return false
    }
    return true
  }

  async function reconcileProvisioning(identity: WorkspaceKeyIdentity): Promise<void> {
    const scope = scopeFor(identity, product)
    const rows = await options.store.listProvisioning(scope)
    for (const row of rows) {
      if (!(await cleanupProvisioning(row, identity))) {
        throw new Error('a previous workspace child-key cleanup is pending; issuance is blocked until it completes')
      }
    }
  }
  return { revokePending, markPending, cleanupProvisioning, reconcileProvisioning }
}

function createWorkspaceKeyMinter(
  options: DurableWorkspaceKeyManagerOptions,
  now: () => Date,
  keyLifetimeMs: ReturnType<typeof requirePositive>,
  product: string,
  markPending: ReturnType<typeof createWorkspaceKeyRecovery>['markPending'],
  cleanupProvisioning: ReturnType<typeof createWorkspaceKeyRecovery>['cleanupProvisioning'],
  revokePending: ReturnType<typeof createWorkspaceKeyRecovery>['revokePending'],
) {
  async function mint(
    identity: WorkspaceKeyIdentity,
    budgetUsd: number,
    spendThrough: boolean,
    onRemoteKey?: (row: DurableWorkspaceKeyProvisioningRecord, remoteId: string) => void,
  ): Promise<WorkspaceRuntimeKey> {
    await assertWorkspaceKeyCryptoUsable(options.crypto)
    const mintOperationId = operationId()
    const createdAt = now()
    const expiresAt = new Date(createdAt.getTime() + keyLifetimeMs)
    const named = (options.nameForIdentity?.(identity, mintOperationId) ?? defaultKeyName(identity, product, mintOperationId)).trim()
    if (!named) throw new Error('workspace child key remote name is required')
    const name = named.includes(mintOperationId) ? named : `${named}:${mintOperationId}`
    const rowId = operationId()
    const idempotencyKey = `workspace-key:${rowId}`
    const provisioningRow: DurableWorkspaceKeyProvisioningRecord = {
      id: rowId,
      workspaceId: identity.workspaceId,
      ownerUserId: identity.ownerUserId,
      product,
      platformUserId: identity.platformUserId,
      sourceKeyId: sourceKeyId(identity),
      sourceKeyFingerprint: identity.sourceKeyFingerprint,
      name,
      idempotencyKey,
      // Recovery replays this exact create, so the row keeps the requested budget and the placeholder marks spend-through.
      keyId: `provisioning:${mintOperationId}${spendThrough ? '+spend-through' : ''}:${name}`,
      keyEncrypted: '',
      budgetUsd,
      expiresAt,
      status: 'provisioning',
      revocationAttempts: 0,
      nextRevocationAt: null,
      lastRevocationError: null,
      createdAt,
    }
    await options.store.insertProvisioning(provisioningRow)

    let created: Awaited<ReturnType<DurableWorkspaceKeyProvisioner['createKey']>>
    try {
      created = await options.provisioner.createKey({
        name, product, budgetUsd, ...(spendThrough ? { spendThrough: true as const } : {}), expiresAt: expiresAt.toISOString(), idempotencyKey,
      })
    } catch (error) {
      // Keep cleanup running even when the state write fails. The remote
      // request may have committed before its response failed.
      try {
        await markPending(rowId, error, false)
      } catch {
        // cleanupProvisioning below can still find the remote name.
      }
      try {
        await cleanupProvisioning({ ...provisioningRow, status: 'revocation_pending' }, identity)
      } catch (cleanupError) {
        throw new Error('remote create failed and its cleanup could not be completed', { cause: cleanupError })
      }
      throw error
    }

    const remoteId = created.id?.trim() ?? ''
    const secret = created.key?.trim() ?? ''
    if (!remoteId || !secret) {
      if (remoteId) {
        try {
          await markProvisioningRemote(options.store, { id: rowId, keyId: remoteId })
        } catch {
          // revokePending uses the returned id even when this state write fails.
        }
      }
      try {
        await markPending(rowId, new Error('remote create returned no usable child key'), false)
      } catch {
        // Always attempt remote cleanup below.
      }
      const pendingRow = { ...provisioningRow, keyId: remoteId || provisioningRow.keyId, status: 'revocation_pending' as const }
      await revokePending(pendingRow, identity)
      throw new Error('remote create returned no usable child key')
    }

    let cleanupRow = provisioningRow
    onRemoteKey?.(cleanupRow, remoteId)

    async function retainRetiredCreatorCleanup(): Promise<void> {
      // A retired row cannot hold another pending transition. Persist the
      // returned child separately before revocation so a failed revoke survives restart.
      const retainedRow = { ...provisioningRow, id: operationId(), keyId: remoteId }
      try {
        await options.store.insertProvisioning(retainedRow)
      } catch (cause) {
        throw new Error('returned child cleanup record could not be persisted', { cause })
      }
      cleanupRow = retainedRow
      onRemoteKey?.(cleanupRow, remoteId)
    }

    try {
      const recorded = await markProvisioningRemote(options.store, { id: rowId, keyId: remoteId })
      if (!recorded) {
        await retainRetiredCreatorCleanup()
        throw new Error('workspace child-key provisioning row was retired before the remote id was recorded')
      }
      const keyEncrypted = await options.crypto.encrypt(secret)
      const remoteExpiresAt = created.expiresAt?.trim()
      const activeExpiresAt = remoteExpiresAt ? new Date(remoteExpiresAt) : expiresAt
      if (!Number.isFinite(activeExpiresAt.getTime())) throw new Error('remote child key expiry is malformed')
      // Spend-through (0) only when the provisioner confirms it; a provisioner that ignores the flag minted a sized child.
      const activeBudgetUsd = spendThrough && created.spendThrough === true ? 0 : created.budgetUsd ?? budgetUsd
      if (!Number.isFinite(activeBudgetUsd) || activeBudgetUsd < 0) throw new Error('remote child key budget is malformed')
      const activated = await markActive(options.store, {
        id: rowId,
        keyId: remoteId,
        keyEncrypted,
        expiresAt: activeExpiresAt,
        budgetUsd: activeBudgetUsd,
      })
      if (!activated) {
        await retainRetiredCreatorCleanup()
        throw new Error('workspace child-key provisioning row was retired before activation')
      }
    } catch (error) {
      // A persistence failure must not strand the already-created remote key.
      try {
        await markPending(cleanupRow.id, error, false)
      } catch {
        // revokePending below still has the remote id and attempts cleanup.
      }
      await revokePending({ ...cleanupRow, keyId: remoteId, status: 'revocation_pending' }, identity)
      throw error
    }

    const row = await options.store.getActive(scopeFor(identity, product))
    if (!row || row.keyId !== remoteId || !sameIdentity(row, identity, product)) {
      const error = new Error('workspace child key was not persisted as active')
      try {
        await options.store.markRevocationPending({
          id: rowId,
          error: error.message,
          nextAttemptAt: now(),
          incrementAttempts: false,
        })
      } catch {
        // The remote id is still available for the cleanup attempt below.
      }
      await revokePending({ ...provisioningRow, keyId: remoteId, status: 'revocation_pending' }, identity)
      throw error
    }
    const usage = usageFromRemote(row, {
      budgetUsd: created.budgetUsd, budgetSpent: 0, budgetRemaining: budgetUsd, expiresAt: created.expiresAt ?? expiresAt.toISOString(),
    }, now())
    return { key: secret, usage, refreshed: true }
  }
  return { mint }
}
