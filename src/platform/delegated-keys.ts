/**
 * Delegated product keys: a child key minted from the paying user's linked
 * Tangle key, scoped to one product, its models and its budget, so an app
 * never sends the user's own key to Router or Sandbox.
 *
 * WHY ONE. Seven apps minted these by hand (Tax, Legal, GTM, Creative,
 * Builder, Hardware, workcomp; survey 2026-10-12) with different scope,
 * expiry and revocation rules, and four never noticed a key Platform had
 * revoked, superseded or expired.
 *
 * TWO WAYS TO HOLD ONE.
 * - Per turn: `client.delegate` before the turn, `client.revoke` after it.
 *   Nothing is cached, so nothing stale can be handed out.
 * - Per workspace: `createDelegatedKeyProvisioner` plugs this client into
 *   `createIdentityBoundWorkspaceKeyManager` (`./billing`), which owns the
 *   durable, lease-fenced slot. Its `getKey` asks Platform's
 *   `verify-by-id`, which also refuses superseded generations, and reports
 *   any key that is not valid as missing, so the manager marks it revoked
 *   and mints a fresh one on the next use.
 *
 * THE MINT CONTRACT (`POST /v1/keys/delegate`, service-authenticated; the
 * response is the key row plus `attribution`, and the granted expiry is
 * `attribution.expiresAt`). The child is checked field by field: an
 * `sk-tan-` key that is not the source, the canonical name, this service as
 * provisioner and attribution origin, the requested product, resource, model
 * set and payer, a budget no larger than requested, and an expiry in the
 * future and no later than requested. A child that fails is revoked and
 * refused; if that revoke fails too, the refusal carries the child's id (never
 * its key) so the app can retire it.
 *
 * Errors carry a code and status, never a response body, a source key or a
 * child key.
 */

const REQUEST_TIMEOUT_MS = 10_000
const KEY_PREFIX = 'sk-tan-'
const AUTO_PREFIX = 'auto:'
/** Products whose key names Platform qualifies as `auto:<service>:<product>:...` (key-provenance.ts). */
const PRODUCT_QUALIFIED = new Set(['router', 'sandbox'])

export type DelegatedKeyCode =
  | 'delegated_key.payment_required'
  | 'delegated_key.budget_exhausted'
  | 'delegated_key.owner_unverified'
  | 'delegated_key.unavailable'
  | 'delegated_key.refused'
  | 'delegated_key.response_invalid'
  | 'delegated_key.invalid_request'

export interface DelegatedKeyRefusal {
  status: number
  code: DelegatedKeyCode
  message: string
  /** Set when an untrusted child could not be revoked: the id (never the key) the app must retire. */
  unrevokedKeyId?: string
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
  /** The logical slot, e.g. `turn:<id>`. Sent as Platform's canonical name; see {@link canonicalDelegatedKeyName}. */
  name: string
  product: 'router' | 'sandbox' | (string & {})
  resource?: { type: string; id: string }
  /** The only models the child may call. */
  allowedModels?: readonly string[]
  budget?: DelegatedKeyBudget
  rpmLimit?: number
  expiresAt: Date
  /** Checked against the child's attribution when given: the payer's Platform user id and the source key's id. */
  expect?: { payerId?: string; sourceKeyId?: string }
}

export interface DelegatedKey {
  key: string
  id: string
  /** The canonical name Platform stored. */
  name: string
  product: string
  /** The expiry Platform granted (`attribution.expiresAt`), never later than requested. */
  expiresAt: Date
  allowedModels: readonly string[] | null
  budgetUsd: number | null
}

export interface PlatformDelegatedKeyClientOptions {
  /** Platform origin, e.g. `https://id.tangle.tools`. */
  platformUrl: string
  /** This app's Platform service name; Platform admits delegation per named service. */
  serviceName: string
  serviceToken: string | (() => string)
  fetch?: typeof fetch
  now?: () => number
}

