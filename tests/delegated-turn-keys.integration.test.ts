/**
 * Pre-minted turn keys over real HTTP and real SQL: a local Platform that mints and revokes children in its 201
 * shape, a local Router that refuses a revoked child with 401, and node:sqlite behind the D1 surface. A parked key
 * serves exactly one turn; a racing turn, another request's key or a key near expiry mints inline; a displaced
 * key is revoked; and a parked key Platform revoked fails at the Router, then the turn mints inline and resends.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createFieldCrypto } from '../src/crypto'
import { createPlatformDelegatedKeyClient } from '../src/platform/delegated-keys'
import {
  createDelegatedTurnKeys,
  DELEGATED_KEY_PREMINT_TABLE_DDL,
  delegatedKeyFallbackFetch,
  type DelegatedKeyPremintD1Like,
  type DelegatedTurnKeyScope,
} from '../src/platform/delegated-turn-keys'

const SOURCE = 'sk-tan-payer-linked-key-0001'

/** Platform (`/v1/keys/delegate`, `DELETE /v1/keys/:id`) and Router (`/v1/chat/completions`) in one local server. */
async function platformAndRouter(options: { ssoSource?: boolean } = {}) {
  const minted: Array<{ id: string; key: string; name: string }> = []
  const revoked = new Set<string>()
  const spent = new Set<string>()
  const forbidden = new Set<string>()
  const routerAuth: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.method === 'POST' && req.url === '/v1/keys/delegate') {
        const body = JSON.parse(raw) as Record<string, any>
        const n = minted.length + 1
        const child = { id: `key_child_${n}`, key: `sk-tan-child-${n}-xxxxxxxxxxxx`, name: body.name }
        minted.push(child)
        return json(201, { success: true, data: {
          ...child, prefix: `sk-tan-child-${n}`, provisionedByService: 'creative-agent', product: body.product, scopes: null,
          budgetUsd: body.budgetUsd ?? null, allowedModels: body.allowedModels ?? null,
          attribution: { version: 1, targetService: body.product, delegatedFromKeyId: 'key_source', payerType: 'user',
            payerId: 'usr_payer', resourceType: null, resourceId: null, expiresAt: body.expiresAt },
        } })
      }
      // Platform refuses key mutations from an app-provisioned (SSO) source; the slot is retired with the service token.
      if (req.method === 'DELETE' && req.url?.startsWith('/v1/keys/')) {
        if (options.ssoSource) return json(403, { success: false, error: { code: 'FORBIDDEN' } })
        revoked.add(decodeURIComponent(req.url.slice('/v1/keys/'.length)))
        return json(200, { success: true })
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/keys/')) {
        const child = minted.find(k => k.id === decodeURIComponent(req.url!.slice('/v1/keys/'.length)))
        return child ? json(200, { success: true, data: { id: child.id, name: child.name, product: 'router' } }) : json(404, {})
      }
      if (req.method === 'POST' && req.url === '/v1/keys/auto-provisioned/revoke-slot') {
        const body = JSON.parse(raw) as { userId?: string; childKeyId?: string }
        if (body.userId !== 'usr_payer' || !body.childKeyId) return json(400, { success: false })
        revoked.add(body.childKeyId)
        return json(200, { success: true })
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const auth = req.headers.authorization ?? ''
        routerAuth.push(auth)
        const child = minted.find(k => `Bearer ${k.key}` === auth)
        // Router's own refusals (tangle-router lib/key-refusal.ts, customer-spend-authorization.ts).
        if (!child) return json(401, { error: { type: 'authentication_error', code: 'invalid_key' } })
        if (revoked.has(child.id)) return json(401, { error: { type: 'authentication_error', code: 'invalid_key', reason: 'key_revoked' } })
        if (spent.has(child.id)) return json(402, { error: { type: 'insufficient_funds', code: 'key_budget_exhausted' } })
        if (forbidden.has(child.id)) return json(403, { error: { type: 'authentication_error', code: 'product_scope_mismatch' } })
        return json(200, { ok: true, body: raw })
      }
      json(404, {})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, minted, revoked, spent, forbidden, routerAuth, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** node:sqlite behind the D1 shape. */
