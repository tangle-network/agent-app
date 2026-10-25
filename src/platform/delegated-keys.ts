/**
 * Delegated product keys: a child key minted from the paying user's linked
 * Tangle key, scoped to one product, its models and its budget, so an app
 * never sends the user's own key to Router or Sandbox.
 *
 * WHY ONE. Seven apps minted these by hand (Tax, Legal, GTM, Creative,
 * Builder, Hardware, workcomp; survey) with different scope,
 * expiry and revocation rules, and four never noticed a key Platform had
 * revoked, superseded or expired.
 *
 * THREE WAYS TO HOLD ONE.
 * - Per turn: `client.delegate` before the turn, `client.revoke` after it.
 *   Nothing is cached, so nothing stale can be handed out.
 * - Pre-minted per turn: `createDelegatedTurnKeys` (`./delegated-turn-keys`) gives each turn its own
 *   child, same cap and expiry, but mints the next turn's child in the
 *   background and parks it in D1, so the ~320 ms mint leaves the turn's
 *   critical path. A parked key is taken exactly once; anything else mints
 *   inline as before.
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

import { platformBaseUrlFromEnv } from './deployment'

const REQUEST_TIMEOUT_MS = 10_000
// Backoff while Platform cannot answer a delegation: 250 ms doubling to 5 s, with jitter.
const UNAVAILABLE_BASE_DELAY_MS = 250
const UNAVAILABLE_MAX_DELAY_MS = 5_000
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
  | 'delegated_key.failed'
  | 'delegated_key.response_invalid'
  | 'delegated_key.invalid_request'

export interface DelegatedKeyRefusal {
  status: number
  code: DelegatedKeyCode
  message: string
  /** Set when an untrusted child could not be revoked: the id (never the key) the app must retire. */
  unrevokedKeyId?: string
  /** Platform's own error code (never its message) for a decision this client does not type, for logs. */
  platformCode?: string
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
  /** The logical slot, e.g. `turn:<id>`. Sent as Platform's canonical name; see {@link canonicalDelegatedKeyName}.
   *  A slot holds one key: a new delegation under the same name revokes (or supersedes) the key holding it
   *  (Platform key-provisioning `revokeKeySubtrees`). Two attempts that may run at once, such as a transport retry
   *  beside the attempt it replaces, need distinct names, or the second revokes the first mid-turn. */
  name: string
  product: 'router' | 'sandbox' | (string & {})
  resource?: { type: string; id: string }
  /** The only models the child may call. */
  allowedModels?: readonly string[]
  budget?: DelegatedKeyBudget
  rpmLimit?: number
  expiresAt: Date
  /** Checked against the child's attribution when given: the payer's Platform user id, the source key's id, and
   *  the origin app Platform carries over from the source (an app's SSO key; a personal key has none). */
  expect?: { payerId?: string; sourceKeyId?: string; originAppId?: string | null }
  /**
   * Keep asking while Platform answers `delegated_key.unavailable` (no answer, 5xx, 429, busy), with jittered
   * backoff, for at most `forMs` from the first attempt; then return that refusal. Platform's origin was unreachable
   * for 84.8 s and 54.5 s across restarts, and each such failure ended a member's Router turn, so a
   * turn-scoped mint passes about 90 000 here, inside its turn's budget. `signal` stops the wait early. A retried
   * request may have reached Platform; the next attempt uses the same name, so it replaces that child in its slot
   * rather than leaving a second one.
   */
  retryUnavailable?: { forMs: number; signal?: AbortSignal }
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
  /** Platform origin. Default: TANGLE_PLATFORM_URL or TANGLE_SSO_URL from the request environment. */
  platformUrl?: string
  /** This app's Platform service name; Platform admits delegation per named service. */
  serviceName: string
  /** Default: lazily read PLATFORM_SERVICE_TOKEN; missing configuration fails closed. */
  serviceToken?: string | (() => string)
  fetch?: typeof fetch
  now?: () => number
}

/** Platform's `verify-by-id` verdict on one key, secret-free. */
export interface DelegatedKeyVerdict {
  valid: boolean
  /** Platform's reason when not valid, e.g. `key_revoked`, `budget_exhausted`. */
  invalidReason?: string
  budgetUsd?: number
  budgetRemaining?: number
  expiresAt?: string
}

