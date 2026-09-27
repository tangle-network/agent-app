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
import type { PlatformBillingClient, PlatformIdentity } from '../billing/index';
/** Define available subscription tiers for the TanglePlan service */
export type TanglePlanTier = 'free' | 'pro' | 'enterprise';
/** 'pro' | 'enterprise' pass through; anything else (null, unknown) → 'free'. */
export declare function normalizeTanglePlanTier(plan: string | null | undefined): TanglePlanTier;
/** Represent platform billing HTTP errors with status code and detailed message */
export declare class PlatformBillingHttpError extends Error {
    readonly status: number;
    constructor(status: number, detail: string);
}
/** Structural guard (name + numeric status) — robust across module instances. */
export declare function isPlatformBillingHttpError(error: unknown): error is PlatformBillingHttpError;
/** Define HTTP options for platform billing including base URL, service token, product slug, fetch implementation, and timeout */
export interface PlatformBillingHttpOptions {
    /** Platform root, e.g. https://id.tangle.tools (trailing slashes stripped). */
    baseUrl: string;
    /** Used only by `deduct()`; resolved lazily so reads never require it.
     *  Throws at call time when empty. */
    serviceToken: string | (() => string);
    /** Product slug — the `X-Service-Name` header and the deduct `product` field. */
    productSlug: string;
    fetchImpl?: typeof fetch;
    /** Default 10 000. */
    timeoutMs?: number;
}
/** Describe subscription tier and status information for a platform user */
export interface PlatformSubscriptionInfo {
    tier: TanglePlanTier;
    status: string | null;
}
/** Describe the platform balance and lifetime spending with an optional update timestamp */
export interface PlatformBalanceSnapshot {
    balance: number;
    lifetimeSpent: number;
    updatedAt?: string;
}
/** Describe a product's usage and spending metrics on the platform */
export interface PlatformUsageProductRow {
    product: string | null;
    totalSpent: number;
    count: number;
}
/** Lifecycle of a per-product seat subscription, mirroring the Stripe states
 *  the platform persists. 'none' = the user has never held this seat. */
export type SeatStatus = 'none' | 'active' | 'trialing' | 'past_due' | 'canceled';
/** Price and included shared-wallet credit for one seat billing period. */
export interface ProductSeatOfferPeriod {
    priceCents: number;
    includedCreditsCents: number;
}
/** Commercial terms returned by the platform's product catalog. Products use
 * this exact object for display instead of duplicating prices in UI copy. */
export interface ProductSeatOffer {
    currency: 'usd';
    interval: 'month';
    recurring: ProductSeatOfferPeriod;
    introductory: ProductSeatOfferPeriod | null;
}
/**
 * Per-product entitlement snapshot from the platform — the single read that
 * tells a product whether to show its workspace or the seat paywall. Shape
 * matches `GET /v1/billing/product-entitlement?product=<id>`.
 *
 * `hasSeat` is computed platform-side from the raw seat row.
 * It is true for an active or trialing seat whose period has not lapsed.
 * `onFreeTier` remains in the wire shape for compatibility, but this client
 * always returns false and never uses it for access.
 */
export interface ProductEntitlement {
    seatStatus: SeatStatus;
    /** ISO timestamp the active seat's paid period runs until; null when none. */
    currentPeriodEnd: string | null;
    /** Cumulative inference spend across the whole suite, in dollars. */
    lifetimeSpentUsd: number;
    hasSeat: boolean;
    /** Platform access decision, including funded balance and identity policy. */
    paidAccess?: boolean;
    onFreeTier: boolean;
    /** Present when the platform exposes catalog-backed commercial terms. */
    offer?: ProductSeatOffer;
}
/** Define methods to interact with platform billing endpoints using user or service authentication */
export interface PlatformBillingHttp {
    /** GET /v1/plans/current (user bearer). */
    getSubscription(userApiKey: string): Promise<PlatformSubscriptionInfo>;
    /** GET /v1/billing/balance (user bearer). */
    getBalance(userApiKey: string): Promise<PlatformBalanceSnapshot>;
    /** GET /v1/billing/usage (user bearer). */
    getUsageByProduct(userApiKey: string): Promise<PlatformUsageProductRow[]>;
    /** GET /v1/billing/product-entitlement?product=<id> (user bearer). */
    getProductEntitlement(userApiKey: string, productId: string): Promise<ProductEntitlement>;
    /** POST /v1/billing/deduct (service token). */
    deduct(input: {
        platformUserId: string;
        amountUsd: number;
        type: string;
        description: string;
        referenceId: string;
    }): Promise<void>;
    /** Absolute URL of the platform's billing-management surface. */
    billingUrl(): string;
    /** Absolute URL of the catalog-backed seat checkout for `productId`. */
    seatCheckoutUrl(productId: string): string;
}
/** Create a PlatformBillingHttp instance configured with given options and default behaviors */
export declare function createPlatformBillingHttp(opts: PlatformBillingHttpOptions): PlatformBillingHttp;
/**
 * Platform Stripe checkout URL for a product's catalog-backed seat. The
 * platform resolves the product-specific price and introductory offer from the
 * `product` query param. Mirrors the `billingUrl()` shape — a deterministic
 * platform-rooted URL with no client-side pricing decisions.
 */
