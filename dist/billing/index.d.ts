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
    createKey(input: {
        name: string;
        product: string;
        budgetUsd: number;
        expiresAt: string;
    }): Promise<{
        id?: string;
        key?: string;
    }>;
    revokeKey(keyId: string): Promise<unknown>;
    getKey(keyId: string): Promise<{
        budgetUsd?: number;
        budgetSpent?: number;
        expiresAt?: string | null;
    }>;
}
/**
 * The subset of the `@tangle-network/tcloud` `TCloudClient` the provisioner uses
 * — declared with METHOD syntax so the real client (whose `product` is a narrow
 * union and whose budgets are `number | null`) is assignable bivariantly. The
 * real SDK client satisfies this; pass it straight in.
 */
export interface TcloudKeyClient {
    createKey(opts: {
        name: string;
        product?: string;
        budgetUsd?: number;
        expiresAt?: string;
        parentKeyId?: string;
        allowedModels?: string[];
        rpmLimit?: number;
    }): Promise<{
        id: string;
        key: string;
    }>;
    getKey(id: string): Promise<{
        budgetUsd?: number | null;
        budgetSpent?: number;
        expiresAt?: string | null;
    }>;
    revokeKey(id: string): Promise<unknown>;
}
/**
 * Adapt the tcloud SDK client to {@link KeyProvisioner} — the typed seam that
 * replaces the `as unknown as KeyProvisioner` cast every consumer otherwise
 * repeats. The platform already exposes child-key minting (parent→child key,
 * per-key USD budget, expiry); this maps its shapes (`product` union,
 * `number | null` budgets) onto the manager's contract (`null → undefined`).
 */
export declare function createTcloudKeyProvisioner(client: TcloudKeyClient): KeyProvisioner;
/** A stored child-key record (the app's row, shape-normalized). */
export interface WorkspaceKeyRecord {
    /** App row id (opaque). */
    id: string;
    keyId: string;
    /** The encrypted secret — decrypted via {@link KeyCrypto.decrypt}. */
    keyEncrypted: string;
    budgetUsd: number;
    expiresAt: Date | null;
}
/** Persistence seam — the product implements this against its own D1 table. */
export interface WorkspaceKeyStore {
    /** Most-recent active key for the workspace, or null. */
    getActive(workspaceId: string): Promise<WorkspaceKeyRecord | null>;
    /** All active keys (to revoke priors on rotate). */
    listActive(workspaceId: string): Promise<Array<{
        id: string;
        keyId: string;
    }>>;
    /** Persist a freshly minted active key. */
    insert(record: {
        workspaceId: string;
        keyId: string;
        keyEncrypted: string;
        budgetUsd: number;
        expiresAt: Date;
    }): Promise<void>;
    /** Mark a prior row revoked. */
    markRevoked(id: string, now: Date): Promise<void>;
}
/** Secret encryption seam (the app's at-rest crypto). */
export interface KeyCrypto {
    encrypt(secret: string): Promise<string>;
    decrypt(encrypted: string): Promise<string>;
}
/** Define configuration options for managing workspace keys including provisioning, storage, and cryptography */
export interface WorkspaceKeyManagerOptions {
    provisioner: KeyProvisioner;
    store: WorkspaceKeyStore;
    crypto: KeyCrypto;
    /** Default monthly allowance (USD) when a call doesn't specify one. */
    defaultBudgetUsd: number;
    /** Injectable clock. Default `() => new Date()`. */
    now?: () => Date;
    /** tcloud product the key is scoped to. Default `'router'`. */
    product?: string;
}
/** Describe usage and budget details for a workspace model key including expiration and exhaustion status */
export interface WorkspaceModelKeyUsage {
    keyId: string;
    budgetUsd: number;
    budgetSpent: number;
    budgetRemaining: number;
    expiresAt: string | null;
    exhausted: boolean;
}
/** Manage workspace keys by ensuring, rotating, and tracking usage of active child-key secrets */
export interface WorkspaceKeyManager {
    /** The workspace's active child-key secret, provisioning one if absent/expired. */
    ensureKey(workspaceId: string, opts?: {
        budgetUsd?: number;
    }): Promise<string>;
    /** Mint a fresh key + revoke priors (period renewal / top-up). `rollover`
     *  carries the prior key's unused budget into the new one, bounded by
     *  `rolloverCapUsd`. Returns the new secret. */
    rotateKey(workspaceId: string, opts?: {
        budgetUsd?: number;
        rollover?: boolean;
        rolloverCapUsd?: number;
    }): Promise<string>;
    /** Live budget usage for the active key (drives the "$X of $Y used" panel). */
    getUsage(workspaceId: string): Promise<WorkspaceModelKeyUsage | null>;
}
/** A user's resolved platform identity (from the app's SSO account store). */
export interface PlatformIdentity {
    platformUserId: string;
    /** The user's per-user platform API key (reads), or null when unlinked. */
    apiKey: string | null;
}
/** Spendable balance for a platform user. */
export interface PlatformBalanceInfo {
    balance: number;
    lifetimeSpent: number;
}
/** Per-product spend aggregate. */
export interface PlatformProductUsage {
    product: string | null;
    totalSpent: number;
    count: number;
}
/** Plan limits — a PARAMETER per product (dollar allowance, concurrency,
 *  overage policy). Never baked into the framework. */
