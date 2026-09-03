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
  /** The persisted name used to recover a remote create after a crash. Null only for pre-name rows. */
  name: string | null
  /** The persisted retry identity for the remote create. Null only for pre-identity rows. */
  idempotencyKey: string | null
  keyId: string
  keyEncrypted: string
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

type DurableWorkspaceKeyCreateResult = Awaited<ReturnType<KeyProvisioner['createKey']>> & {
  budgetUsd?: number | null
  budgetRemaining?: number
  expiresAt?: string | null
}

/** The exact request identity that must be reused when recovering a create. */
export interface DurableWorkspaceKeyCreateInput {
  name: string
  product: string
  budgetUsd: number
  expiresAt: string
  /** Stable across process restarts for one persisted provisioning row. */
  idempotencyKey: string
}

/** The remote operations required by the durable manager. */
export interface DurableWorkspaceKeyProvisioner {
  /**
   * Create one child key. Reusing `idempotencyKey` must be safe for the same
   * request body. Providers without native idempotency still get crash-safe
   * cleanup because the manager persists and searches the stable name.
   */
  createKey(input: DurableWorkspaceKeyCreateInput): Promise<DurableWorkspaceKeyCreateResult>
  getKey(id: string): Promise<{
    budgetUsd?: number | null
    budgetSpent?: number
    expiresAt?: string | null
  }>
  revokeKey: KeyProvisioner['revokeKey']
  /** Find remote keys for a specific persisted provisioning attempt. */
  findCreatedKeys(input: {
    name: string
    product: string
    sourceKeyId?: string | null
  }): Promise<Array<{ id: string }>>
}

/** Persistence operations for identity-bound key lifecycle state. */
export interface DurableWorkspaceKeyStore {
  /** Return the active row for this exact product scope. */
  getActive(scope: DurableWorkspaceKeyScope): Promise<DurableWorkspaceKeyRecord | null>
  /** Return every unfinished provisioning row for this exact product scope. */
  listProvisioning(scope: DurableWorkspaceKeyScope): Promise<DurableWorkspaceKeyProvisioningRecord[]>
  /** Insert before the remote create so a crashed create can be recovered. */
  insertProvisioning(record: DurableWorkspaceKeyProvisioningRecord): Promise<void>
  /** Save the remote id only while the row remains in provisioning state. */
  markProvisioningRemote(input: { id: string; keyId: string }): Promise<void>
  /** Promote a fully encrypted row only from provisioning state. */
  markActive(input: {
    id: string
    keyId: string
    keyEncrypted: string
    expiresAt: Date
    budgetUsd: number
  }): Promise<void>
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
  /** Reuse a matching active key or reconcile and mint one under a lease. */
  ensureKey(identity: WorkspaceKeyIdentity, options?: { budgetUsd?: number }): Promise<WorkspaceRuntimeKey>
  /** Read usage without returning the child secret. */
  getUsage(identity: WorkspaceKeyIdentity): Promise<WorkspaceKeyUsage | null>
  /** Retry due cleanup rows. A supplied owner/workspace limits the retry to its scope. */
  retryPendingRevocations(scope?: Pick<WorkspaceKeyIdentity, 'ownerUserId' | 'workspaceId'>): Promise<number>
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
  /** Stable remote name. The operation id makes the default crash-safe. */
  nameForIdentity?: (identity: WorkspaceKeyIdentity, operationId: string) => string
  /** Resolve names for rows written before `name` became durable. Null blocks issuance safely. */
  legacyNameForRecord?: (record: DurableWorkspaceKeyRecord) => string | null | undefined
  /** Recognize a missing remote key without depending on a provider SDK. */
  isRemoteMissing?: (error: unknown) => boolean
}

const DEFAULT_KEY_LIFETIME_MS = 55 * 60_000
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_LEASE_WAIT_MS = 15_000
const DEFAULT_LEASE_POLL_MS = 50
const DEFAULT_LEASE_RENEW_INTERVAL_MS = Math.floor(DEFAULT_LEASE_MS / 3)
const DEFAULT_REVOCATION_RETRY_BASE_MS = 2_000
const DEFAULT_REVOCATION_RETRY_MAX_MS = 60_000
const PENDING_REVOCATION_BATCH_SIZE = 20

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

function sameRowIdentity(a: DurableWorkspaceKeyRecord, b: DurableWorkspaceKeyRecord): boolean {
  return a.workspaceId === b.workspaceId
    && a.ownerUserId === b.ownerUserId
    && a.product === b.product
    && a.platformUserId === b.platformUserId
    && a.sourceKeyId === b.sourceKeyId
    && a.sourceKeyFingerprint === b.sourceKeyFingerprint
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

function idempotencyKeyForRecord(row: Pick<DurableWorkspaceKeyRecord, 'id' | 'idempotencyKey'>): string {
  const value = row.idempotencyKey?.trim()
  return value || `workspace-key:${row.id}`
}

function usageFromRemote(
  row: DurableWorkspaceKeyRecord,
  remote: Awaited<ReturnType<DurableWorkspaceKeyProvisioner['getKey']>>,
  now: Date,
): WorkspaceKeyUsage {
  const budgetUsd = remote.budgetUsd ?? row.budgetUsd
  const budgetSpent = remote.budgetSpent ?? 0
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error('workspace child key budget is malformed')
  if (!Number.isFinite(budgetSpent) || budgetSpent < 0) throw new Error('workspace child key usage is malformed')
  const expiresAt = remote.expiresAt ?? row.expiresAt.toISOString()
  const expiryMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiryMs)) throw new Error('workspace child key expiry is malformed')
  const budgetRemaining = Math.max(0, budgetUsd - budgetSpent)
  return {
    keyId: row.keyId,
    budgetUsd,
    budgetSpent,
    budgetRemaining,
    expiresAt,
    exhausted: budgetRemaining <= 0 || expiryMs <= now.getTime(),
  }
}

