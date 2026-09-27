import type { KeyCrypto, KeyProvisioner } from './index';
/** Lifecycle state for a durable delegated key row. */
export type WorkspaceKeyStatus = 'legacy' | 'provisioning' | 'active' | 'revocation_pending' | 'revoked' | 'orphaned';
/** Product partition used by the key store and remote provisioner. */
export type WorkspaceKeyProduct = string;
/** The identity fields that bind a child key to its paying owner and source. */
export interface WorkspaceKeyIdentity {
    workspaceId: string;
    ownerUserId: string;
    platformUserId: string;
    sourceKeyId?: string | null;
    /** A non-secret digest of the source credential. */
    sourceKeyFingerprint: string;
}
/** A product/workspace/owner lookup scope. */
export interface DurableWorkspaceKeyScope {
    workspaceId: string;
    ownerUserId: string;
    product: WorkspaceKeyProduct;
}
/** A persisted child-key row owned by this manager. */
export interface DurableWorkspaceKeyRecord {
    id: string;
    workspaceId: string;
    ownerUserId: string;
    product: WorkspaceKeyProduct;
    platformUserId: string;
    sourceKeyId: string | null;
    sourceKeyFingerprint: string;
    /** The persisted name used to recover a remote create after a crash. Null only for pre-name rows. */
    name: string | null;
    /** The persisted retry identity for the remote create. Absent on legacy rows without a persisted create identity. */
    idempotencyKey?: string | null;
    keyId: string;
    keyEncrypted: string;
    budgetUsd: number;
    expiresAt: Date;
    status: WorkspaceKeyStatus;
    revocationAttempts: number;
    nextRevocationAt: Date | null;
    lastRevocationError: string | null;
    createdAt: Date;
}
/** A row that has been written before its remote child key exists. */
export interface DurableWorkspaceKeyProvisioningRecord extends DurableWorkspaceKeyRecord {
    status: 'provisioning';
}
type DurableWorkspaceKeyCreateResult = Awaited<ReturnType<KeyProvisioner['createKey']>> & {
    budgetUsd?: number | null;
    budgetRemaining?: number;
    expiresAt?: string | null;
};
/** The exact request identity that must be reused when recovering a create. */
export interface DurableWorkspaceKeyCreateInput {
    name: string;
    product: string;
    budgetUsd: number;
    expiresAt: string;
    /** Stable across process restarts for one persisted provisioning row. */
    idempotencyKey: string;
}
/** The remote operations required by the durable manager. */
export interface DurableWorkspaceKeyProvisioner {
    /** True only when replay returns the original child for the persisted request identity. */
    supportsIdempotentCreate?: true;
    /** Create one child key. Non-idempotent providers recover through stable-name discovery only. */
    createKey(input: DurableWorkspaceKeyCreateInput): Promise<DurableWorkspaceKeyCreateResult>;
    getKey(id: string): Promise<{
        budgetUsd?: number | null;
        budgetSpent?: number;
        expiresAt?: string | null;
    }>;
    revokeKey: KeyProvisioner['revokeKey'];
    /** Find remote keys for a specific persisted provisioning attempt. */
    findCreatedKeys(input: {
        name: string;
        product: string;
        sourceKeyId?: string | null;
    }): Promise<Array<{
        id: string;
    }>>;
}
/** Optional compare-and-set lifecycle writes for stores that support fencing. */
export interface DurableWorkspaceKeyConditionalWrites {
    /** Return false when the row was no longer provisioning. */
    markProvisioningRemote(input: {
        id: string;
        keyId: string;
    }): Promise<boolean>;
    /** Return false when the row was no longer provisioning. */
    markActive(input: {
        id: string;
        keyId: string;
        keyEncrypted: string;
        expiresAt: Date;
        budgetUsd: number;
    }): Promise<boolean>;
}
/** Persistence operations for identity-bound key lifecycle state. */
export interface DurableWorkspaceKeyStore {
    /** Return the active row for this exact product scope. */
    getActive(scope: DurableWorkspaceKeyScope): Promise<DurableWorkspaceKeyRecord | null>;
    /** Return every unfinished provisioning row for this exact product scope. */
    listProvisioning(scope: DurableWorkspaceKeyScope): Promise<DurableWorkspaceKeyProvisioningRecord[]>;
    /** Insert before the remote create so a crashed create can be recovered. */
    insertProvisioning(record: DurableWorkspaceKeyProvisioningRecord): Promise<void>;
    /** Save the remote id while the row remains in provisioning state. */
    markProvisioningRemote(input: {
        id: string;
        keyId: string;
    }): Promise<void>;
    /** Promote a fully encrypted row to active state. */
    markActive(input: {
        id: string;
        keyId: string;
        keyEncrypted: string;
        expiresAt: Date;
        budgetUsd: number;
    }): Promise<void>;
    /**
     * Optional fenced writes. The manager uses false to compensate a stale
     * creator. Stores without this field retain the pre-fence behavior.
     */
    conditionalWrites?: DurableWorkspaceKeyConditionalWrites;
    /** Keep a failed cleanup visible and schedule a later retry. Terminal rows are immutable. */
    markRevocationPending(input: {
        id: string;
        error?: string | null;
        nextAttemptAt: Date;
        incrementAttempts: boolean;
    }): Promise<void>;
    /** Mark a remote key as revoked. Missing remote keys count as revoked. */
    markRevoked(id: string, now: Date): Promise<void>;
    /** Mark a provisioning row terminal when no remote key remains to clean. */
    markOrphaned(id: string, error: string): Promise<void>;
    /** Query due cleanup rows. The implementation should filter by the supplied scope. */
    listPendingRevocations(input: {
        product: WorkspaceKeyProduct;
        workspaceId?: string;
        ownerUserId?: string;
        now: Date;
        limit: number;
        /** Include rows scheduled for a later retry when checking before issuance. */
        includeFuture?: boolean;
    }): Promise<DurableWorkspaceKeyRecord[]>;
    /** Acquire a cross-process lease for one product/workspace/owner scope. */
    acquireLease(scope: string, operationId: string, now: Date, leaseMs: number): Promise<boolean>;
    /** Renew an acquired lease before its expiry. */
    renewLease(scope: string, operationId: string, now: Date, leaseMs: number): Promise<boolean>;
    /** Release an acquired lease. */
    releaseLease(scope: string, operationId: string): Promise<void>;
}
/** Live budget information for a child key. */
export interface WorkspaceKeyUsage {
    keyId: string;
    budgetUsd: number;
    budgetSpent: number;
    budgetRemaining: number;
    expiresAt: string;
    exhausted: boolean;
}
/** The decrypted key plus the usage snapshot used to issue it. */
export interface WorkspaceRuntimeKey {
    key: string;
    usage: WorkspaceKeyUsage;
    /** True when this call minted a new remote key. */
    refreshed: boolean;
}
/** Identity-bound durable key manager API. */
export interface DurableWorkspaceKeyManager {
    /** Reuse a matching active key or reconcile and mint one under a lease. */
    ensureKey(identity: WorkspaceKeyIdentity, options?: {
        budgetUsd?: number;
    }): Promise<WorkspaceRuntimeKey>;
    /** Read usage without returning the child secret. */
    getUsage(identity: WorkspaceKeyIdentity): Promise<WorkspaceKeyUsage | null>;
    /**
     * Retry due cleanup rows. A supplied owner/workspace limits the retry to its
     * scope. Empty provisioning rows also require the full identity so a retry
     * can use the original source binding safely.
     */
    retryPendingRevocations(scope?: Pick<WorkspaceKeyIdentity, 'ownerUserId' | 'workspaceId'>, identity?: WorkspaceKeyIdentity): Promise<number>;
}
/** Configuration for {@link createIdentityBoundWorkspaceKeyManager}. */
export interface DurableWorkspaceKeyManagerOptions {
    store: DurableWorkspaceKeyStore;
    provisioner: DurableWorkspaceKeyProvisioner;
    /**
     * Control-plane client for historical get/revoke/list operations. Use this
     * when the source credential can rotate or disappear. It never mints keys.
     */
    recoveryProvisioner?: Pick<DurableWorkspaceKeyProvisioner, 'getKey' | 'revokeKey' | 'findCreatedKeys'>;
    crypto: KeyCrypto;
    /** Product partition. Products must use separate values. */
    product: WorkspaceKeyProduct;
    defaultBudgetUsd: number;
    now?: () => Date;
    /** Local lifetime used when the remote response omits an expiry. */
    keyLifetimeMs?: number;
    /** Lease lifetime for remote operations. */
    leaseMs?: number;
    /** Maximum time to wait for another issuer to release the scope lease. */
    leaseWaitMs?: number;
    /** Poll delay while waiting for a scope lease. */
    leasePollMs?: number;
    /** Renewal interval. It must be shorter than `leaseMs`. */
    leaseRenewIntervalMs?: number;
    /** Initial delay for a failed remote revoke. */
    revocationRetryBaseMs?: number;
    /** Maximum delay for a failed remote revoke. */
    revocationRetryMaxMs?: number;
    /** Stable remote name. The operation id makes the default crash-safe. */
    nameForIdentity?: (identity: WorkspaceKeyIdentity, operationId: string) => string;
    /** Resolve names for rows written before `name` became durable. Null blocks issuance safely. */
    legacyNameForRecord?: (record: DurableWorkspaceKeyRecord) => string | null | undefined;
    /** Recognize a missing remote key without depending on a provider SDK. */
    isRemoteMissing?: (error: unknown) => boolean;
}
/**
 * Create a product-neutral manager for child-key issuance and cleanup.
 *
 * The provisioner must already be authenticated for the current source
 * credential. The manager persists only the source id and its non-secret
 * fingerprint, then refuses to reuse a row from another identity.
 */
export declare function createIdentityBoundWorkspaceKeyManager(options: DurableWorkspaceKeyManagerOptions): DurableWorkspaceKeyManager;
export {};
