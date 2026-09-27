/** Verified key fields required to enter a product's private API routes. */
export interface RequestApiKey {
    keyId: string;
    ownerId: string;
    scopes: readonly string[];
    /** Unix epoch milliseconds. Private API credentials must expire. */
    expiresAt: number;
}
export interface ApiKeyRequestAuthOptions<Key extends RequestApiKey, Identity> {
    /** Verify against the existing key store, including revocation and spending limits. */
    verify(authorization: string): Promise<Key | null>;
    /** Return one scope or all required scopes; null or an empty list denies the route. */
    requiredScope(request: Request): string | readonly string[] | null;
    /** Load the owner from product storage; retain normal workspace and tenant authorization. */
    resolveIdentity(key: Key): Promise<Identity | null>;
    /** Atomically enforce the existing key's request quotas before admitting the request. */
    claimRequest(key: Key, requestId: string): Promise<{
        allowed: boolean;
        retryAfterSeconds?: number;
    }>;
}
/**
 * Adapt existing Bearer keys to private product routes without issuing sessions.
 * Only absent authorization returns null; supplied invalid credentials never
 * fall through to cookie authentication. Callers retain their ordinary RBAC.
 */
export declare function createApiKeyRequestAuth<Key extends RequestApiKey, Identity>(options: ApiKeyRequestAuthOptions<Key, Identity>): (request: Request) => Promise<Identity | null>;