function d1(db: DatabaseSync): DelegatedKeyPremintD1Like {
  return { prepare: (sql) => ({ bind: (...values) => ({
    async first<T>() { return (db.prepare(sql).get(...(values as never[])) as T | undefined) ?? null },
    async run() { return db.prepare(sql).run(...(values as never[])) },
  }) }) }
}

const scope = (models = ['gemini-3.7-flash']): DelegatedTurnKeyScope =>
  ({ sourceKey: SOURCE, product: 'router', allowedModels: models, budget: { usd: 5 } })

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined })

async function setup(clock = { at: Date.now() }, crypto = createFieldCrypto('ab'.repeat(32)), ssoSource = false) {
  const p = await platformAndRouter({ ssoSource })
  close = p.close
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(DELEGATED_KEY_PREMINT_TABLE_DDL)
  const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
  const pending: Promise<unknown>[] = []
  const keys = createDelegatedTurnKeys({ client, db: d1(sqlite), crypto, now: () => clock.at })
  const turn = (turnId: string, models?: string[]) =>
    keys.forTurn({ slot: 'usr_payer:w1:router', scope: scope(models), ttlMs: 30 * 60_000, turnId, waitUntil: (x) => pending.push(x) })
  const settle = async () => { await Promise.all(pending.splice(0)) }
  const stored = () => sqlite.prepare('SELECT key_id, key_encrypted FROM delegated_key_premint').all() as Array<{ key_id: string; key_encrypted: string }>
  return { p, keys, turn, settle, stored, sqlite }
}

