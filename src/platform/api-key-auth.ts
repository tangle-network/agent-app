/** Verified key fields required to enter a product's private API routes. */
export interface RequestApiKey {
  keyId: string
  ownerId: string
  scopes: readonly string[]
  /** Unix epoch milliseconds. Private API credentials must expire. */
  expiresAt: number
}

export interface ApiKeyRequestAuthOptions<Key extends RequestApiKey, Identity> {
  /** Verify against the existing key store, including revocation and spending limits. */
  verify(authorization: string): Promise<Key | null>
  /** Return one scope or all required scopes; null or an empty list denies the route. */
  requiredScope(request: Request): string | readonly string[] | null
  /** Load the owner from product storage; retain normal workspace and tenant authorization. */
  resolveIdentity(key: Key): Promise<Identity | null>
  /** Atomically enforce the existing key's request quotas before admitting the request. */
  claimRequest(key: Key, requestId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>
}

/**
 * Adapt existing Bearer keys to private product routes without issuing sessions.
 * Only absent authorization returns null; supplied invalid credentials never
 * fall through to cookie authentication. Callers retain their ordinary RBAC.
 */
export function createApiKeyRequestAuth<Key extends RequestApiKey, Identity>(
  options: ApiKeyRequestAuthOptions<Key, Identity>,
): (request: Request) => Promise<Identity | null> {
  return async (request) => {
    const authorization = request.headers.get('Authorization')
    if (authorization === null) return null
    const bearer = /^Bearer +(\S+)$/i.exec(authorization)
    if (!bearer) {
      throw denied(401, 'api_key.invalid', 'Invalid API key')
    }
    const requiredScope = options.requiredScope(request)
    const requiredScopes = typeof requiredScope === 'string' ? [requiredScope] : requiredScope
    if (!requiredScopes?.length || !requiredScopes.every(scope => typeof scope === 'string' && scope.trim())) {
      throw denied(403, 'api_key.route_denied', 'API key access is not enabled for this route')
    }
    const key = await options.verify(`Bearer ${bearer[1]}`)
    if (!key || !key.keyId?.trim() || !key.ownerId?.trim()) {
      throw denied(401, 'api_key.invalid', 'Invalid API key')
    }
    if (!Number.isSafeInteger(key.expiresAt) || key.expiresAt <= Date.now()) {
      throw denied(401, 'api_key.expired', 'An unexpired API key with a finite expiry is required')
    }
    if (!Array.isArray(key.scopes) || !requiredScopes.every(scope => key.scopes.includes(scope))) {
      throw denied(403, 'api_key.insufficient_scope', `API key requires scopes: ${requiredScopes.join(', ')}`)
    }
    const identity = await options.resolveIdentity(key)
    if (!identity) throw denied(401, 'api_key.invalid_owner', 'API key owner is unavailable')
    const claim = await options.claimRequest(key, crypto.randomUUID())
    if (claim.allowed !== true) {
      const headers = new Headers()
      if (Number.isFinite(claim.retryAfterSeconds) && claim.retryAfterSeconds! > 0) {
        headers.set('Retry-After', String(Math.ceil(claim.retryAfterSeconds!)))
      }
      throw denied(429, 'api_key.request_limit_exceeded', 'API key request limit exceeded', headers)
    }
    if (key.expiresAt <= Date.now()) {
      throw denied(401, 'api_key.expired', 'API key expired during authorization')
    }
    return identity
  }
}

function denied(status: number, code: string, error: string, headers?: Headers): Response {
  return Response.json({ error, code }, { status, headers })
}
