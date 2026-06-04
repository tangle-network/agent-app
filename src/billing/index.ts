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

/** The key-provisioning operations the key manager needs. Wire it from the
 *  platform via {@link createTcloudKeyProvisioner} rather than casting. */
export interface KeyProvisioner {
  createKey(input: { name: string; product: string; budgetUsd: number; expiresAt: string }): Promise<{ id?: string; key?: string }>
  revokeKey(keyId: string): Promise<unknown>
  getKey(keyId: string): Promise<{ budgetUsd?: number; budgetSpent?: number; expiresAt?: string | null }>
}

/**
 * The subset of the `@tangle-network/tcloud` `TCloudClient` the provisioner uses
 * — declared with METHOD syntax so the real client (whose `product` is a narrow
 * union and whose budgets are `number | null`) is assignable bivariantly. The
 * real SDK client satisfies this; pass it straight in.
 */
export interface TcloudKeyClient {
  createKey(opts: {
    name: string
    product?: string
    budgetUsd?: number
    expiresAt?: string
    parentKeyId?: string
    allowedModels?: string[]
    rpmLimit?: number
  }): Promise<{ id: string; key: string }>
  getKey(id: string): Promise<{ budgetUsd?: number | null; budgetSpent?: number; expiresAt?: string | null }>
  revokeKey(id: string): Promise<unknown>
}

/**
 * Adapt the tcloud SDK client to {@link KeyProvisioner} — the typed seam that
 * replaces the `as unknown as KeyProvisioner` cast every consumer otherwise
 * repeats. The platform already exposes child-key minting (parent→child key,
 * per-key USD budget, expiry); this maps its shapes (`product` union,
 * `number | null` budgets) onto the manager's contract (`null → undefined`).
 */
