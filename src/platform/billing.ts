/**
 * Platform billing HTTP transport + tier state for apps on the shared
 * Tangle balance model (id.tangle.tools). Reads authenticate as the user via
 * their per-user platform key (the platform resolves the caller from the
 * key; service or impersonation headers on read routes are rejected). The
 * deduct write authenticates as the product service (`Bearer <serviceToken>`
 * + `X-Service-Name`) and names the target user in the body. Also provides a
 * fetch-backed implementation of the `/billing` module's
 * `PlatformBillingClient` seam (type-only import — no runtime coupling).
 */

import type { PlatformBillingClient, PlatformIdentity } from '../billing/index'

export type TanglePlanTier = 'free' | 'pro' | 'enterprise'

/** 'pro' | 'enterprise' pass through; anything else (null, unknown) → 'free'. */
export function normalizeTanglePlanTier(plan: string | null | undefined): TanglePlanTier {
  return plan === 'pro' || plan === 'enterprise' ? plan : 'free'
}

export class PlatformBillingHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Platform request failed (${status}): ${detail}`)
    this.name = 'PlatformBillingHttpError'
  }
}

/** Structural guard (name + numeric status) — robust across module instances. */
export function isPlatformBillingHttpError(error: unknown): error is PlatformBillingHttpError {
  return (
    error instanceof Error &&
    error.name === 'PlatformBillingHttpError' &&
    typeof (error as { status?: unknown }).status === 'number'
  )
}

export interface PlatformBillingHttpOptions {
  /** Platform root, e.g. https://id.tangle.tools (trailing slashes stripped). */
  baseUrl: string
  /** Used only by `deduct()`; resolved lazily so reads never require it.
   *  Throws at call time when empty. */
  serviceToken: string | (() => string)
  /** Product slug — the `X-Service-Name` header and the deduct `product` field. */
  productSlug: string
  fetchImpl?: typeof fetch
  /** Default 10 000. */
  timeoutMs?: number
}

export interface PlatformSubscriptionInfo {
  tier: TanglePlanTier
  status: string | null
}

export interface PlatformBalanceSnapshot {
  balance: number
  lifetimeSpent: number
  updatedAt?: string
}

export interface PlatformUsageProductRow {
  product: string | null
  totalSpent: number
  count: number
}

export interface PlatformBillingHttp {
  /** GET /v1/plans/current (user bearer). */
  getSubscription(userApiKey: string): Promise<PlatformSubscriptionInfo>
  /** GET /v1/billing/balance (user bearer). */
  getBalance(userApiKey: string): Promise<PlatformBalanceSnapshot>
  /** GET /v1/billing/usage (user bearer). */
  getUsageByProduct(userApiKey: string): Promise<PlatformUsageProductRow[]>
  /** POST /v1/billing/deduct (service token). */
  deduct(input: {
    platformUserId: string
    amountUsd: number
    type: string
    description: string
    referenceId: string
  }): Promise<void>
  /** Absolute URL of the platform's billing-management surface. */
  billingUrl(): string
}

export function createPlatformBillingHttp(opts: PlatformBillingHttpOptions): PlatformBillingHttp {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  if (!baseUrl) throw new Error('PlatformBillingHttpOptions.baseUrl is required')
  if (!opts.productSlug) throw new Error('PlatformBillingHttpOptions.productSlug is required')
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000

  function resolveServiceToken(): string {
    const token = typeof opts.serviceToken === 'function' ? opts.serviceToken() : opts.serviceToken
    if (!token) throw new Error('A platform service token is required for deduct')
    return token
  }

  async function request<T>(path: string, init: RequestInit, headers: Headers): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new PlatformBillingHttpError(res.status, body?.error?.message ?? res.statusText)
    }
    return res.json() as Promise<T>
  }

  function userRead<T>(userApiKey: string, path: string): Promise<T> {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${userApiKey}`)
    return request<T>(path, {}, headers)
  }

  return {
    async getSubscription(userApiKey) {
      const body = await userRead<{
        success: boolean
        data?: { subscription?: { plan?: string | null; status?: string | null } | null }
      }>(userApiKey, '/v1/plans/current')
      const sub = body.data?.subscription ?? null
      return { tier: normalizeTanglePlanTier(sub?.plan), status: sub?.status ?? null }
    },

    async getBalance(userApiKey) {
      const body = await userRead<{
        success: boolean
        data?: { balance?: number; lifetimeSpent?: number; updatedAt?: string }
      }>(userApiKey, '/v1/billing/balance')
      return {
        balance: body.data?.balance ?? 0,
        lifetimeSpent: body.data?.lifetimeSpent ?? 0,
        updatedAt: body.data?.updatedAt,
      }
    },

    async getUsageByProduct(userApiKey) {
      const body = await userRead<{
        success: boolean
        data?: Array<{ product?: string | null; totalSpent?: number; count?: number }>
      }>(userApiKey, '/v1/billing/usage')
      return (body.data ?? []).map((row) => ({
        product: row.product ?? null,
        totalSpent: row.totalSpent ?? 0,
        count: row.count ?? 0,
      }))
    },

    async deduct(input) {
      const headers = new Headers()
      headers.set('Authorization', `Bearer ${resolveServiceToken()}`)
      headers.set('X-Service-Name', opts.productSlug)
      headers.set('Content-Type', 'application/json')
      await request('/v1/billing/deduct', {
        method: 'POST',
        body: JSON.stringify({
          userId: input.platformUserId,
          amount: input.amountUsd,
          type: input.type,
          product: opts.productSlug,
          description: input.description,
          referenceId: input.referenceId,
        }),
      }, headers)
    },

    billingUrl() {
      return `${baseUrl}/app/billing`
    },
  }
}