function defaultRemoteMissing(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown } | null
  return value?.status === 404 || value?.code === 'not_found'
}

/**
 * Create a product-neutral manager for child-key issuance and cleanup.
 *
 * The provisioner must already be authenticated for the current source
 * credential. The manager persists only the source id and its non-secret
 * fingerprint, then refuses to reuse a row from another identity.
 */
export function createIdentityBoundWorkspaceKeyManager(
  options: DurableWorkspaceKeyManagerOptions,
): DurableWorkspaceKeyManager {
  const product = options.product.trim()
  if (!product) throw new Error('workspace child key product is required')
  const defaultBudgetUsd = requirePositive(options.defaultBudgetUsd, 'defaultBudgetUsd')
  const keyLifetimeMs = requirePositive(options.keyLifetimeMs ?? DEFAULT_KEY_LIFETIME_MS, 'keyLifetimeMs')
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
  const localLocks = new Map<string, Promise<void>>()

  async function withLocalLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const previous = localLocks.get(scope) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    localLocks.set(scope, current)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (localLocks.get(scope) === current) localLocks.delete(scope)
    }
  }

  async function withDurableLease<T>(
    scope: string,
    work: () => Promise<T>,
    onLeaseLost?: () => Promise<void>,
  ): Promise<T> {
    const leaseOperationId = operationId()
    const startedAt = Date.now()
    let acquired = false
    while (!acquired && Date.now() - startedAt <= leaseWaitMs) {
      acquired = await options.store.acquireLease(scope, leaseOperationId, now(), leaseMs)
      if (!acquired) await sleep(leasePollMs)
    }
    if (!acquired) throw new Error('workspace child-key issuance is busy; retry the request')

    let stopped = false
    let leaseLost: Error | null = null
    let leaseTimer: ReturnType<typeof setTimeout> | undefined
    let renewalPromise: Promise<void> | undefined
    const scheduleRenewal = () => {
      if (stopped || leaseLost) return
      leaseTimer = setTimeout(() => {
        leaseTimer = undefined
        const renewal = (async () => {
          try {
            if (!await options.store.renewLease(scope, leaseOperationId, now(), leaseMs)) {
              leaseLost = new Error('workspace child-key lease was lost during reconciliation')
              return
            }
            scheduleRenewal()
          } catch (error) {
            leaseLost = error instanceof Error ? error : new Error('workspace child-key lease renewal failed')
          }
        })()
        renewalPromise = renewal
        void renewal.finally(() => {
          if (renewalPromise === renewal) renewalPromise = undefined
        }).catch(() => undefined)
      }, leaseRenewIntervalMs)
    }
    scheduleRenewal()

    let workError: unknown
    let leaseLossCleanupError: unknown
    try {
      const result = await work()
      if (leaseLost) throw leaseLost
      return result
    } catch (error) {
      workError = error
      throw error
    } finally {
      stopped = true
      if (leaseTimer) clearTimeout(leaseTimer)
      if (renewalPromise) await renewalPromise
      if (leaseLost && onLeaseLost) {
        try {
          await onLeaseLost()
        } catch (error) {
          leaseLossCleanupError = error
        }
      }
      try {
        await options.store.releaseLease(scope, leaseOperationId)
      } catch (error) {
        if (workError === undefined) throw error
      }
      if (workError === undefined && leaseLossCleanupError) {
        throw new Error('workspace child-key lease was lost and cleanup failed', { cause: leaseLossCleanupError })
      }
      if (workError === undefined && leaseLost) throw leaseLost
    }
  }

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
      await recoveryProvisioner.revokeKey(row.keyId)
      await options.store.markRevoked(row.id, now())
      return true
    } catch (error) {
      if (isRemoteMissing(error)) {
        await options.store.markRevoked(row.id, now())
        return true
      }
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
    const name = row.name?.trim() || options.legacyNameForRecord?.(row)?.trim()
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
    if (!identity || !sameIdentity(row, identity, product)) return []
    try {
      const created = await options.provisioner.createKey({
        name,
        product: row.product,
        budgetUsd: row.budgetUsd,
        expiresAt: row.expiresAt.toISOString(),
        idempotencyKey: idempotencyKeyForRecord(row),
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
    return (await provisioningCandidates({ ...row, name, keyId: `provisioning:${idempotencyKeyForRecord(row)}` }))?.candidates ?? []
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
    const activeMatches = active && (identity ? sameIdentity(active, identity, product) : sameRowIdentity(active, row))
    const activeKeyId = activeMatches ? active.keyId : null
    const toRevoke = candidates
      .map((candidate) => candidate.id.trim())
      .filter((candidateId) => candidateId && candidateId !== activeKeyId)

    for (const keyId of toRevoke) {
      try {
        await recoveryProvisioner.revokeKey(keyId)
      } catch (error) {
        if (isRemoteMissing(error)) continue
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
      && row.ownerUserId === identity.ownerUserId)) {
      throw new Error('a previous workspace child-key cleanup is pending; issuance is blocked until it completes')
    }
  }

  async function retryPendingRevocations(scopeInput?: Pick<WorkspaceKeyIdentity, 'ownerUserId' | 'workspaceId'>): Promise<number> {
    if (scopeInput) {
      const workspaceId = scopeInput.workspaceId.trim()
      const ownerUserId = scopeInput.ownerUserId.trim()
      if (!workspaceId || !ownerUserId) throw new Error('workspace child key retry scope is incomplete')
      const scope = scopeKey({ workspaceId, ownerUserId, product })
      return withLocalLock(scope, () => withDurableLease(scope, async () => (
        await retryPendingRevocationsUnlocked({ workspaceId, ownerUserId })).completed))
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
    if (!sameIdentity(row, identity, product)) {
      await options.store.markRevocationPending({
        id: row.id,
        error: 'active child key identity does not match the authenticated owner and source',
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

  async function mint(
    identity: WorkspaceKeyIdentity,
    budgetUsd: number,
    onRemoteKey?: (row: DurableWorkspaceKeyProvisioningRecord, remoteId: string) => void,
  ): Promise<WorkspaceRuntimeKey> {
    await assertWorkspaceKeyCryptoUsable(options.crypto)
    const mintOperationId = operationId()
    const createdAt = now()
    const expiresAt = new Date(createdAt.getTime() + keyLifetimeMs)
    const name = (options.nameForIdentity?.(identity, mintOperationId) ?? defaultKeyName(identity, product, mintOperationId)).trim()
    if (!name) throw new Error('workspace child key remote name is required')
    const rowId = operationId()
    const provisioningRow: DurableWorkspaceKeyProvisioningRecord = {
      id: rowId,
      workspaceId: identity.workspaceId,
      ownerUserId: identity.ownerUserId,
      product,
      platformUserId: identity.platformUserId,
      sourceKeyId: sourceKeyId(identity),
      sourceKeyFingerprint: identity.sourceKeyFingerprint,
      name,
      idempotencyKey: `workspace-key:${rowId}`,
      keyId: `provisioning:${mintOperationId}`,
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
        name,
        product,
        budgetUsd,
        expiresAt: expiresAt.toISOString(),
        idempotencyKey: idempotencyKeyForRecord(provisioningRow),
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
          await options.store.markProvisioningRemote({ id: rowId, keyId: remoteId })
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

    onRemoteKey?.(provisioningRow, remoteId)

    try {
      await options.store.markProvisioningRemote({ id: rowId, keyId: remoteId })
      const keyEncrypted = await options.crypto.encrypt(secret)
      const remoteExpiresAt = created.expiresAt?.trim()
      const activeExpiresAt = remoteExpiresAt ? new Date(remoteExpiresAt) : expiresAt
      if (!Number.isFinite(activeExpiresAt.getTime())) throw new Error('remote child key expiry is malformed')
      const activeBudgetUsd = created.budgetUsd ?? budgetUsd
      if (!Number.isFinite(activeBudgetUsd) || activeBudgetUsd < 0) throw new Error('remote child key budget is malformed')
      await options.store.markActive({
        id: rowId,
        keyId: remoteId,
        keyEncrypted,
        expiresAt: activeExpiresAt,
        budgetUsd: activeBudgetUsd,
      })
    } catch (error) {
      // A persistence failure must not strand the already-created remote key.
      try {
        await markPending(rowId, error, false)
      } catch {
        // revokePending below still has the remote id and attempts cleanup.
      }
      await revokePending({ ...provisioningRow, keyId: remoteId, status: 'revocation_pending' }, identity)
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
      budgetUsd: created.budgetUsd,
      budgetSpent: 0,
      expiresAt: created.expiresAt ?? expiresAt.toISOString(),
    }, now())
    return { key: secret, usage, refreshed: true }
  }

  async function ensureKey(identityInput: WorkspaceKeyIdentity, keyOptions?: { budgetUsd?: number }): Promise<WorkspaceRuntimeKey> {
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
        return { key, usage: active.usage, refreshed: false }
      }
      const finalCleanup = await retryPendingRevocationsUnlocked(identity, identity)
      if (finalCleanup.pending > 0) throw new Error('a previous workspace child-key cleanup is pending; issuance is blocked until it completes')
      await assertNoPendingRevocations(identity)
      return mint(identity, budgetUsd, (row, remoteId) => {
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
