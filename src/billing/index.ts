/**
 * Per-workspace budget-capped model keys — app-owned billing, metered on Tangle.
 *
 * Each workspace (the paying entity) runs the agent on its OWN child API key
 * minted from the platform parent key. The child carries a hard USD budget the
 * Tangle Router enforces AT THE KEY — model spend can't exceed the allowance,
 * zero app-side accounting. The app charges its own subscription (e.g. 5× the
 * allowance) and re-provisions each period. Child budgets are IMMUTABLE on the
 * platform, so a new budget = a fresh key + revoke the prior (rotate).
 *
 * The mint / rotate / rollover / usage LOGIC is generic and lives here.
 * Persistence (which D1 table), secret encryption, and key provisioning are
 * SEAMS each product supplies — so this module imports no DB and no key-mgmt
 * SDK (structural contracts only, like `../tangle`). The `@tangle-network/tcloud`
 * SDK is the provisioner a product passes in; it is not a dependency here.
 */

/** The key-provisioning operations this needs — the `@tangle-network/tcloud`
 *  SDK's `TCloudClient` satisfies it structurally; pass it in. */
export interface KeyProvisioner {
  createKey(input: { name: string; product: string; budgetUsd: number; expiresAt: string }): Promise<{ id?: string; key?: string }>
  revokeKey(keyId: string): Promise<unknown>
  getKey(keyId: string): Promise<{ budgetUsd?: number; budgetSpent?: number; expiresAt?: string | null }>
}

/** A stored child-key record (the app's row, shape-normalized). */
export interface WorkspaceKeyRecord {
  /** App row id (opaque). */
  id: string
  keyId: string
  /** The encrypted secret — decrypted via {@link KeyCrypto.decrypt}. */
  keyEncrypted: string
  budgetUsd: number
  expiresAt: Date | null
}

/** Persistence seam — the product implements this against its own D1 table. */
export interface WorkspaceKeyStore {
  /** Most-recent active key for the workspace, or null. */
  getActive(workspaceId: string): Promise<WorkspaceKeyRecord | null>
  /** All active keys (to revoke priors on rotate). */
  listActive(workspaceId: string): Promise<Array<{ id: string; keyId: string }>>
  /** Persist a freshly minted active key. */
  insert(record: { workspaceId: string; keyId: string; keyEncrypted: string; budgetUsd: number; expiresAt: Date }): Promise<void>
  /** Mark a prior row revoked. */
  markRevoked(id: string, now: Date): Promise<void>
}

/** Secret encryption seam (the app's at-rest crypto). */
export interface KeyCrypto {
  encrypt(secret: string): Promise<string>
  decrypt(encrypted: string): Promise<string>
}

export interface WorkspaceKeyManagerOptions {
  provisioner: KeyProvisioner
  store: WorkspaceKeyStore
  crypto: KeyCrypto
  /** Default monthly allowance (USD) when a call doesn't specify one. */
  defaultBudgetUsd: number
  /** Injectable clock. Default `() => new Date()`. */
  now?: () => Date
  /** tcloud product the key is scoped to. Default `'router'`. */
  product?: string
}

export interface WorkspaceModelKeyUsage {
  keyId: string
  budgetUsd: number
  budgetSpent: number
  budgetRemaining: number
  expiresAt: string | null
  exhausted: boolean
}

export interface WorkspaceKeyManager {
  /** The workspace's active child-key secret, provisioning one if absent/expired. */
  ensureKey(workspaceId: string, opts?: { budgetUsd?: number }): Promise<string>
  /** Mint a fresh key + revoke priors (period renewal / top-up). `rollover`
   *  carries the prior key's unused budget into the new one, bounded by
   *  `rolloverCapUsd`. Returns the new secret. */
  rotateKey(workspaceId: string, opts?: { budgetUsd?: number; rollover?: boolean; rolloverCapUsd?: number }): Promise<string>
  /** Live budget usage for the active key (drives the "$X of $Y used" panel). */
  getUsage(workspaceId: string): Promise<WorkspaceModelKeyUsage | null>
}

/** Period end = first day of next month, midnight UTC. Keys expire at the period
 *  boundary so a forgotten rotation fails closed rather than running free. */
function nextPeriodEnd(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

export function createWorkspaceKeyManager(opts: WorkspaceKeyManagerOptions): WorkspaceKeyManager {
  const clock = opts.now ?? (() => new Date())
  const product = opts.product ?? 'router'

  const getUsage: WorkspaceKeyManager['getUsage'] = async (workspaceId) => {
    const active = await opts.store.getActive(workspaceId)
    if (!active) return null
    const info = await opts.provisioner.getKey(active.keyId)
    const budgetUsd = info.budgetUsd ?? active.budgetUsd
    const budgetSpent = info.budgetSpent ?? 0
    const budgetRemaining = Math.max(0, budgetUsd - budgetSpent)
    return {
      keyId: active.keyId,
      budgetUsd,
      budgetSpent,
      budgetRemaining,
      expiresAt: info.expiresAt ?? (active.expiresAt ? active.expiresAt.toISOString() : null),
      exhausted: budgetRemaining <= 0,
    }
  }

  const rotateKey: WorkspaceKeyManager['rotateKey'] = async (workspaceId, ropts) => {
    const now = clock()
    const allowance = ropts?.budgetUsd ?? opts.defaultBudgetUsd

    let budgetUsd = allowance
    if (ropts?.rollover) {
      const prior = await getUsage(workspaceId).catch(() => null)
      budgetUsd = allowance + (prior?.budgetRemaining ?? 0)
      if (ropts.rolloverCapUsd != null) budgetUsd = Math.min(budgetUsd, ropts.rolloverCapUsd)
    }

    const expiresAt = nextPeriodEnd(now)
    const created = await opts.provisioner.createKey({ name: `ws:${workspaceId}`, product, budgetUsd, expiresAt: expiresAt.toISOString() })
    if (!created.key || !created.id) throw new Error('tcloud createKey returned no key')
    const keyEncrypted = await opts.crypto.encrypt(created.key)

    const priors = await opts.store.listActive(workspaceId)
    await opts.store.insert({ workspaceId, keyId: created.id, keyEncrypted, budgetUsd, expiresAt })
    for (const p of priors) {
      await opts.store.markRevoked(p.id, now)
      // Best-effort upstream revoke — the row is already revoked and an expired
      // key fails closed regardless, so a transient error is non-fatal.
      try {
        await opts.provisioner.revokeKey(p.keyId)
      } catch {
        /* non-fatal */
      }
    }
    return created.key
  }

  const ensureKey: WorkspaceKeyManager['ensureKey'] = async (workspaceId, eopts) => {
    const now = clock()
    const active = await opts.store.getActive(workspaceId)
    if (active && (!active.expiresAt || active.expiresAt.getTime() > now.getTime())) {
      return opts.crypto.decrypt(active.keyEncrypted)
    }
    return rotateKey(workspaceId, { budgetUsd: eopts?.budgetUsd })
  }

  return { ensureKey, rotateKey, getUsage }
}