// ── Tier policy + composed state ────────────────────────────────────────────

export interface TangleTierPolicy {
  concurrency: number
  overageAllowed: boolean
}

export const DEFAULT_TANGLE_TIER_POLICY: Record<TanglePlanTier, TangleTierPolicy> = {
  free: { concurrency: 1, overageAllowed: false },
  pro: { concurrency: Number.POSITIVE_INFINITY, overageAllowed: true },
  enterprise: { concurrency: Number.POSITIVE_INFINITY, overageAllowed: true },
}

export interface TangleTierState {
  tier: TanglePlanTier
  subscriptionStatus: string | null
  remainingBalanceUsd: number
  lifetimeSpentUsd: number
  concurrency: number
  overageAllowed: boolean
}

/**
 * Read subscription + balance and project them onto the tier policy. A
 * null/absent key fails CLOSED (free tier, zero balance) — a billable run is
 * never started against an unknown balance. Platform errors throw; callers
 * on the billable path choose their posture explicitly.
 */
export async function readTangleTierState(
  http: PlatformBillingHttp,
  userApiKey: string | null | undefined,
  policy: Record<TanglePlanTier, TangleTierPolicy> = DEFAULT_TANGLE_TIER_POLICY,
): Promise<TangleTierState> {
  if (!userApiKey) {
    return {
      tier: 'free',
      subscriptionStatus: null,
      remainingBalanceUsd: 0,
      lifetimeSpentUsd: 0,
      ...policy.free,
    }
  }
  const [subscription, balance] = await Promise.all([
    http.getSubscription(userApiKey),
    http.getBalance(userApiKey),
  ])
  return {
    tier: subscription.tier,
    subscriptionStatus: subscription.status,
    remainingBalanceUsd: balance.balance,
    lifetimeSpentUsd: balance.lifetimeSpent,
    ...policy[subscription.tier],
  }
}

// ── Bridge onto the /billing seam ───────────────────────────────────────────

export interface PlatformIdentityStore {
  resolveIdentity(userId: string): Promise<PlatformIdentity | null>
}

/** Concrete fetch-backed `PlatformBillingClient<TanglePlanTier>` for
 *  `createPlatformBalanceManager` (from `/billing`). */
export function createTanglePlatformBillingClient(
  http: PlatformBillingHttp,
  identity: PlatformIdentityStore,
): PlatformBillingClient<TanglePlanTier> {
  return {
    resolveIdentity: (userId) => identity.resolveIdentity(userId),
    getPlan: async (apiKey) => (await http.getSubscription(apiKey)).tier,
    getBalance: async (apiKey) => {
      const snapshot = await http.getBalance(apiKey)
      return { balance: snapshot.balance, lifetimeSpent: snapshot.lifetimeSpent }
    },
    getUsageByProduct: (apiKey) => http.getUsageByProduct(apiKey),
    deduct: (input) => http.deduct(input),
  }
}
