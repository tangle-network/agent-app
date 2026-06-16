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

/** Lifecycle of a per-product seat subscription, mirroring the Stripe states
 *  the platform persists. 'none' = the user has never held this seat. */
export type SeatStatus = 'none' | 'active' | 'trialing' | 'past_due' | 'canceled'

/**
 * Per-product entitlement snapshot from the platform — the single read that
 * tells a product whether to show its workspace or the seat paywall. Shape
 * matches `GET /v1/billing/product-entitlement?product=<id>`.
 *
 * `hasSeat` and `onFreeTier` are computed platform-side from the raw seat row
 * + cumulative spend so the gate is identical across all five products:
 * - `hasSeat`     — an active/trialing seat whose period has not lapsed.
 * - `onFreeTier`  — no active seat AND cumulative spend below the free cap
 *                   ($2 / 200¢ lifetime). Keys off lifetime spend, not wallet
 *                   balance, so a router top-up never re-opens free access.
 */
export interface ProductEntitlement {
  seatStatus: SeatStatus
  /** ISO timestamp the active seat's paid period runs until; null when none. */
  currentPeriodEnd: string | null
  /** Cumulative inference spend across the whole suite, in dollars. */
  lifetimeSpentUsd: number
  hasSeat: boolean
  onFreeTier: boolean
}

export interface PlatformBillingHttp {
  /** GET /v1/plans/current (user bearer). */
  getSubscription(userApiKey: string): Promise<PlatformSubscriptionInfo>
  /** GET /v1/billing/balance (user bearer). */
  getBalance(userApiKey: string): Promise<PlatformBalanceSnapshot>
  /** GET /v1/billing/usage (user bearer). */
  getUsageByProduct(userApiKey: string): Promise<PlatformUsageProductRow[]>
  /** GET /v1/billing/product-entitlement?product=<id> (user bearer). */
  getProductEntitlement(userApiKey: string, productId: string): Promise<ProductEntitlement>
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
  /** Absolute URL of the $100/mo seat checkout for `productId`. */
  seatCheckoutUrl(productId: string): string
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

    async getProductEntitlement(userApiKey, productId) {
      const slug = encodeURIComponent(productId)
      const body = await userRead<{
        success: boolean
        data?: {
          seatStatus?: SeatStatus | null
          currentPeriodEnd?: string | null
          lifetimeSpentUsd?: number | null
          hasSeat?: boolean | null
          onFreeTier?: boolean | null
        }
      }>(userApiKey, `/v1/billing/product-entitlement?product=${slug}`)
      const data = body.data ?? {}
      const hasSeat = data.hasSeat === true
      return {
        seatStatus: data.seatStatus ?? 'none',
        currentPeriodEnd: data.currentPeriodEnd ?? null,
        lifetimeSpentUsd: data.lifetimeSpentUsd ?? 0,
        hasSeat,
        // Free access only when there is no seat AND the platform says so.
        onFreeTier: !hasSeat && data.onFreeTier === true,
      }
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

    seatCheckoutUrl(productId) {
      return seatCheckoutUrl(baseUrl, productId)
    },
  }
}

/**
 * Platform Stripe checkout URL for a product's $100/mo seat. One shared price
 * carries `metadata.productId`; the platform distinguishes the product from
 * the `product` query param (not five distinct prices). Mirrors the
 * `billingUrl()` shape — a deterministic platform-rooted URL, no network call.
 */
export function seatCheckoutUrl(baseUrl: string, productId: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  return `${root}/app/billing/seat/checkout?product=${encodeURIComponent(productId)}`
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

// ── Per-product seat entitlement ────────────────────────────────────────────

/** Lifetime free-tier cap: $2 (200¢) cumulative inference spend, expressed in
 *  dollars. Free product access ends once cumulative spend crosses this. */
export const FREE_TIER_SPEND_CAP_USD = 2

/**
 * Default name of the per-app feature flag gating seat billing. While OFF the
 * entitlement read is skipped and access fails OPEN (entitled) so nothing
 * changes live until a product flips the flag.
 */
export const DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR = 'SEAT_BILLING_ENABLED'

export interface SeatBillingFlagOptions {
  env?: Record<string, string | undefined>
  /** Override the flag name; default {@link DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR}. */
  flagEnvVar?: string
}

/**
 * Seat billing is OFF unless the flag is explicitly truthy ('true'/'1'/'on'/
 * 'enabled'). Default OFF — pre-rollout, the paywall never engages. Returns
 * false when no env is available (browser bundles) so the client stays
 * fail-open there too.
 */
export function isSeatBillingEnabled(opts: SeatBillingFlagOptions = {}): boolean {
  const env =
    opts.env ??
    (typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : undefined)
  if (!env) return false
  const flag = env[opts.flagEnvVar ?? DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR]?.trim().toLowerCase()
  return flag === 'true' || flag === '1' || flag === 'on' || flag === 'enabled'
}

/**
 * Read a user's entitlement for one product. Fails OPEN: an absent key,
 * disabled flag, or unreachable seat endpoint all return a permissive snapshot
 * (`hasSeat: true`) so consumers never break pre-rollout. The platform owns the
 * `hasSeat`/`onFreeTier` computation; this client only transports + degrades
 * safely.
 *
 * @param flag — pass {@link isSeatBillingEnabled} (or your own boolean) so the
 *   product owns when the gate engages. When false, no network call is made.
 */
export async function getProductEntitlement(
  http: Pick<PlatformBillingHttp, 'getProductEntitlement'>,
  userApiKey: string | null | undefined,
  productId: string,
  flag = true,
): Promise<ProductEntitlement> {
  if (!flag || !userApiKey) return failOpenEntitlement()
  try {
    return await http.getProductEntitlement(userApiKey, productId)
  } catch {
    // Seat endpoint unavailable (pre-rollout platform, transient 5xx): never
    // wall a paying or grandfathered user on a transport hiccup.
    return failOpenEntitlement()
  }
}

function failOpenEntitlement(): ProductEntitlement {
  return {
    seatStatus: 'active',
    currentPeriodEnd: null,
    lifetimeSpentUsd: 0,
    hasSeat: true,
    onFreeTier: false,
  }
}

/** Entitled = holds an active seat OR is still inside the free tier. The one
 *  predicate all five products gate on. */
export function isProductEntitled(ent: ProductEntitlement): boolean {
  return ent.hasSeat || ent.onFreeTier
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