export interface PlatformDelegatedKeyClient {
  delegate(request: DelegatedKeyRequest): Promise<DelegatedKeyOutcome<DelegatedKey>>
  /** Platform's authoritative answer (`verify-by-id`): false once the key is revoked, superseded, expired or spent. */
  live(input: { keyId: string; product: string }): Promise<DelegatedKeyOutcome<boolean>>
  /** `DELETE /v1/keys/:id` with the source key. A key already gone counts as revoked. */
  revoke(input: { sourceKey: string; keyId: string }): Promise<DelegatedKeyOutcome<null>>
}

/**
 * The name Platform stores for a slot: `auto:<service>:<product>:<logical>` for
 * Router and Sandbox keys (Platform's `canonicalProvisionedKeyName`), so the
 * echo can be checked exactly. A name already qualified is kept.
 */
export function canonicalDelegatedKeyName(input: { serviceName: string; product: string; name: string }): string {
  const logical = input.name.startsWith(AUTO_PREFIX) ? input.name.slice(AUTO_PREFIX.length) : input.name
  if (!PRODUCT_QUALIFIED.has(input.product)) return `${AUTO_PREFIX}${logical}`
  if (logical.startsWith(`${input.serviceName}:${input.product}:`)) return `${AUTO_PREFIX}${logical}`
  const withoutService = logical.startsWith(`${input.serviceName}:`) ? logical.slice(input.serviceName.length + 1) : logical
  return `${AUTO_PREFIX}${input.serviceName}:${input.product}:${withoutService}`
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
    return { status: 503, code: 'delegated_key.unavailable', message: 'Platform could not answer; retry.' }
  }
  return { status: 403, code: 'delegated_key.refused', message: 'Platform refused to delegate this key.' }
}

const failure = <T,>(status: number, code: DelegatedKeyCode, message: string, extra: Partial<DelegatedKeyRefusal> = {}): DelegatedKeyOutcome<T> =>
  ({ succeeded: false, error: { status, code, message, ...extra } })

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function sameSet(granted: unknown, requested: readonly string[]): boolean {
  if (!Array.isArray(granted) || granted.some(model => typeof model !== 'string')) return false
  const a = [...new Set(granted as string[])].sort()
  const b = [...new Set(requested)].sort()
  return granted.length === a.length && a.length === b.length && a.every((model, index) => model === b[index])
}

/** Why the minted child cannot be trusted, or null. Each check names its field, never its value. */
function childProblem(data: Record<string, unknown>, request: DelegatedKeyRequest, name: string, serviceName: string, nowMs: number): string | null {
  const key = data.key
  const id = data.id
  if (typeof id !== 'string' || !id) return 'no key id'
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length <= KEY_PREFIX.length) return 'not an sk-tan child key'
  if (key === request.sourceKey) return 'the source key itself'
  if (typeof data.prefix === 'string' && !key.startsWith(data.prefix)) return 'a key that does not match its prefix'
  if (data.name !== name) return 'a different name'
  if (data.product !== request.product) return 'a different product'
  if (data.provisionedByService !== serviceName) return 'a different provisioner'
  if (data.scopes !== null && !(Array.isArray(data.scopes) && data.scopes.length === 0)) return 'control-plane scopes'
  if (request.allowedModels ? !sameSet(data.allowedModels, request.allowedModels) : data.allowedModels != null) return 'a different model set'
  const budget = request.budget
  if (budget && 'usd' in budget && !(typeof data.budgetUsd === 'number' && data.budgetUsd <= budget.usd)) return 'a budget larger than requested'
  if (budget?.monthlyUsd !== undefined && !(typeof data.monthlyBudgetUsd === 'number' && data.monthlyBudgetUsd <= budget.monthlyUsd)) {
    return 'a monthly budget larger than requested'
  }

  const attribution = record(data.attribution)
  if (!attribution) return 'no attribution'
  if (attribution.version !== 1 || attribution.targetService !== request.product) return 'attribution for another target'
  if (attribution.originAppId !== serviceName) return 'attribution from another app'
  const parent = attribution.delegatedFromKeyId
  if (typeof parent !== 'string' || !parent || parent === id) return 'attribution without its parent key'
  if (request.expect?.sourceKeyId !== undefined && parent !== request.expect.sourceKeyId) return 'attribution for another source key'
  if (attribution.payerType !== 'user') return 'attribution to a non-user payer'
  if (request.expect?.payerId !== undefined && attribution.payerId !== request.expect.payerId) return 'attribution to another payer'
  if ((attribution.resourceType ?? null) !== (request.resource?.type ?? null) || (attribution.resourceId ?? null) !== (request.resource?.id ?? null)) {
    return 'attribution for another resource'
  }
  const expiresAt = typeof attribution.expiresAt === 'string' ? Date.parse(attribution.expiresAt) : NaN
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt > request.expiresAt.getTime()) return 'an expiry in the past or past the request'
  return null
}

