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
import {
  createDelegatedTurnKeys,
  createPlatformDelegatedKeyClient,
  DELEGATED_KEY_PREMINT_TABLE_DDL,
  delegatedKeyFallbackFetch,
  type DelegatedKeyPremintD1Like,
  type DelegatedTurnKeyScope,
} from '../src/platform/delegated-keys'

const SOURCE = 'sk-tan-payer-linked-key-0001'

/** Platform (`/v1/keys/delegate`, `DELETE /v1/keys/:id`) and Router (`/v1/chat/completions`) in one local server. */
async function platformAndRouter() {
  const minted: Array<{ id: string; key: string; name: string }> = []
  const revoked = new Set<string>()
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
      if (req.method === 'DELETE' && req.url?.startsWith('/v1/keys/')) {
        revoked.add(decodeURIComponent(req.url.slice('/v1/keys/'.length)))
        return json(200, { success: true })
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const auth = req.headers.authorization ?? ''
        routerAuth.push(auth)
        const child = minted.find(k => `Bearer ${k.key}` === auth)
        if (!child || revoked.has(child.id)) return json(401, { error: { code: 'invalid_api_key' } })
        return json(200, { ok: true, body: raw })
      }
      json(404, {})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, minted, revoked, routerAuth, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
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

async function setup(clock = { at: Date.now() }) {
  const p = await platformAndRouter()
  close = p.close
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(DELEGATED_KEY_PREMINT_TABLE_DDL)
  const client = createPlatformDelegatedKeyClient({ platformUrl: p.url, serviceName: 'creative-agent', serviceToken: 'svc' })
  const pending: Promise<unknown>[] = []
  const keys = createDelegatedTurnKeys({ client, db: d1(sqlite), crypto: createFieldCrypto('ab'.repeat(32)), now: () => clock.at })
  const turn = (turnId: string, models?: string[]) =>
    keys.forTurn({ slot: 'usr_payer:w1:router', scope: scope(models), ttlMs: 30 * 60_000, turnId, waitUntil: (x) => pending.push(x) })
  const settle = async () => { await Promise.all(pending.splice(0)) }
  const stored = () => sqlite.prepare('SELECT key_id, key_encrypted FROM delegated_key_premint').all() as Array<{ key_id: string; key_encrypted: string }>
  return { p, keys, turn, settle, stored }
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

  it('fails a parked key Platform revoked, then mints inline once and resends', async () => {
    const { p, keys, turn, settle } = await setup()
    await keys.park({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000 })
    const outcome = await turn('exec-1')
    await settle()
    if (!outcome.succeeded) throw new Error('no key')
    const parked = outcome.value
    expect(parked.preminted).toBe(true)
    p.revoked.add(parked.id)

    const send = (f: typeof fetch) => f(`${p.url}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${parked.key}` }, body: '{"model":"gemini-3.7-flash"}' })
    expect((await send(fetch)).status).toBe(401)

    let replacedTurnId: string | undefined
    const turnFetch = delegatedKeyFallbackFetch({ key: parked,
      remint: () => keys.mint({ slot: 'usr_payer:w1:router', scope: scope(), ttlMs: 30 * 60_000, turnId: 'exec-1' }),
      onReplaced: (k) => { replacedTurnId = k.turnId } })
    const response = await send(turnFetch)
    expect(response.status).toBe(200)
    expect(replacedTurnId).toBe('exec-1')
    expect((await send(turnFetch)).status).toBe(200)
    // The revoked key was sent once more (the turn's first request), never after the inline mint.
    expect(p.routerAuth.filter(a => a === `Bearer ${parked.key}`)).toHaveLength(2)
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
