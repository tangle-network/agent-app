import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createIdentityBoundWorkspaceKeyManager,
  type DurableWorkspaceKeyProvisioningRecord,
  type DurableWorkspaceKeyRecord,
  type DurableWorkspaceKeyStore,
} from '../src/billing/index'
import { createDelegatedKeyProvisioner, createPlatformDelegatedKeyClient } from '../src/platform/delegated-keys'
import { runRouterTurn } from '../src/runtime/router-turn'

const START = Date.parse('2026-11-16T00:00:00.000Z')
const MINUTE = 60_000
const SOURCE_KEY = 'sk-tan-source-1'
const SOURCE_ID = 'key_src'

type Child = { id: string; key: string; name: string; product: string; budgetUsd: number | null; spentUsd: number; expiresAt: string
  revoked: boolean }

/**
 * A loopback Platform and Router with Platform's budget rules for one budgeted source: a sized child reserves its
 * budget on the source and refuses a mint the source's unreserved remainder cannot cover (402 KEY_BUDGET_EXHAUSTED); a
 * spend-through child reserves nothing, and the source's cap refuses each Router request once it is spent.
 */
async function budgetedPlatform(clock: { now: number }) {
  const source = { budgetUsd: 25, spentUsd: 0, reservedUsd: 0 }
  const children = new Map<string, Child>()
  const peer = { source, children, mints: [] as number[], deletes: 0, requestCostUsd: 12.5, url: '', close: async () => {} }
  const remaining = () => source.budgetUsd - source.spentUsd - source.reservedUsd
  const live = (child: Child | undefined) => child && !child.revoked && Date.parse(child.expiresAt) > clock.now ? child : undefined
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
      const refuse = (status: number, code: string) => json(status, { success: false, error: { code } })
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, any>
      const path = new URL(request.url!, 'http://peer').pathname
      const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      if (path === '/v1/chat/completions') {
        const child = live([...children.values()].find((candidate) => candidate.key === bearer))
        if (!child) return refuse(401, 'invalid_key')
        const capRemaining = child.budgetUsd === null ? remaining() : child.budgetUsd - child.spentUsd
        if (capRemaining <= 0) return json(402, { error: { code: 'key_budget_exhausted', message: 'The key has spent its budget.' } })
        if (child.budgetUsd === null) source.spentUsd += peer.requestCostUsd
        else child.spentUsd += peer.requestCostUsd
        response.writeHead(200, { 'content-type': 'text/event-stream' })
          .end(`data: ${JSON.stringify({ model: 'served/model', choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      const byId = /^\/v1\/keys\/([A-Za-z0-9_]+)$/.exec(path)
      if (byId && request.method === 'DELETE') {
        const child = children.get(byId[1]!)
        if (bearer !== SOURCE_KEY) return refuse(401, 'UNAUTHORIZED')
        if (!child) return refuse(404, 'NOT_FOUND')
        peer.deletes += 1
        if (!child.revoked && child.budgetUsd !== null) {
          source.reservedUsd -= child.budgetUsd
          source.spentUsd += child.spentUsd
        }
        child.revoked = true
        return json(200, { success: true })
      }
      if (path === '/v1/keys' && request.method === 'GET') {
        if (bearer !== SOURCE_KEY) return refuse(401, 'UNAUTHORIZED')
        return json(200, { success: true, data: [...children.values()].map((child) => ({ id: child.id, name: child.name,
          product: child.product, revokedAt: child.revoked ? new Date(clock.now).toISOString() : null })) })
      }
      if (bearer !== 'svc-token' || request.headers['x-service-name'] !== 'svc-app') return refuse(401, 'UNAUTHORIZED')
      if (path === '/v1/keys/delegate') {
        if (body.sourceKey !== SOURCE_KEY) return refuse(403, 'SOURCE_KEY_INVALID')
        const spendThrough = body.spendThrough === true
        const budgetUsd = spendThrough ? null : Number(body.budgetUsd)
        if (remaining() <= 0 || (budgetUsd !== null && budgetUsd > remaining())) {
          peer.mints.push(402)
          return refuse(402, 'KEY_BUDGET_EXHAUSTED')
        }
        if (budgetUsd !== null) source.reservedUsd += budgetUsd
        const id = `key_child_${children.size + 1}`
        const child: Child = { id, key: `sk-tan-child${children.size + 1}xxxxxxxxxxxx`, name: body.name, product: body.product, budgetUsd,
          spentUsd: 0, expiresAt: body.expiresAt, revoked: false }
        children.set(id, child)
        peer.mints.push(201)
        return json(201, { success: true, data: { id, key: child.key, name: body.name, provisionedByService: 'svc-app',
          product: body.product, scopes: null, budgetUsd,
          attribution: { version: 1, targetService: body.product, delegatedFromKeyId: SOURCE_ID, payerType: 'user', payerId: 'usr_1',
            resourceType: null, resourceId: null, expiresAt: body.expiresAt } } })
      }
      if (path === '/v1/keys/verify-by-id') {
        const child = children.get(String(body.keyId))
        if (!child) return json(200, { valid: false, invalidReason: 'key_not_found' })
        if (child.revoked) return json(200, { valid: false, invalidReason: 'key_revoked' })
        if (!live(child)) return json(200, { valid: false, invalidReason: 'key_expired' })
        // Verify applies a spend-through child's lineage cap: the source's remainder.
        const left = child.budgetUsd === null ? remaining() : child.budgetUsd - child.spentUsd
        if (left <= 0) return json(200, { valid: false, invalidReason: 'budget_exhausted', ...(child.budgetUsd === null ? {} : { budgetUsd: child.budgetUsd }) })
        return json(200, { valid: true, keyId: child.id, ...(child.budgetUsd === null ? {} : { budgetUsd: child.budgetUsd }),
          budgetRemaining: left, expiresAt: child.expiresAt })
      }
      return refuse(404, 'NOT_FOUND')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  peer.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  peer.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return peer
}

function memoryStore(): DurableWorkspaceKeyStore {
  const rows = new Map<string, DurableWorkspaceKeyRecord>()
  const leases = new Map<string, string>()
  const update = (id: string, change: Partial<DurableWorkspaceKeyRecord>) => { Object.assign(rows.get(id)!, change) }
  return {
    async getActive(scope) {
      return [...rows.values()].reverse().find((row) => row.status === 'active' && row.workspaceId === scope.workspaceId
        && row.ownerUserId === scope.ownerUserId && row.product === scope.product) ?? null
    },
    async listProvisioning(scope) {
      return [...rows.values()].filter((row): row is DurableWorkspaceKeyProvisioningRecord => row.status === 'provisioning'
        && row.workspaceId === scope.workspaceId && row.ownerUserId === scope.ownerUserId && row.product === scope.product)
    },
    async insertProvisioning(record) { rows.set(record.id, { ...record }) },
    async markProvisioningRemote(input) { update(input.id, { keyId: input.keyId }) },
    async markActive(input) { update(input.id, { ...input, status: 'active' }) },
    async markRevocationPending(input) {
      const row = rows.get(input.id)!
      if (row.status === 'revoked' || row.status === 'orphaned') return
      update(input.id, { status: 'revocation_pending', nextRevocationAt: input.nextAttemptAt, lastRevocationError: input.error ?? null,
        revocationAttempts: row.revocationAttempts + (input.incrementAttempts ? 1 : 0) })
    },
    async markRevoked(id) { update(id, { status: 'revoked', nextRevocationAt: null }) },
    async markOrphaned(id, error) { update(id, { status: 'orphaned', lastRevocationError: error, nextRevocationAt: null }) },
    async listPendingRevocations(input) {
      return [...rows.values()].filter((row) => row.status === 'revocation_pending' && row.product === input.product
        && (input.workspaceId === undefined || row.workspaceId === input.workspaceId)
        && (input.ownerUserId === undefined || row.ownerUserId === input.ownerUserId)
        && (input.includeFuture || !row.nextRevocationAt || row.nextRevocationAt <= input.now)).slice(0, input.limit)
    },
    async acquireLease(scope, operationId) {
      const held = leases.get(scope)
      if (held && held !== operationId) return false
      leases.set(scope, operationId)
      return true
    },
    async renewLease(scope, operationId) { return leases.get(scope) === operationId },
    async releaseLease(scope, operationId) { if (leases.get(scope) === operationId) leases.delete(scope) },
  }
}

describe('workspace child keys from a budgeted source', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => { await close?.(); close = null })

  it('spend through the source cap: live children reserve nothing, and a spent source refuses per request', async () => {
    const clock = { now: START }
    const peer = await budgetedPlatform(clock)
    close = peer.close
    const client = createPlatformDelegatedKeyClient({ platformUrl: peer.url, serviceName: 'svc-app', serviceToken: 'svc-token', now: () => clock.now })
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: memoryStore(),
      provisioner: createDelegatedKeyProvisioner({ client, sourceKey: SOURCE_KEY, product: 'router',
        expect: { payerId: 'usr_1', sourceKeyId: SOURCE_ID }, payerId: 'usr_1' }),
      crypto: { async encrypt(secret) { return `encrypted:${secret}` }, async decrypt(secret) { return secret.slice('encrypted:'.length) } },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(clock.now),
      // 55 min keys reused for 10 min: a member holds a new child every 10 min while older ones live out their turns.
      keyLifetimeMs: 55 * MINUTE,
      minRemainingLifetimeMs: 45 * MINUTE,
      nameForIdentity: (identity, operationId) => `ws:${identity.workspaceId}:${operationId}`,
    })
    const identity = { workspaceId: 'workspace-1', ownerUserId: 'owner-1', platformUserId: 'usr_1', sourceKeyId: SOURCE_ID,
      sourceKeyFingerprint: 'fingerprint-source-1' }
    // What a consumer passes for a source Platform reports a budget for.
    const childBudget = { budgetUsd: 10, spendThrough: true as const }

    const statuses: number[] = []
    let held = ''
    for (let mint = 0; mint < 3; mint += 1) {
      if (mint > 0) clock.now += 11 * MINUTE
      statuses.push(await manager.ensureKey(identity, childBudget).then((issued) => {
        held = issued.key
        expect(issued.refreshed).toBe(true)
        return 201
      }, (error: { refusal?: { status?: number } }) => error.refusal?.status ?? 500))
    }
    // Three live children: a reservation each would hold 30 USD of a 25 USD source and refuse the third mint.
    expect(statuses).toEqual([201, 201, 201])
    expect([...peer.children.values()].filter((child) => !child.revoked && Date.parse(child.expiresAt) > clock.now)).toHaveLength(3)
    expect(peer.source.reservedUsd).toBe(0)

    const turn = () => runRouterTurn({ apiKey: held, model: 'm', baseUrl: `${peer.url}/v1`, repeat: false, systemPrompt: 's', userMessage: 'u' })
    expect((await turn()).failure).toBeUndefined()
    expect((await turn()).failure).toBeUndefined()
    expect(peer.source.spentUsd).toBe(25)

    // The spent source refuses the next request on the live child, with a message the member can act on.
    const refused = await turn()
    expect(refused.failure).toMatchObject({ code: 'model_http_402', status: 402 })
    expect(refused.failure?.message).toMatch(/top (it )?up/i)

    // The spent source is not the child's own exhaustion: the manager keeps the child, so no mint-retire churn.
    const mintsBefore = peer.mints.length
    for (let read = 0; read < 3; read += 1) {
      clock.now += MINUTE
      const reused = await manager.ensureKey(identity, childBudget)
      expect(reused).toMatchObject({ key: held, refreshed: false, usage: { exhausted: false } })
    }
    expect(peer.mints).toHaveLength(mintsBefore)
    expect(peer.deletes).toBe(0)
  })

  it('keeps sized children for a source without a budget', async () => {
    const clock = { now: START }
    const peer = await budgetedPlatform(clock)
    close = peer.close
    peer.source.budgetUsd = Number.POSITIVE_INFINITY
    const client = createPlatformDelegatedKeyClient({ platformUrl: peer.url, serviceName: 'svc-app', serviceToken: 'svc-token', now: () => clock.now })
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: memoryStore(),
      provisioner: createDelegatedKeyProvisioner({ client, sourceKey: SOURCE_KEY, product: 'router' }),
      crypto: { async encrypt(secret) { return `encrypted:${secret}` }, async decrypt(secret) { return secret.slice('encrypted:'.length) } },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(clock.now),
      nameForIdentity: (identity, operationId) => `ws:${identity.workspaceId}:${operationId}`,
    })
    const issued = await manager.ensureKey({ workspaceId: 'workspace-1', ownerUserId: 'owner-1', platformUserId: 'usr_1',
      sourceKeyId: SOURCE_ID, sourceKeyFingerprint: 'fingerprint-source-1' }, { budgetUsd: 10 })
    expect(issued.usage).toMatchObject({ budgetUsd: 10, budgetRemaining: 10, exhausted: false })
    expect([...peer.children.values()][0]?.budgetUsd).toBe(10)
  })
})