export declare function seatCheckoutUrl(baseUrl: string, productId: string): string;
/** Define policy settings for concurrency and overage allowance in a tangle tier */
export interface TangleTierPolicy {
    concurrency: number;
    overageAllowed: boolean;
}
/** Define default concurrency and overage policies for each TanglePlanTier level */
export declare const DEFAULT_TANGLE_TIER_POLICY: Record<TanglePlanTier, TangleTierPolicy>;
/** Describe the state of a Tangle plan tier including subscription, balance, spending, and concurrency details */
export interface TangleTierState {
    tier: TanglePlanTier;
    subscriptionStatus: string | null;
    remainingBalanceUsd: number;
    lifetimeSpentUsd: number;
    concurrency: number;
    overageAllowed: boolean;
}
/**
 * Read subscription + balance and project them onto the tier policy. A
 * null/absent key fails CLOSED (free tier, zero balance) — a billable run is
 * never started against an unknown balance. Platform errors throw; callers
 * on the billable path choose their posture explicitly.
 */
export declare function readTangleTierState(http: PlatformBillingHttp, userApiKey: string | null | undefined, policy?: Record<TanglePlanTier, TangleTierPolicy>): Promise<TangleTierState>;
/** Product-funded free inference spend is disabled. */
export declare const FREE_TIER_SPEND_CAP_USD = 0;
/**
 * Default name of the per-app feature flag that controls seat billing.
 * Explicit values override the environment default.
 */
export declare const DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR = "SEAT_BILLING_ENABLED";
/** Define options to configure seat billing flag environment variables and override flag name */
export interface SeatBillingFlagOptions {
    env?: Record<string, string | undefined>;
    /** Override the flag name; default {@link DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR}. */
    flagEnvVar?: string;
}
/**
 * An explicit flag controls seat billing in every environment.
 * Without a flag, known development and test environments default to OFF.
 * Deployed and unknown environments default to ON.
 */
export declare function isSeatBillingEnabled(opts?: SeatBillingFlagOptions): boolean;
/**
 * Read a user's entitlement for one product.
 * An absent key or disabled flag returns no access.
 * Transport failures propagate so the product can return a retryable error.
 *
 * @param flag — pass {@link isSeatBillingEnabled} (or your own boolean) so the
 *   product owns when the gate engages. When false, no network call is made.
 */
export declare function getProductEntitlement(http: Pick<PlatformBillingHttp, 'getProductEntitlement'>, userApiKey: string | null | undefined, productId: string, flag?: boolean): Promise<ProductEntitlement>;
/** Honor platform access policy; older endpoints provide only seat authority. */
export declare function isProductEntitled(ent: ProductEntitlement): boolean;
/** Define a contract for resolving platform identities based on user identifiers */
export interface PlatformIdentityStore {
    resolveIdentity(userId: string): Promise<PlatformIdentity | null>;
}
/** Concrete fetch-backed `PlatformBillingClient<TanglePlanTier>` for
 *  `createPlatformBalanceManager` (from `/billing`). */
export declare function createTanglePlatformBillingClient(http: PlatformBillingHttp, identity: PlatformIdentityStore): PlatformBillingClient<TanglePlanTier>;