export function createTcloudKeyProvisioner(client: TcloudKeyClient): KeyProvisioner {
  return {
    createKey: async (input) => {
      const created = await client.createKey(input)
      return { id: created.id, key: created.key }
    },
    revokeKey: (keyId) => client.revokeKey(keyId),
    getKey: async (keyId) => {
      const info = await client.getKey(keyId)
      return {
        budgetUsd: info.budgetUsd ?? undefined,
        budgetSpent: info.budgetSpent ?? undefined,
        expiresAt: info.expiresAt ?? null,
      }
    },
  }
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

// ---------------------------------------------------------------------------
// Shared-platform-balance billing
//
// A DIFFERENT model from the per-workspace child-key manager above: here every
// user runs against a SHARED platform balance (id.tangle.tools), keyed by the
// user's platform identity. The app owns no key minting — it reads the balance,
// gates a billable turn, and deducts spend through the platform billing API.
// Plan limits, the platform transport, and identity resolution are SEAMS the
// product supplies; this module imports no DB and no HTTP client.
// ---------------------------------------------------------------------------

/** A user's resolved platform identity (from the app's SSO account store). */
export interface PlatformIdentity {
  platformUserId: string
  /** The user's per-user platform API key (reads), or null when unlinked. */
  apiKey: string | null
}

/** Spendable balance for a platform user. */
export interface PlatformBalanceInfo {
  balance: number
  lifetimeSpent: number
}

/** Per-product spend aggregate. */
export interface PlatformProductUsage {
  product: string | null
  totalSpent: number
  count: number
}

/** Plan limits — a PARAMETER per product (dollar allowance, concurrency,
 *  overage policy). Never baked into the framework. */
export interface PlanLimit {
  monthlyBalanceUsd: number
  concurrency: number
  overageAllowed: boolean
}

/**
 * The platform billing transport — the product wires these to id.tangle.tools
 * (or any balance backend). Reads authenticate as the user (their `apiKey`);
 * the deduct write is a service-token call naming the target user. This module
 * never touches HTTP — it only sequences these calls.
 */
export interface PlatformBillingClient<Plan extends string> {
  /** Resolve the user's platform identity, or null when there is no SSO account. */
  resolveIdentity(userId: string): Promise<PlatformIdentity | null>
  /** Subscription plan for the user (via their platform key). */
  getPlan(apiKey: string): Promise<Plan>
  /** Spendable balance for the user (via their platform key). */
  getBalance(apiKey: string): Promise<PlatformBalanceInfo>
  /** Per-product usage rows for the user (via their platform key). */
  getUsageByProduct(apiKey: string): Promise<PlatformProductUsage[]>
  /** Deduct spend against the user's balance (service-token write). */
  deduct(input: { platformUserId: string; amountUsd: number; type: string; description: string; referenceId: string }): Promise<void>
}

export interface SharedBillingState<Plan extends string> {
  /** Platform user id, or null when the user has no Tangle SSO account. */
  platformUserId: string | null
  plan: Plan
  monthlyBalanceUsd: number
  remainingBalanceUsd: number
  lifetimeSpentUsd: number
  concurrency: number
  overageAllowed: boolean
}

export interface PlatformBalanceManagerOptions<Plan extends string> {
  client: PlatformBillingClient<Plan>
  /** Plan → limits map (the product's pricing). */
  planLimits: Record<Plan, PlanLimit>
  /** The plan an unlinked / outage user falls to (fails CLOSED). */
  freePlan: Plan
  /** The product slug to attribute usage to (for `getProductUsage`). */
  productSlug: string
}

export interface PlatformBalanceManager<Plan extends string> {
  /** Resolve the user's plan + balance. Unlinked or platform-outage users fail
   *  CLOSED: free plan, zero remaining balance — a billable run is never started
   *  against an unknown balance. */
  getState(userId: string): Promise<SharedBillingState<Plan>>
  /** Gate a billable turn: allowed when the plan permits overage or remaining
   *  balance is positive. Returns the state so the caller deducts against it. */
  canStartBillableTurn(userId: string): Promise<{ allowed: boolean; state: SharedBillingState<Plan> }>
  /** Deduct `amountUsd` against the user's platform balance. Throws when the
   *  user is not platform-linked. */
  deduct(userId: string, params: { amountUsd: number; type: string; description: string; referenceId: string }): Promise<void>
  /** This product's spend for the user (drives a usage panel). */
  getProductUsage(userId: string): Promise<{ spentUsd: number; transactionCount: number }>
}

export function createPlatformBalanceManager<Plan extends string>(
  opts: PlatformBalanceManagerOptions<Plan>,
): PlatformBalanceManager<Plan> {
  const { client, planLimits, freePlan, productSlug } = opts

  const getState: PlatformBalanceManager<Plan>['getState'] = async (userId) => {
    const identity = await client.resolveIdentity(userId)
    // No SSO account, or linked without a platform key: unlinked free tier with
    // zero balance. Reads require the user's key — never call them empty.
    if (!identity || !identity.apiKey) {
      const limits = planLimits[freePlan]
      return {
        platformUserId: identity?.platformUserId ?? null,
        plan: freePlan,
        monthlyBalanceUsd: limits.monthlyBalanceUsd,
        remainingBalanceUsd: 0,
        lifetimeSpentUsd: 0,
        concurrency: limits.concurrency,
        overageAllowed: limits.overageAllowed,
      }
    }
    const [plan, balance] = await Promise.all([client.getPlan(identity.apiKey), client.getBalance(identity.apiKey)])
    const limits = planLimits[plan]
    return {
      platformUserId: identity.platformUserId,
      plan,
      monthlyBalanceUsd: limits.monthlyBalanceUsd,
      remainingBalanceUsd: balance.balance,
      lifetimeSpentUsd: balance.lifetimeSpent,
      concurrency: limits.concurrency,
      overageAllowed: limits.overageAllowed,
    }
  }

  const canStartBillableTurn: PlatformBalanceManager<Plan>['canStartBillableTurn'] = async (userId) => {
    const state = await getState(userId)
    if (!state.platformUserId) return { allowed: false, state }
    const allowed = state.overageAllowed || state.remainingBalanceUsd > 0
    return { allowed, state }
  }

  const deduct: PlatformBalanceManager<Plan>['deduct'] = async (userId, params) => {
    const identity = await client.resolveIdentity(userId)
    if (!identity) throw new Error('Shared billing requires a platform-linked user')
    await client.deduct({
      platformUserId: identity.platformUserId,
      amountUsd: params.amountUsd,
      type: params.type,
      description: params.description,
      referenceId: params.referenceId,
    })
  }

  const getProductUsage: PlatformBalanceManager<Plan>['getProductUsage'] = async (userId) => {
    const identity = await client.resolveIdentity(userId)
    if (!identity?.apiKey) return { spentUsd: 0, transactionCount: 0 }
    const rows = await client.getUsageByProduct(identity.apiKey)
    const product = rows.find((row) => row.product === productSlug)
    return { spentUsd: product?.totalSpent ?? 0, transactionCount: product?.count ?? 0 }
  }

  return { getState, canStartBillableTurn, deduct, getProductUsage }
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
