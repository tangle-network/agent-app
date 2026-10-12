/**
 * Delegated product keys: a child key minted from the paying user's linked
 * Tangle key, scoped to one product, its models and its budget, so an app
 * never sends the user's own key to Router or Sandbox.
 *
 * WHY ONE. Seven apps minted these by hand (Tax, Legal, GTM, Creative,
 * Builder, Hardware, workcomp; survey 2026-10-12) with different scope,
 * expiry and revocation rules, and four never noticed a key Platform had
 * revoked or expired. `createPlatformDelegatedKeyClient` is the wire;
 * `createDelegatedKeyProvider` is the per-slot cache every app configures.
 *
 * THE CONTRACT (Platform `POST /v1/keys/delegate`, service-authenticated):
 * the child is checked field by field against the request (an `sk-tan-` key
 * that is not the source, the same name, product and model set, an expiry in
 * the future). A child that fails a check is revoked and refused, never
 * returned. Errors carry a code and status, never a response body or a key.
 *
 * NEXT USE. A key the provider has seen revoked, rejected by Router or
 * Sandbox, or expired is refused by `assertUsable` and never handed out again
 * by `keyFor`, which mints a fresh one instead.
 *
 * NO SHARED IN-FLIGHT MINT. The cache holds resolved keys only. A Worker
 * isolate serves many requests, and a mint awaited by a cancelled request
 * never settles for the others (agent-app #966).
 */

const REQUEST_TIMEOUT_MS = 10_000
const KEY_PREFIX = 'sk-tan-'
const DEFAULT_MIN_REMAINING_MS = 5 * 60_000

export type DelegatedKeyCode =
  | 'delegated_key.payment_required'
  | 'delegated_key.budget_exhausted'
  | 'delegated_key.owner_unverified'
  | 'delegated_key.unavailable'
  | 'delegated_key.refused'
  | 'delegated_key.response_invalid'
  | 'delegated_key.revoked'
  | 'delegated_key.expired'
  | 'delegated_key.invalid_request'

export interface DelegatedKeyRefusal {
  status: number
  code: DelegatedKeyCode
  message: string
}

export type DelegatedKeyOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: DelegatedKeyRefusal }

/** How the child is paid for: its own budget, or spending the source's budget directly. */
export type DelegatedKeyBudget =
  | { usd: number; monthlyUsd?: number }
  | { spendThrough: true; monthlyUsd?: number }

export interface DelegatedKeyRequest {
  /** The payer's linked `sk-tan-` key. Never a shared app key. */
  sourceKey: string
  /** `auto:<service>:...`. A name Platform already holds replaces that key after a short grace. */
  name: string
  product: 'router' | 'sandbox' | (string & {})
  resource?: { type: string; id: string }
  /** The only models the child may call. Omit for none of Router's model restriction. */
  allowedModels?: readonly string[]
  budget?: DelegatedKeyBudget
  rpmLimit?: number
  expiresAt: Date
}

export interface DelegatedKey {
  key: string
  id: string
  name: string
  product: string
  /** The expiry Platform granted, which may be earlier than requested. */
  expiresAt: Date
  allowedModels: readonly string[] | null
}

export interface PlatformDelegatedKeyClientOptions {
  /** Platform origin, e.g. `https://id.tangle.tools`. */
  platformUrl: string
  /** This app's Platform service name; Platform admits delegation per service. */
  serviceName: string
  serviceToken: string | (() => string)
  fetch?: typeof fetch
  now?: () => number
}

export interface PlatformDelegatedKeyClient {
  delegate(request: DelegatedKeyRequest): Promise<DelegatedKeyOutcome<DelegatedKey>>
  /** `DELETE /v1/keys/:id` with the source key. A key that is already gone counts as revoked. */
  revoke(input: { sourceKey: string; keyId: string }): Promise<DelegatedKeyOutcome<null>>
  /** Whether Platform still holds the key, and its expiry. */
  status(input: { sourceKey: string; keyId: string }): Promise<DelegatedKeyOutcome<{ live: boolean; expiresAt: Date | null }>>
}

function refusal(status: number, code: unknown): DelegatedKeyRefusal {
  if (code === 'INSUFFICIENT_BALANCE') {
    return { status: 402, code: 'delegated_key.payment_required', message: "The payer's Tangle account has no credit." }
  }
  if (code === 'KEY_BUDGET_EXHAUSTED' || code === 'KEY_BUDGET_EXCEEDED' || code === 'PRODUCT_BUDGET_EXCEEDED') {
    return { status: 402, code: 'delegated_key.budget_exhausted', message: "The payer's key has spent the budget it allows." }
  }
  if (code === 'EMAIL_VERIFICATION_REQUIRED') {
    return { status: 403, code: 'delegated_key.owner_unverified', message: 'The payer must verify their Tangle email.' }
  }
  if (status >= 500 || status === 429 || code === 'PLATFORM_BUSY') {
    return { status: 503, code: 'delegated_key.unavailable', message: 'Platform could not delegate a key; retry.' }
  }
  return { status: 403, code: 'delegated_key.refused', message: 'Platform refused to delegate this key.' }
}