/**
 * Identifies a key's slot for Platform's service-authenticated `revoke-slot`. Without `name` and `product`,
 * the client reads them from the key itself (`GET /v1/keys/:id`, which an SSO source may call), so a
 * provisioner restarted since the mint can still retire the key. Tax and Legal need `sourceKeyId`; GTM
 * and Builder admit `revoke-slot` only for their protected and preview keys, so their other keys keep
 * the refused DELETE as a typed error.
 */
export interface DelegatedKeySlotRef {
  userId: string
  name?: string
  product?: string
  sourceKeyId?: string
}

export interface PlatformDelegatedKeyClient {
  delegate(request: DelegatedKeyRequest): Promise<DelegatedKeyOutcome<DelegatedKey>>
  /** Platform's authoritative verdict (`verify-by-id`), including revoked, expired and spent keys. */
  verify(input: { keyId: string; product: string }): Promise<DelegatedKeyOutcome<DelegatedKeyVerdict>>
  /**
   * `DELETE /v1/keys/:id` with the source key; a key already gone counts as revoked. Platform refuses key
   * mutations from a service-provisioned source (an app's SSO key) with 403; given `slot`, the client then
   * retires the slot through `revoke-slot` with the service token.
   */
  revoke(input: { sourceKey: string; keyId: string; slot?: DelegatedKeySlotRef }): Promise<DelegatedKeyOutcome<null>>
  /** Children of the source key in one slot, from `GET /v1/keys` with the source key. */
  listChildren(input: { sourceKey: string; name: string; product: string }): Promise<DelegatedKeyOutcome<Array<{ id: string }>>>
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
  // Only an authorization answer is a refusal. Any other 4xx is a decision about this request (Platform's
  // 400 DELEGATION_FAILED, say), kept as its own status with Platform's code so it is not mistaken for
  // a credential problem. The message stays out: it can name Platform internals.
  const platformCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined
  if (status === 401 || status === 403 || status < 400) {
    return { status: 403, code: 'delegated_key.refused', message: 'Platform refused to delegate this key.', ...(platformCode ? { platformCode } : {}) }
  }
  return {
    status,
    code: 'delegated_key.failed',
    message: `Platform declined this delegation${platformCode ? ` (${platformCode})` : ''}.`,
    ...(platformCode ? { platformCode } : {}),
  }
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
  // Omitted, the child inherits the source's model restriction, which only narrows it.
  if (request.allowedModels && !sameSet(data.allowedModels, request.allowedModels)) return 'a different model set'
  const budget = request.budget
  if (budget && 'usd' in budget && !(typeof data.budgetUsd === 'number' && data.budgetUsd <= budget.usd)) return 'a budget larger than requested'
  if (budget?.monthlyUsd !== undefined && !(typeof data.monthlyBudgetUsd === 'number' && data.monthlyBudgetUsd <= budget.monthlyUsd)) {
    return 'a monthly budget larger than requested'
  }

  const attribution = record(data.attribution)
  if (!attribution) return 'no attribution'
  if (attribution.version !== 1 || attribution.targetService !== request.product) return 'attribution for another target'
  if (request.expect?.originAppId !== undefined && (attribution.originAppId ?? null) !== request.expect.originAppId) {
    return 'attribution from another app'
  }
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
  const env = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const origin = options.platformUrl ?? platformBaseUrlFromEnv()
  const base = options.platformUrl ? origin.replace(/\/+$/, '') : new URL(origin).origin
  const serviceToken = () => {
    if (options.serviceToken !== undefined) return typeof options.serviceToken === 'function' ? options.serviceToken() : options.serviceToken
    const token = env()?.PLATFORM_SERVICE_TOKEN?.trim()
    if (!token) throw new Error('PLATFORM_SERVICE_TOKEN is required for delegated product keys')
    return token
  }

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

  async function delegateOnce(request: DelegatedKeyRequest): Promise<DelegatedKeyOutcome<DelegatedKey>> {
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
        // Omitted, Platform copies the source's scopes onto the child; a product key carries none.
        scopes: [],
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
      const owner = request.expect?.payerId
        ? { userId: request.expect.payerId, name, product: request.product,
            ...(request.expect.sourceKeyId ? { sourceKeyId: request.expect.sourceKeyId } : {}) }
        : undefined
      const revoked = id ? await client.revoke({ sourceKey: request.sourceKey, keyId: id, ...(owner ? { slot: owner } : {}) }) : null
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
  }