export function createPlatformDelegatedKeyClient(options: PlatformDelegatedKeyClientOptions): PlatformDelegatedKeyClient {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const base = options.platformUrl.replace(/\/+$/, '')
  const serviceToken = () => typeof options.serviceToken === 'function' ? options.serviceToken() : options.serviceToken

  async function call(path: string, init: { method: string; bearer: string; service: boolean; body?: unknown }) {
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
      return { status: response.status, body: record(await response.json().catch(() => null)) }
    } catch {
      return null
    }
  }

  const client: PlatformDelegatedKeyClient = {
    async delegate(request) {
      if (!request.sourceKey.startsWith(KEY_PREFIX)) return failure(400, 'delegated_key.invalid_request', 'The source must be a linked sk-tan- key.')
      if (request.expiresAt.getTime() <= now()) return failure(400, 'delegated_key.invalid_request', 'The expiry must be in the future.')
      const name = canonicalDelegatedKeyName({ serviceName: options.serviceName, product: request.product, name: request.name })
      const budget = request.budget
      const result = await call('/v1/keys/delegate', {
        method: 'POST', bearer: serviceToken(), service: true, body: {
          sourceKey: request.sourceKey,
          name,
          product: request.product,
          ...(request.resource ? { resourceType: request.resource.type, resourceId: request.resource.id } : {}),
          ...(budget && 'usd' in budget ? { budgetUsd: budget.usd } : {}),
          ...(budget && 'spendThrough' in budget ? { spendThrough: true } : {}),
          ...(budget?.monthlyUsd !== undefined ? { monthlyBudgetUsd: budget.monthlyUsd } : {}),
          ...(request.allowedModels ? { allowedModels: [...new Set(request.allowedModels)] } : {}),
          ...(request.rpmLimit !== undefined ? { rpmLimit: request.rpmLimit } : {}),
          expiresAt: request.expiresAt.toISOString(),
        },
      })
      if (!result) return { succeeded: false, error: refusal(503, null) }
      const data = record(result.body?.data)
      if (result.status !== 201 || result.body?.success !== true || !data) {
        return { succeeded: false, error: refusal(result.status, record(result.body?.error)?.code) }
      }
      const problem = childProblem(data, request, name, options.serviceName, now())
      if (problem) {
        // A child Platform minted but this app cannot trust is retired, never returned.
        const id = typeof data.id === 'string' && data.id ? data.id : null
        const revoked = id ? await client.revoke({ sourceKey: request.sourceKey, keyId: id }) : null
        return failure(502, 'delegated_key.response_invalid', `Platform returned ${problem}.`,
          id && !revoked?.succeeded ? { unrevokedKeyId: id } : {})
      }
      const attribution = record(data.attribution)!
      return { succeeded: true, value: {
        key: data.key as string, id: data.id as string, name, product: request.product,
        expiresAt: new Date(attribution.expiresAt as string),
        allowedModels: request.allowedModels ? [...new Set(request.allowedModels)] : null,
        budgetUsd: typeof data.budgetUsd === 'number' ? data.budgetUsd : null,
      } }
    },

    async live({ keyId, product }) {
      const result = await call('/v1/keys/verify-by-id', {
        method: 'POST', bearer: serviceToken(), service: true, body: { keyId, expectedProduct: product },
      })
      // Fail closed: anything but a well-formed answer is not evidence the key is live.
      if (!result || result.status >= 500 || result.status === 429) return { succeeded: false, error: refusal(503, null) }
      if (result.status !== 200 || typeof result.body?.valid !== 'boolean') {
        return failure(502, 'delegated_key.response_invalid', 'Platform returned no verification verdict.')
      }
      return { succeeded: true, value: result.body.valid === true && (result.body.keyId === undefined || result.body.keyId === keyId) }
    },

    async revoke({ sourceKey, keyId }) {
      const result = await call(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', bearer: sourceKey, service: false })
      if (!result) return { succeeded: false, error: refusal(503, null) }
      if (result.status === 404 || (result.status >= 200 && result.status < 300 && result.body?.success === true)) {
        return { succeeded: true, value: null }
      }
      return { succeeded: false, error: refusal(result.status, record(result.body?.error)?.code) }
    },
  }
  return client
}