export interface PlanLimit {
    monthlyBalanceUsd: number;
    concurrency: number;
    overageAllowed: boolean;
}
/**
 * The platform billing transport — the product wires these to id.tangle.tools
 * (or any balance backend). Reads authenticate as the user (their `apiKey`);
 * the deduct write is a service-token call naming the target user. This module
 * never touches HTTP — it only sequences these calls.
 */
export interface PlatformBillingClient<Plan extends string> {
    /** Resolve the user's platform identity, or null when there is no SSO account. */
    resolveIdentity(userId: string): Promise<PlatformIdentity | null>;
    /** Subscription plan for the user (via their platform key). */
    getPlan(apiKey: string): Promise<Plan>;
    /** Spendable balance for the user (via their platform key). */
    getBalance(apiKey: string): Promise<PlatformBalanceInfo>;
    /** Per-product usage rows for the user (via their platform key). */
    getUsageByProduct(apiKey: string): Promise<PlatformProductUsage[]>;
    /** Deduct spend against the user's balance (service-token write). */
    deduct(input: {
        platformUserId: string;
        amountUsd: number;
        type: string;
        description: string;
        referenceId: string;
    }): Promise<void>;
}
/** Define shared billing state including user ID, plan, balances, concurrency, and overage permission */
export interface SharedBillingState<Plan extends string> {
    /** Platform user id, or null when the user has no Tangle SSO account. */
    platformUserId: string | null;
    plan: Plan;
    monthlyBalanceUsd: number;
    remainingBalanceUsd: number;
    lifetimeSpentUsd: number;
    concurrency: number;
    overageAllowed: boolean;
}
/** Define configuration options for managing platform balance based on billing plans */
export interface PlatformBalanceManagerOptions<Plan extends string> {
    client: PlatformBillingClient<Plan>;
    /** Plan → limits map (the product's pricing). */
    planLimits: Record<Plan, PlanLimit>;
    /** The plan an unlinked / outage user falls to (fails CLOSED). */
    freePlan: Plan;
    /** The product slug to attribute usage to (for `getProductUsage`). */
    productSlug: string;
}
/** Manage user plans and balances including state retrieval, billing authorization, deduction, and usage tracking */
export interface PlatformBalanceManager<Plan extends string> {
    /** Resolve the user's plan + balance. Unlinked or platform-outage users fail
     *  CLOSED: free plan, zero remaining balance — a billable run is never started
     *  against an unknown balance. */
    getState(userId: string): Promise<SharedBillingState<Plan>>;
    /** Gate a billable turn: allowed when the plan permits overage or remaining
     *  balance is positive. Returns the state so the caller deducts against it. */
    canStartBillableTurn(userId: string): Promise<{
        allowed: boolean;
        state: SharedBillingState<Plan>;
    }>;
    /** Deduct `amountUsd` against the user's platform balance. Throws when the
     *  user is not platform-linked. */
    deduct(userId: string, params: {
        amountUsd: number;
        type: string;
        description: string;
        referenceId: string;
    }): Promise<void>;
    /** This product's spend for the user (drives a usage panel). */
    getProductUsage(userId: string): Promise<{
        spentUsd: number;
        transactionCount: number;
    }>;
}
/** Create a platform balance manager to handle user plan limits and state based on provided options */
export declare function createPlatformBalanceManager<Plan extends string>(opts: PlatformBalanceManagerOptions<Plan>): PlatformBalanceManager<Plan>;
/** Create a workspace key manager that handles key provisioning and budget tracking */
export declare function createWorkspaceKeyManager(opts: WorkspaceKeyManagerOptions): WorkspaceKeyManager;
export { createIdentityBoundWorkspaceKeyManager, type DurableWorkspaceKeyManager, type DurableWorkspaceKeyManagerOptions, type DurableWorkspaceKeyCreateInput, type DurableWorkspaceKeyConditionalWrites, type DurableWorkspaceKeyProvisioner, type DurableWorkspaceKeyProvisioningRecord, type DurableWorkspaceKeyRecord, type DurableWorkspaceKeyScope, type DurableWorkspaceKeyStore, type WorkspaceKeyIdentity, type WorkspaceKeyProduct, type WorkspaceKeyStatus, type WorkspaceKeyUsage, type WorkspaceRuntimeKey, } from './identity-bound';