describe('pre-minted turn keys', () => {
  it('serves a parked key to exactly one turn and parks the next one off the turn path', async () => {
    const { p, keys, turn, settle, stored } = await setup()
    expect(await keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 })).toBe(true)
    expect(stored()).toHaveLength(1)
    expect(stored()[0]!.key_encrypted).not.toContain('sk-tan-')
    const firstParked = stored()[0]!.key_id

    const [first, second] = await Promise.all([turn('exec-1'), turn('exec-2')])
    const outcomes = [first, second].map(o => o.succeeded ? o.value : null)
    expect(outcomes.filter(o => o?.preminted)).toHaveLength(1)
    const inline = outcomes.find(o => !o?.preminted)!
    expect(inline.turnId).toBe(outcomes[0]!.preminted ? 'exec-2' : 'exec-1')
    expect(p.minted.find(k => k.id === inline.id)?.name).toBe(`auto:creative-agent:router:turn:${inline.turnId}`)

    await settle()
    // Both turns parked; one key holds the slot and any other unused one was revoked.
    expect(stored()).toHaveLength(1)
    const unused = p.minted.map(k => k.id).filter(id => id !== firstParked && id !== inline.id && id !== stored()[0]!.key_id)
    expect([...p.revoked]).toEqual(expect.arrayContaining(unused))
    expect(p.revoked.has(stored()[0]!.key_id)).toBe(false)
  })

  it('mints inline for another request or a key near expiry, and revokes the key it displaces', async () => {
    const clock = { at: Date.now() }
    const { p, keys, turn, settle, stored } = await setup(clock)
    await keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 })
    const parkedId = stored()[0]!.key_id

    const otherModels = await turn('exec-1', ['gpt-6.1-sol'])
    expect(otherModels).toMatchObject({ succeeded: true, value: { preminted: false, turnId: 'exec-1' } })
    await settle()
    expect(p.revoked.has(parkedId)).toBe(true)

    clock.at += 21 * 60_000
    expect(await turn('exec-2', ['gpt-6.1-sol'])).toMatchObject({ succeeded: true, value: { preminted: false } })
  })

  /** A turn holding the slot's parked key, and its fallback fetch. */
  async function parkedTurn() {
    const env = await setup()
    await env.keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 })
    const outcome = await env.turn('exec-1')
    await env.settle()
    if (!outcome.succeeded || !outcome.value.preminted) throw new Error('no parked key')
    const parked = outcome.value
    let replaced = 0
    const turnFetch = delegatedKeyFallbackFetch({ key: parked,
      remint: () => env.keys.mint({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000, turnId: 'exec-1' }),
      onReplaced: () => { replaced++ } })
    const send = (f: typeof fetch, body: BodyInit = '{"model":"gemini-3.7-flash"}') => f(`${env.p.url}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${parked.key}` }, body, duplex: 'half' } as RequestInit)
    return { ...env, parked, turnFetch, send, replaced: () => replaced }
  }

  it('re-mints once when the first request with a parked key is refused as revoked, and resends it whole', async () => {
    const { p, parked, turnFetch, send, replaced } = await parkedTurn()
    p.revoked.add(parked.id)
    const before = p.minted.length
    const response = await send(turnFetch, new Response('{"model":"gemini-3.7-flash","stream":true}').body!)
    expect(response.status).toBe(200)
    // The streamed body was buffered and resent whole with the fresh key.
    expect(((await response.json()) as { body: string }).body).toBe('{"model":"gemini-3.7-flash","stream":true}')
    expect(p.minted.length - before).toBe(1)
    expect((await send(turnFetch)).status).toBe(200)
    expect(replaced()).toBe(1)
    // The revoked key went out once, on the first request; never after the inline mint.
    expect(p.routerAuth.filter(auth => auth === `Bearer ${parked.key}`)).toHaveLength(1)
  })

  it('never re-mints for a refusal later in the turn', async () => {
    const { p, parked, turnFetch, send, replaced } = await parkedTurn()
    expect((await send(turnFetch)).status).toBe(200)
    p.revoked.add(parked.id)
    const before = p.minted.length
    expect((await send(turnFetch)).status).toBe(401)
    expect(p.minted.length).toBe(before)
    expect(replaced()).toBe(0)
  })

  it('answers a spent budget, a 403 or a bare invalid key with the Router refusal and no second mint', async () => {
    for (const refuse of ['spent', 'forbidden', 'bare'] as const) {
      const { p, parked, turnFetch, send, replaced } = await parkedTurn()
      if (refuse === 'spent') p.spent.add(parked.id)
      if (refuse === 'forbidden') p.forbidden.add(parked.id)
      if (refuse === 'bare') p.minted.splice(p.minted.findIndex(k => k.id === parked.id), 1)
      const before = p.minted.length
      const response = await send(turnFetch)
      expect(response.status).toBe(refuse === 'spent' ? 402 : refuse === 'forbidden' ? 403 : 401)
      if (refuse === 'spent') expect(await response.json()).toMatchObject({ error: { code: 'key_budget_exhausted' } })
      expect(p.minted.length).toBe(before)
      expect(replaced()).toBe(0)
      await close?.()
      close = undefined
    }
  })

  it('mints nothing when the at-rest crypto is unusable', async () => {
    const crypto = { ...createFieldCrypto('ab'.repeat(32)), encrypt: async () => { throw new Error('crypto down') } }
    const { p, keys } = await setup({ at: Date.now() }, crypto)
    expect(await keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 })).toBe(false)
    expect(p.minted).toHaveLength(0)
  })

  it('revokes a key it minted but could not store, through the slot when the source is an SSO key', async () => {
    const { p, keys, stored, sqlite } = await setup({ at: Date.now() }, createFieldCrypto('ab'.repeat(32)), true)
    sqlite.exec(`CREATE TRIGGER premint_insert_fails BEFORE INSERT ON delegated_key_premint BEGIN SELECT RAISE(ABORT, 'forced'); END`)
    expect(await keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000, payerId: 'usr_payer' })).toBe(false)
    expect(p.minted).toHaveLength(1)
    expect(p.revoked.has(p.minted[0]!.id)).toBe(true)
    expect(stored()).toHaveLength(0)
  })

  it('mints every turn inline when pre-minting is off', async () => {
    const p = await platformAndRouter()
    close = p.close
    const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
    const keys = createDelegatedTurnKeys({ client, db: null, crypto: createFieldCrypto('ab'.repeat(32)) })
    expect(await keys.forTurn({ slot: 's', scope: scope(), ttlMs: 60_000, turnId: 'exec-1' }))
      .toMatchObject({ succeeded: true, value: { preminted: false, turnId: 'exec-1' } })
    expect(await keys.park({ slot: 's', scope: scope(), ttlMs: 60_000 })).toBe(false)
    expect(p.minted).toHaveLength(1)
  })
})
