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
import { createRouterTurnProducer } from '../src/chat-routes/router-producer'
import { createPlatformDelegatedKeyClient } from '../src/platform/delegated-keys'
import {
  createDelegatedTurnKeys,
  DELEGATED_KEY_PREMINT_TABLE_DDL,
  type DelegatedKeyPremintD1Like,
  type DelegatedTurnKeyScope,
} from '../src/platform/delegated-turn-keys'

const SOURCE = 'sk-tan-payer-linked-key-0001'

/** Platform (`/v1/keys/delegate`, `DELETE /v1/keys/:id`) and Router (`/v1/chat/completions`) in one local server. */
async function platformAndRouter(options: { ssoSource?: boolean; routerStream?: boolean; delegationRefused?: boolean } = {}) {
  const minted: Array<{ id: string; key: string; name: string; expiresAt: string; request: Record<string, any> }> = []
  const revoked = new Set<string>()
  const expired = new Set<string>()
  const spent = new Set<string>()
  const forbidden = new Set<string>()
  const routerAuth: string[] = []
  const revocationCalls: string[] = []
  let releaseMint: (() => void) | undefined
  let pausedMint: Promise<void> | undefined
  let didPause: (() => void) | undefined
  const pauseNextMint = () => {
    pausedMint = new Promise<void>(resolve => { releaseMint = resolve })
    const started = new Promise<void>(resolve => { didPause = resolve })
    return { started, release: () => { releaseMint?.(); pausedMint = undefined } }
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', async () => {
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.method === 'POST' && req.url === '/v1/keys/delegate') {
        const body = JSON.parse(raw) as Record<string, any>
        if (options.delegationRefused) return json(403, { success: false, error: { code: 'FORBIDDEN' } })
        if (pausedMint) { didPause?.(); await pausedMint }
        const n = minted.length + 1
        // Platform supersedes an existing child under the same canonical name.
        for (const old of minted) if (old.name === body.name) revoked.add(old.id)
        const child = { id: `key_child_${n}`, key: `sk-tan-child-${n}-xxxxxxxxxxxx`, name: body.name,
          expiresAt: body.expiresAt, request: body }
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
        const id = decodeURIComponent(req.url.slice('/v1/keys/'.length))
        revocationCalls.push(id)
        revoked.add(id)
        return json(200, { success: true })
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/keys/')) {
        const child = minted.find(k => k.id === decodeURIComponent(req.url!.slice('/v1/keys/'.length)))
        return child ? json(200, { success: true, data: { id: child.id, name: child.name, product: 'router' } }) : json(404, {})
      }
      if (req.method === 'POST' && req.url === '/v1/keys/auto-provisioned/revoke-slot') {
        const body = JSON.parse(raw) as { userId?: string; childKeyId?: string }
        if (body.userId !== 'usr_payer' || !body.childKeyId) return json(400, { success: false })
        revocationCalls.push(body.childKeyId)
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
        if (expired.has(child.id)) return json(401, { error: { type: 'authentication_error', code: 'invalid_key', reason: 'key_expired' } })
        if (spent.has(child.id)) return json(402, { error: { type: 'insufficient_funds', code: 'key_budget_exhausted' } })
        if (forbidden.has(child.id)) return json(403, { error: { type: 'authentication_error', code: 'product_scope_mismatch' } })
        if (options.routerStream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          return res.end(`data: ${JSON.stringify({ id: 'completion', model: 'gemini-3.7-flash', choices: [{ index: 0,
            delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        }
        return json(200, { ok: true, body: raw })
      }
      json(404, {})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, minted, revoked, expired, spent, forbidden, routerAuth, revocationCalls, pauseNextMint,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
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

async function setup(clock = { at: Date.now() }, crypto = createFieldCrypto('ab'.repeat(32)), ssoSource = false, routerStream = false) {
  const p = await platformAndRouter({ ssoSource, routerStream })
  close = p.close
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(DELEGATED_KEY_PREMINT_TABLE_DDL)
  const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
  const pending: Promise<unknown>[] = []
  // The turn-key owner needs only these real Platform HTTP capabilities.
  const keys = createDelegatedTurnKeys({ client: { delegate: client.delegate, revoke: client.revoke },
    db: d1(sqlite), crypto, now: () => clock.at })
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
    expect(p.minted.find(k => k.id === inline.id)?.name).toMatch(new RegExp(`^auto:creative-agent:router:turn:${inline.turnId}:`))

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

  /** A turn holding the slot's parked key with its shared fetch and cleanup owner. */
  async function parkedTurn() {
    const env = await setup()
    await env.keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 })
    const outcome = await env.turn('exec-1')
    await env.settle()
    if (!outcome.succeeded || !outcome.value.preminted) throw new Error('no parked key')
    const parked = outcome.value
    const send = (f: typeof fetch, body: BodyInit = '{"model":"gemini-3.7-flash"}') => f(`${env.p.url}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${parked.key}` }, body, duplex: 'half' } as RequestInit)
    const before = env.p.minted.length
    return { ...env, parked, turnFetch: parked.fetchImpl, send, replaced: () => env.p.minted.length - before }
  }

  it.each(['revoked', 'expired'] as const)('re-mints once for a first-request %s refusal, and resends it whole', async reason => {
    const { p, parked, turnFetch, send, replaced } = await parkedTurn()
    p[reason].add(parked.id)
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
    const held = p.minted.filter(child => child.id === parked.id || p.routerAuth.includes(`Bearer ${child.key}`))
    await Promise.all([parked.revoke(), parked.revoke()])
    expect(held.every(child => p.revoked.has(child.id))).toBe(true)
    expect(held.map(child => p.revocationCalls.filter(id => id === child.id).length)).toEqual(held.map(() => 1))
    await expect(send(turnFetch)).rejects.toThrow('lease is closed')
  })

  it('passes a claimed lease directly to the Router producer and retires its revoked-key replacement', async () => {
    const { p, keys, turn, settle, stored } = await setup(undefined, undefined, false, true)
    await keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 })
    const claimed = await turn('producer-turn')
    await settle()
    if (!claimed.succeeded || !claimed.value.preminted) throw new Error('no parked key')
    const parked = claimed.value
    p.revoked.add(parked.id)
    const before = p.minted.length
    const producer = createRouterTurnProducer({ apiKey: Promise.resolve(parked), systemPrompt: Promise.resolve('Answer.'),
      baseUrl: `${p.url}/v1`, api: 'chat', model: 'gemini-3.7-flash', userMessage: 'Hello.' })
    const events = []
    for await (const event of producer.stream) events.push(event)
    await producer.cleanup
    expect(producer.finalText()).toBe('Done.')
    expect(events.some(event => event.type === 'text')).toBe(true)
    expect(p.minted.length - before).toBe(1)
    expect(p.routerAuth.filter(auth => auth === `Bearer ${parked.key}`)).toHaveLength(1)
    const replacement = p.minted.at(-1)!
    for (const child of [parked, replacement]) expect(p.revocationCalls.filter(id => id === child.id)).toHaveLength(1)
    expect(p.revoked.has(stored()[0]!.key_id)).toBe(false)
  })

  it('forgets only the exact parked slot and scope and revokes the removed child once', async () => {
    const { p, keys, stored } = await setup()
    const input = { slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 }
    await keys.park(input)
    const parked = stored()[0]!.key_id
    await keys.forget({ ...input, scope: scope(['another-model']) })
    await keys.forget({ ...input, slot: 'another-slot' })
    expect(stored()[0]!.key_id).toBe(parked)
    expect(p.revoked.has(parked)).toBe(false)
    await Promise.all([keys.forget(input), keys.forget(input)])
    expect(stored()).toEqual([])
    expect(p.revocationCalls.filter(id => id === parked)).toHaveLength(1)
  })

  it('preserves an inline client exception while background premint settles a real HTTP refusal without exposing its text', async () => {
    const p = await platformAndRouter({ delegationRefused: true })
    close = p.close
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(DELEGATED_KEY_PREMINT_TABLE_DDL)
    const upstream = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
    class ProductRefusal extends Error { readonly status = 403 }
    const errors: ProductRefusal[] = []
    const events: unknown[] = []
    const pending: Promise<unknown>[] = []
    const keys = createDelegatedTurnKeys({ client: { ...upstream, async delegate(request) {
      const outcome = await upstream.delegate(request)
      if (outcome.succeeded) return outcome
      const error = new ProductRefusal('Private domain error: sk-tan-fixture-secret')
      errors.push(error)
      throw error
    } }, db: d1(sqlite), crypto: createFieldCrypto('ab'.repeat(32)), onEvent: event => { events.push(event) } })
    const input = { slot: 'refused-slot', scope: scope(), ttlMs: 30 * 60_000 }
    try {
      expect(await keys.park(input)).toBe(false)
      const rejected = await keys.forTurn({ ...input, turnId: 'refused-turn', waitUntil: work => { pending.push(work) } })
        .catch(error => error)
      expect(rejected).toBeInstanceOf(ProductRefusal)
      expect(errors).toContain(rejected)
      await Promise.all(pending)
      expect(errors).toHaveLength(3)
      expect(events).toContainEqual({ type: 'park_failed', slot: input.slot, code: 'delegated_key.failed' })
      expect(JSON.stringify(events)).not.toContain('sk-tan-fixture-secret')
      expect(sqlite.prepare('SELECT * FROM delegated_key_premint').all()).toEqual([])
    } finally { await Promise.all(pending); sqlite.close() }
  })

  it('retires a replacement that finishes minting after the turn closes', async () => {
    const { p, parked, turnFetch, send } = await parkedTurn()
    p.revoked.add(parked.id)
    const pause = p.pauseNextMint()
    const sent = send(turnFetch)
    await pause.started
    const retiring = parked.revoke()
    pause.release()
    expect((await sent).status).toBe(401)
    await retiring
    const replacement = p.minted.at(-1)!
    expect(replacement.id).not.toBe(parked.id)
    expect(p.revoked.has(replacement.id)).toBe(true)
    expect(p.routerAuth).toEqual([`Bearer ${parked.key}`])
  })

  it('gives concurrent inline attempts unique mint names while retaining their logical turn id', async () => {
    const { p, keys, settle } = await setup()
    const input = { slot: 'attempts', scope: scope(), ttlMs: 30 * 60_000, turnId: 'same-logical-turn' }
    const outcomes = await Promise.all([keys.forTurn(input), keys.forTurn(input)])
    const leases = outcomes.map(outcome => {
      if (!outcome.succeeded) throw new Error('inline mint failed')
      return outcome.value
    })
    expect(leases.map(key => key.turnId)).toEqual(['same-logical-turn', 'same-logical-turn'])
    const named = leases.map(key => p.minted.find(child => child.id === key.id)!.name)
    expect(new Set(named).size).toBe(2)
    for (const key of leases) {
      const response = await key.fetchImpl(`${p.url}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${key.key}` }, body: '{}' })
      expect(response.status).toBe(200)
    }
    await Promise.all(leases.map(key => key.revoke()))
    expect(leases.every(key => p.revoked.has(key.id))).toBe(true)
    await settle()
  })

  it('does not claim or retain a parked key beyond this request\'s notAfter cap', async () => {
    const clock = { at: Date.now() }
    const { p, keys, stored } = await setup(clock)
    const input = { slot: 'cap', scope: scope(), ttlMs: 30 * 60_000 }
    expect(await keys.park(input)).toBe(true)
    const old = stored()[0]!.key_id
    const notAfter = new Date(clock.at + 20 * 60_000)
    let parking: Promise<unknown> | undefined
    const outcome = await keys.forTurn({ ...input, notAfter, turnId: 'capped', waitUntil: work => { parking = work } })
    if (!outcome.succeeded) throw new Error('capped mint failed')
    expect(outcome.value.preminted).toBe(false)
    expect(outcome.value.expiresAt.getTime()).toBeLessThanOrEqual(notAfter.getTime())
    const replacement = p.minted.find(child => child.id === outcome.value.id)!
    expect(replacement.request).toMatchObject({ sourceKey: SOURCE, product: 'router', allowedModels: scope().allowedModels,
      budgetUsd: 5, expiresAt: notAfter.toISOString() })
    await outcome.value.revoke()
    // Wait for the background replacement park; its stored cap must match too.
    await parking
    expect(p.revoked.has(old)).toBe(true)
    expect(stored().every(row => Date.parse(p.minted.find(child => child.id === row.key_id)!.expiresAt) <= notAfter.getTime())).toBe(true)
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