const fail = <T,>(status: number, code: DelegatedKeyCode, message: string): DelegatedKeyOutcome<T> =>
  ({ succeeded: false, error: { status, code, message } })

function sameModels(granted: unknown, requested: readonly string[] | undefined): boolean {
  if (requested === undefined) return granted === undefined || granted === null
  if (!Array.isArray(granted)) return false
  const a = [...new Set(granted)].sort()
  const b = [...new Set(requested)].sort()
  return a.length === b.length && a.every((model, index) => model === b[index])
}

interface PlatformResponse {
  status: number
  body: { success?: unknown; data?: Record<string, unknown>; error?: { code?: unknown } }
}

export function createPlatformDelegatedKeyClient(options: PlatformDelegatedKeyClientOptions): PlatformDelegatedKeyClient {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const base = options.platformUrl.replace(/\/+$/, '')

  async function call(path: string, init: { method: string; bearer: string; service: boolean; body?: unknown }): Promise<PlatformResponse | null> {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${init.bearer}`,
          ...(init.service ? { 'x-service-name': options.serviceName } : {}),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return { status: response.status, body: (await response.json().catch(() => ({}))) as PlatformResponse['body'] }
    } catch {
      return null
    }
  }

  const client: PlatformDelegatedKeyClient = {
    async delegate(request) {
      if (!request.sourceKey.startsWith(KEY_PREFIX)) return fail(400, 'delegated_key.invalid_request', 'The source must be a linked sk-tan- key.')
      if (!request.name.startsWith('auto:')) return fail(400, 'delegated_key.invalid_request', 'A delegated key name starts with auto:.')
      if (request.expiresAt.getTime() <= now()) return fail(400, 'delegated_key.invalid_request', 'The expiry must be in the future.')
      const token = typeof options.serviceToken === 'function' ? options.serviceToken() : options.serviceToken
      const budget = request.budget
      const result = await call('/v1/keys/delegate', {
        method: 'POST', bearer: token, service: true, body: {
          sourceKey: request.sourceKey,
          name: request.name,
          product: request.product,
          ...(request.resource ? { resourceType: request.resource.type, resourceId: request.resource.id } : {}),
          ...(budget && 'usd' in budget ? { budgetUsd: budget.usd } : {}),
          ...(budget && 'spendThrough' in budget ? { spendThrough: true } : {}),
          ...(budget?.monthlyUsd !== undefined ? { monthlyBudgetUsd: budget.monthlyUsd } : {}),
          ...(request.allowedModels ? { allowedModels: [...new Set(request.allowedModels)] } : {}),
          ...(request.rpmLimit !== undefined ? { rpmLimit: request.rpmLimit } : {}),
          // A delegated product key never carries control-plane authority.
          scopes: [],
          expiresAt: request.expiresAt.toISOString(),
        },
      })
      if (!result) return { succeeded: false, error: refusal(503, null) }
      if ((result.status !== 200 && result.status !== 201) || result.body.success !== true || !result.body.data) {
        return { succeeded: false, error: refusal(result.status, result.body.error?.code) }
      }
      const data = result.body.data
      const key = data.key
      const id = data.id
      const expiresAt = typeof data.expiresAt === 'string' ? new Date(data.expiresAt) : null
      const problem =
        typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length <= KEY_PREFIX.length ? 'not an sk-tan child key'
        : key === request.sourceKey ? 'the source key itself'
        : typeof id !== 'string' || !id ? 'no key id'
        : data.name !== request.name ? 'a different name'
        : data.product !== request.product ? 'a different product'
        : !sameModels(data.allowedModels, request.allowedModels) ? 'a different model set'
        : !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now() ? 'no future expiry'
        : null
      if (problem) {
        // A child Platform minted but this app cannot trust is retired, never returned.
        if (typeof id === 'string' && id) await client.revoke({ sourceKey: request.sourceKey, keyId: id })
        return fail(502, 'delegated_key.response_invalid', `Platform returned ${problem}.`)
      }
      return { succeeded: true, value: {
        key: key as string, id: id as string, name: request.name, product: request.product,
        expiresAt: expiresAt!, allowedModels: request.allowedModels ? [...new Set(request.allowedModels)] : null,
      } }
    },

    async revoke({ sourceKey, keyId }) {
      const result = await call(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', bearer: sourceKey, service: false })
      if (!result) return { succeeded: false, error: refusal(503, null) }
      if (result.status === 404 || (result.status >= 200 && result.status < 300)) return { succeeded: true, value: null }
      return { succeeded: false, error: refusal(result.status, result.body.error?.code) }
    },

    async status({ sourceKey, keyId }) {
      const result = await call(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'GET', bearer: sourceKey, service: false })
      if (!result) return { succeeded: false, error: refusal(503, null) }
      if (result.status === 404) return { succeeded: true, value: { live: false, expiresAt: null } }
      if (result.status < 200 || result.status >= 300) return { succeeded: false, error: refusal(result.status, result.body.error?.code) }
      const data = result.body.data ?? {}
      const expiresAt = typeof data.expiresAt === 'string' ? new Date(data.expiresAt) : null
      const revoked = typeof data.revokedAt === 'string' && data.revokedAt.length > 0
      const expired = expiresAt !== null && expiresAt.getTime() <= now()
      return { succeeded: true, value: { live: !revoked && !expired, expiresAt } }
    },
  }
  return client
}

export interface DelegatedKeySlot extends Omit<DelegatedKeyRequest, 'expiresAt'> {
  /** How long a freshly minted child lives. */
  ttlMs: number
}

export interface DelegatedKeyProviderOptions {
  client: PlatformDelegatedKeyClient
  /** A cached key is reused only while it has at least this long left. Default 5 minutes. */
  minRemainingMs?: number
  /** Check with Platform before reusing a cached key, so a key revoked elsewhere is never handed out. */
  verifyOnReuse?: boolean
  now?: () => number
  /** Resolved keys per slot. Default: this isolate's memory, bounded to `maxEntries`. */
  maxEntries?: number
}

export interface DelegatedKeyProvider {
  /** A usable key for the slot: the cached one while it has `minRemainingMs` left, else a fresh mint. */
  keyFor(slot: DelegatedKeySlot): Promise<DelegatedKeyOutcome<DelegatedKey>>
  /** Router or Sandbox refused this key: it is never handed out again. */
  reject(key: string): void
  /** Revoke at Platform and stop handing the key out, even if the revoke call fails. */
  revoke(input: { sourceKey: string; key: DelegatedKey }): Promise<DelegatedKeyOutcome<null>>
  /** Refuses a key this provider has seen revoked, rejected or past its expiry. */
  assertUsable(key: DelegatedKey): DelegatedKeyOutcome<DelegatedKey>
}

async function slotId(slot: DelegatedKeySlot): Promise<string> {
  const material = JSON.stringify([
    slot.sourceKey, slot.name, slot.product, slot.resource?.type ?? null, slot.resource?.id ?? null,
    slot.allowedModels ? [...new Set(slot.allowedModels)].sort() : null, slot.budget ?? null, slot.rpmLimit ?? null,
  ])
  // The cache is keyed by a digest, so the payer's key is never a map key.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createDelegatedKeyProvider(options: DelegatedKeyProviderOptions): DelegatedKeyProvider {
  const now = options.now ?? Date.now
  const minRemainingMs = options.minRemainingMs ?? DEFAULT_MIN_REMAINING_MS
  const maxEntries = options.maxEntries ?? 512
  const cache = new Map<string, DelegatedKey>()
  // Keys never to hand out again: revoked, or refused by the product that received them.
  const retired = new Set<string>()

  const usable = (key: DelegatedKey, margin: number) =>
    !retired.has(key.key) && key.expiresAt.getTime() - now() > margin
  const reject = (key: string) => {
    retired.add(key)
    for (const [id, cached] of cache) if (cached.key === key) cache.delete(id)
  }

  return {
    async keyFor(slot) {
      const id = await slotId(slot)
      const cached = cache.get(id)
      if (cached && usable(cached, minRemainingMs)) {
        if (!options.verifyOnReuse) return { succeeded: true, value: cached }
        const status = await options.client.status({ sourceKey: slot.sourceKey, keyId: cached.id })
        if (status.succeeded && status.value.live) return { succeeded: true, value: cached }
        if (status.succeeded) reject(cached.key)
      }
      cache.delete(id)
      const minted = await options.client.delegate({ ...slot, expiresAt: new Date(now() + slot.ttlMs) })
      if (!minted.succeeded) return minted
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!)
      cache.set(id, minted.value)
      return minted
    },

    reject,

    async revoke({ sourceKey, key }) {
      reject(key.key)
      return options.client.revoke({ sourceKey, keyId: key.id })
    },

    assertUsable(key) {
      if (retired.has(key.key)) return fail(401, 'delegated_key.revoked', 'This key was revoked; request a new one.')
      if (key.expiresAt.getTime() <= now()) return fail(401, 'delegated_key.expired', 'This key has expired; request a new one.')
      return { succeeded: true, value: key }
    },
  }
}
