/**
 * Platform agent keys at an agent app's own API.
 *
 * One owner approval on id.tangle.tools gives an AI agent one key for every
 * product it asked for (`provisionedByService: agent-signup`). An agent app
 * accepts that key by asking Platform's key verification about it for the
 * app's own product: Platform refuses a key whose scopes do not name the
 * product, a revoked or expired key, an unfunded owner, and a spent cap, so
 * the app inherits revocation and the shared spend cap without storing the key.
 *
 * Accepted answers are cached for a short TTL (default 30 seconds) so a burst
 * of operator calls costs one verification; refusals are never cached, so a
 * revocation takes effect within one TTL. Any failure to reach Platform throws,
 * and callers answer 503: an unverifiable key is never admitted.
 *
 * Web-standard fetch and SubtleCrypto only, so it runs in Workers and Node.
 */

export const PLATFORM_KEY_PREFIX = 'sk-tan-'

/** `provisionedByService` of keys minted by Platform agent signup. */
export const PLATFORM_AGENT_KEY_PROVISIONER = 'agent-signup'

const DEFAULT_CACHE_TTL_MS = 30_000
const MAX_CACHE_TTL_MS = 120_000
const MAX_CACHE_ENTRIES = 1_000
const VERIFY_TIMEOUT_MS = 10_000

export type PlatformAgentKeyVerification =
  | {
      ok: true
      keyId: string
      /** The owner's stable Platform user id. */
      platformUserId: string
      email: string
      name: string | null
      /** Every scope the key holds, across all products. */
      scopes: string[]
      /** Unix ms after which this answer must be asked again. */
      validUntil: number
    }
  | { ok: false; status: 401 | 402 | 403; code: string; message: string }

export interface PlatformAgentKeyVerifier {
  verify(rawKey: string): Promise<PlatformAgentKeyVerification>
}

export interface PlatformAgentKeyVerifierOptions {
  /** Platform origin, e.g. `https://id.tangle.tools`. */
  platformUrl: string
  /** This app's Platform service name (one of Platform's verify-allowed services). */
  serviceName: string
  serviceToken: string | (() => string)
  /** The Platform product this app verifies for, e.g. `gtm-agent`. */
  product: string
  cacheTtlMs?: number
  fetch?: typeof fetch
  now?: () => number
}

interface PlatformVerifyResponse {
  valid?: unknown
  keyId?: unknown
  userId?: unknown
  email?: unknown
  displayName?: unknown
  scopes?: unknown
  provisionedByService?: unknown
  invalidReason?: unknown
}

const BUDGET_REASONS = new Set(['budget_exhausted', 'monthly_budget_exhausted'])
const SCOPE_REASONS = new Set(['verify_product_not_permitted', 'product_mismatch'])

/** The typed refusal for a Platform rejection reason. */
export function platformKeyRefusal(reason: unknown): Extract<PlatformAgentKeyVerification, { ok: false }> {
  if (reason === 'paid_access_required') {
    return { ok: false, status: 402, code: 'agent_key.payment_required', message: "The key owner's Tangle account has no credit. Add credits at id.tangle.tools/app/billing." }
  }
  if (typeof reason === 'string' && BUDGET_REASONS.has(reason)) {
    return { ok: false, status: 402, code: 'agent_key.budget_exhausted', message: 'The key reached the spend cap its owner approved.' }
  }
  if (typeof reason === 'string' && SCOPE_REASONS.has(reason)) {
    return { ok: false, status: 403, code: 'agent_key.product_not_granted', message: "The key's owner did not approve it for this product." }
  }
  if (reason === 'email_verification_required') {
    return { ok: false, status: 403, code: 'agent_key.owner_unverified', message: 'The key owner must verify their Tangle email.' }
  }
  return { ok: false, status: 401, code: 'agent_key.invalid', message: 'The key is invalid, revoked or expired.' }
}

async function cacheKey(rawKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function createPlatformAgentKeyVerifier(options: PlatformAgentKeyVerifierOptions): PlatformAgentKeyVerifier {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => Date.now())
  const ttl = Math.max(0, Math.min(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS))
  const base = options.platformUrl.replace(/\/+$/, '')
  const cache = new Map<string, Extract<PlatformAgentKeyVerification, { ok: true }>>()

  return {
    async verify(rawKey) {
      if (!rawKey.startsWith(PLATFORM_KEY_PREFIX)) return platformKeyRefusal('key_not_found')
      const id = await cacheKey(rawKey)
      const cached = cache.get(id)
      if (cached && cached.validUntil > now()) return cached
      cache.delete(id)

      const token = typeof options.serviceToken === 'function' ? options.serviceToken() : options.serviceToken
      const response = await fetchImpl(`${base}/v1/keys/verify`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-service-name': options.serviceName,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ key: rawKey, expectedProduct: options.product, includeIdentityProfile: true }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      })
      // A refused key answers 200 with valid:false. Anything else means the
      // verification itself failed, and an unverified key is never admitted.
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Platform key verification answered HTTP ${response.status}`)
      }
      const body = (await response.json()) as PlatformVerifyResponse
      if (body.valid !== true) return platformKeyRefusal(body.invalidReason)

      const keyId = nonEmptyString(body.keyId)
      const platformUserId = nonEmptyString(body.userId)
      const email = nonEmptyString(body.email)
      if (!keyId || !platformUserId || !email) {
        throw new Error('Platform key verification omitted the key or owner identity')
      }
      // Only an agent-signup key carries operator scopes for agent apps; any
      // other Platform key is not an agent credential for this API.
      if (body.provisionedByService !== PLATFORM_AGENT_KEY_PROVISIONER) {
        return { ok: false, status: 403, code: 'agent_key.not_agent_key', message: 'Use a key from Tangle agent signup, or a key created in this app.' }
      }
      const scopes = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is string => typeof scope === 'string') : []
      const accepted = {
        ok: true as const,
        keyId,
        platformUserId,
        email,
        name: nonEmptyString(body.displayName),
        scopes,
        validUntil: now() + ttl,
      }
      if (ttl > 0) {
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(id, accepted)
      }
      return accepted
    },
  }
}

/**
 * The operator scopes an agent key grants at `product`: each
 * `<product>:operator:<action>` becomes `operator:<action>`, and `*` grants
 * every action.
 */
export function agentOperatorScopes(scopes: readonly string[], product: string, actions: readonly string[]): string[] {
  if (scopes.includes('*')) return actions.map((action) => `operator:${action}`)
  const prefix = `${product}:operator:`
  return actions.filter((action) => scopes.includes(`${prefix}${action}`)).map((action) => `operator:${action}`)
}