  /** Wait before the next attempt, or answer false when the window or the signal says stop. */
  async function backoff(attempt: number, deadline: number, signal: AbortSignal | undefined): Promise<boolean> {
    const delay = Math.min(UNAVAILABLE_MAX_DELAY_MS, UNAVAILABLE_BASE_DELAY_MS * 2 ** attempt) * (0.5 + Math.random() / 2)
    if (signal?.aborted || Date.now() + delay > deadline) return false
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    return !signal?.aborted
  }

  const client: PlatformDelegatedKeyClient = {
    async delegate(request) {
      const retry = request.retryUnavailable
      const deadline = Date.now() + Math.max(0, retry?.forMs ?? 0)
      for (let attempt = 0; ; attempt++) {
        const outcome = await delegateOnce(request)
        if (outcome.succeeded || outcome.error.code !== 'delegated_key.unavailable' || !retry) return outcome
        if (!(await backoff(attempt, deadline, retry.signal))) return outcome
      }
    },

    async verify({ keyId, product }) {
      const result = await call('/v1/keys/verify-by-id', {
        method: 'POST', bearer: serviceToken(), service: true, body: { keyId, expectedProduct: product },
      })
      // Fail closed: anything but a well-formed verdict for this key is not evidence about it.
      if (!result || result.status >= 500 || result.status === 429) return { succeeded: false, error: refusal(503, null) }
      const body = result.body
      if (result.status !== 200 || typeof body?.valid !== 'boolean' || (body.valid && body.keyId !== keyId)) {
        return failure(502, 'delegated_key.response_invalid', 'Platform returned no verification verdict for this key.')
      }
      const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
      return { succeeded: true, value: {
        valid: body.valid,
        ...(typeof body.invalidReason === 'string' ? { invalidReason: body.invalidReason } : {}),
        ...(number(body.budgetUsd) !== undefined ? { budgetUsd: number(body.budgetUsd) } : {}),
        ...(number(body.budgetRemaining) !== undefined ? { budgetRemaining: number(body.budgetRemaining) } : {}),
        ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
      } }
    },

    async revoke({ sourceKey, keyId, slot }) {
      const result = await call(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', bearer: sourceKey, service: false })
      if (!result) return { succeeded: false, error: refusal(503, null) }
      if (result.status === 404 || (result.status >= 200 && result.status < 300 && result.body?.success === true)) {
        return { succeeded: true, value: null }
      }
      if (result.status === 403 && slot) {
        let name = slot.name
        let product = slot.product
        if (!name || !product) {
          const row = await call(`/v1/keys/${encodeURIComponent(keyId)}`, { method: 'GET', bearer: sourceKey, service: false })
          const data = record(row?.body?.data)
          if (row?.status === 404) return { succeeded: true, value: null }
          if (!row || row.status !== 200 || typeof data?.name !== 'string' || typeof data.product !== 'string') {
            return { succeeded: false, error: refusal(row?.status ?? 503, null) }
          }
          if (data.revokedAt) return { succeeded: true, value: null }
          name = data.name
          product = data.product
        }
        const retired = await call('/v1/keys/auto-provisioned/revoke-slot', {
          method: 'POST', bearer: serviceToken(), service: true, body: {
            userId: slot.userId, name, product, childKeyId: keyId,
            ...(slot.sourceKeyId ? { sourceKeyId: slot.sourceKeyId } : {}),
          },
        })
        if (!retired) return { succeeded: false, error: refusal(503, null) }
        if (retired.status >= 200 && retired.status < 300 && retired.body?.success === true) return { succeeded: true, value: null }
        return { succeeded: false, error: refusal(retired.status, record(retired.body?.error)?.code) }
      }
      return { succeeded: false, error: refusal(result.status, record(result.body?.error)?.code) }
    },

    async listChildren({ sourceKey, name, product }) {
      const canonical = canonicalDelegatedKeyName({ serviceName: options.serviceName, product, name })
      const result = await call('/v1/keys', { method: 'GET', bearer: sourceKey, service: false })
      if (!result) return { succeeded: false, error: refusal(503, null) }
      const rows = result.body?.data
      if (result.status !== 200 || result.body?.success !== true || !Array.isArray(rows)) {
        return { succeeded: false, error: refusal(result.status, record(result.body?.error)?.code) }
      }
      return { succeeded: true, value: rows.flatMap((row) => {
        const value = record(row)
        return value && typeof value.id === 'string' && value.name === canonical && value.product === product && !value.revokedAt
          ? [{ id: value.id }] : []
      }) }
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

/** Platform reasons that mean the key will never work again: the manager revokes the row and mints a fresh key. */
const GONE_REASONS = new Set([
  'key_not_found', 'key_revoked', 'key_expired', 'key_lineage_revoked',
  'parent_key_not_found', 'parent_key_revoked', 'parent_key_expired', 'parent_key_lineage_revoked',
  'ancestor_key_not_found', 'ancestor_key_revoked', 'ancestor_key_expired', 'ancestor_key_lineage_revoked',
])
const SPENT_REASONS = new Set(['budget_exhausted', 'monthly_budget_exhausted'])

/**
 * Plug the client into `createIdentityBoundWorkspaceKeyManager` for a
 * workspace-held key. Pass the manager `nameForIdentity` returning a logical
 * slot name (the client sends Platform's canonical `auto:` form).
 *
 * `getKey` reads Platform's verdict: a key gone for good is reported missing
 * (the manager marks it revoked and mints again); a spent key is reported
 * exhausted (the manager revokes it remotely and mints again); a funding or
 * eligibility refusal is a typed error, so a lapse never retires a key that
 * still works.
 */
export function createDelegatedKeyProvisioner(input: {
  client: PlatformDelegatedKeyClient
  sourceKey: string
  product: string
  resource?: { type: string; id: string }
  allowedModels?: readonly string[]
  monthlyBudgetUsd?: number
  rpmLimit?: number
  expect?: { payerId?: string; sourceKeyId?: string; originAppId?: string | null }
  /** Enables the `revoke-slot` fallback when the source is an app's SSO key (Platform refuses its key mutations). */
  payerId?: string
}): DelegatedKeyProvisioner {
  const product = input.product
  // The revoke-slot fallback needs the payer; the client reads each key's slot name itself.
  const slotOwner: DelegatedKeySlotRef | undefined = input.payerId
    ? { userId: input.payerId, ...(input.expect?.sourceKeyId ? { sourceKeyId: input.expect.sourceKeyId } : {}) }
    : undefined
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
      const verdict = await input.client.verify({ keyId: id, product })
      if (!verdict.succeeded) throw new DelegatedKeyRefusalError(verdict.error)
      const v = verdict.value
      if (v.valid) {
        return {
          ...(v.budgetUsd !== undefined ? { budgetUsd: v.budgetUsd } : {}),
          ...(v.budgetUsd !== undefined && v.budgetRemaining !== undefined ? { budgetSpent: Math.max(0, v.budgetUsd - v.budgetRemaining) } : {}),
          ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}),
        }
      }
      if (v.invalidReason && GONE_REASONS.has(v.invalidReason)) throw new DelegatedKeyMissingError(id)
      if (v.invalidReason && SPENT_REASONS.has(v.invalidReason)) {
        // Spent: the manager sees no budget left and revokes the child before minting again.
        return { budgetUsd: v.budgetUsd ?? 0, budgetSpent: v.budgetUsd ?? 0, ...(v.expiresAt ? { expiresAt: v.expiresAt } : {}) }
      }
      throw new DelegatedKeyRefusalError({ status: 403, code: 'delegated_key.refused',
        message: `Platform refused the key for now (${v.invalidReason ?? 'no reason'}).` })
    },
    async revokeKey(id) {
      const revoked = await input.client.revoke({ sourceKey: input.sourceKey, keyId: id, ...(slotOwner ? { slot: slotOwner } : {}) })
      if (!revoked.succeeded) throw new DelegatedKeyRefusalError(revoked.error)
      return null
    },
    async findCreatedKeys(find) {
      const listed = await input.client.listChildren({ sourceKey: input.sourceKey, name: find.name, product: find.product })
      if (!listed.succeeded) throw new DelegatedKeyRefusalError(listed.error)
      return listed.value
    },
  }
}