/** The `DurableWorkspaceKeyProvisioner` shape (`./billing`), kept structural so this module stays standalone. */
export interface DelegatedKeyProvisioner {
  createKey(input: { name: string; product: string; budgetUsd: number; expiresAt: string; idempotencyKey: string }): Promise<{
    id: string; key: string; budgetUsd?: number | null; expiresAt?: string | null
  }>
  getKey(id: string): Promise<{ budgetUsd?: number | null; expiresAt?: string | null }>
  revokeKey(id: string): Promise<unknown>
  findCreatedKeys(input: { name: string; product: string; sourceKeyId?: string | null }): Promise<Array<{ id: string }>>
}

/** A remote key the durable manager must treat as gone (it marks the row revoked and mints again). */
export class DelegatedKeyMissingError extends Error {
  readonly status = 404
  readonly code = 'not_found'
  constructor(keyId: string) {
    super(`Platform no longer accepts key ${keyId}`)
    this.name = 'DelegatedKeyMissingError'
  }
}

/** A Platform refusal surfaced to the durable manager. Carries the typed refusal, never a key. */
export class DelegatedKeyRefusalError extends Error {
  constructor(readonly refusal: DelegatedKeyRefusal) {
    super(refusal.message)
    this.name = 'DelegatedKeyRefusalError'
  }
}

/**
 * Plug the client into `createIdentityBoundWorkspaceKeyManager` for a
 * workspace-held key. Pass the manager `nameForIdentity` returning a logical
 * slot name (the client sends Platform's canonical `auto:` form).
 */
export function createDelegatedKeyProvisioner(input: {
  client: PlatformDelegatedKeyClient
  sourceKey: string
  product: string
  resource?: { type: string; id: string }
  allowedModels?: readonly string[]
  monthlyBudgetUsd?: number
  rpmLimit?: number
  expect?: { payerId?: string; sourceKeyId?: string }
}): DelegatedKeyProvisioner {
  const product = input.product
  return {
    async createKey(create) {
      const minted = await input.client.delegate({
        sourceKey: input.sourceKey, name: create.name, product,
        ...(input.resource ? { resource: input.resource } : {}),
        ...(input.allowedModels ? { allowedModels: input.allowedModels } : {}),
        budget: { usd: create.budgetUsd, ...(input.monthlyBudgetUsd !== undefined ? { monthlyUsd: input.monthlyBudgetUsd } : {}) },
        ...(input.rpmLimit !== undefined ? { rpmLimit: input.rpmLimit } : {}),
        expiresAt: new Date(create.expiresAt),
        ...(input.expect ? { expect: input.expect } : {}),
      })
      if (!minted.succeeded) throw new DelegatedKeyRefusalError(minted.error)
      return { id: minted.value.id, key: minted.value.key, budgetUsd: minted.value.budgetUsd, expiresAt: minted.value.expiresAt.toISOString() }
    },
    async getKey(id) {
      const verdict = await input.client.live({ keyId: id, product })
      if (!verdict.succeeded) throw new DelegatedKeyRefusalError(verdict.error)
      if (!verdict.value) throw new DelegatedKeyMissingError(id)
      return {}
    },
    async revokeKey(id) {
      const revoked = await input.client.revoke({ sourceKey: input.sourceKey, keyId: id })
      if (!revoked.succeeded) throw new DelegatedKeyRefusalError(revoked.error)
      return null
    },
    async findCreatedKeys() {
      // Recovery by name needs a key list this client does not read; the manager then treats the
      // provisioning attempt as orphaned, which is safe: an unknown child expires on its own.
      return []
    },
  }
}
