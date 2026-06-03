import { describe, it, expect } from 'vitest'
import { parseJsonObjectBody, requireString, extractRequestContext, checkRateLimit, addSecurityHeaders, type KvLike } from '../src/web/index'
import { redactForIngestion } from '../src/redact/index'

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://x/api', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

describe('parseJsonObjectBody / requireString', () => {
  it('narrows an object body, rejects arrays / non-objects / bad JSON', async () => {
    const [body, err] = await parseJsonObjectBody(req({ a: 1 }))
    expect(err).toBeNull(); expect(body).toEqual({ a: 1 })
    const [, e2] = await parseJsonObjectBody(req([1, 2])); expect(e2?.status).toBe(400)
    const bad = new Request('https://x', { method: 'POST', body: 'not json' })
    const [, e3] = await parseJsonObjectBody(bad); expect(e3?.status).toBe(400)
  })
  it('requireString returns the value or a 400', () => {
    expect(requireString({ name: 'x' }, 'name')).toBe('x')
    expect((requireString({}, 'name') as Response).status).toBe(400)
  })
})

describe('extractRequestContext', () => {
  it('prefers CF-Connecting-IP, falls back to X-Forwarded-For then 0.0.0.0', () => {
    expect(extractRequestContext(req({}, { 'CF-Connecting-IP': '1.2.3.4' })).ipAddress).toBe('1.2.3.4')
    expect(extractRequestContext(req({}, { 'X-Forwarded-For': '5.6.7.8, 9.9.9.9' })).ipAddress).toBe('5.6.7.8')
    expect(extractRequestContext(req({})).ipAddress).toBe('0.0.0.0')
  })
})

describe('checkRateLimit', () => {
  function memKv(): KvLike {
    const m = new Map<string, string>()
    return { async get(k) { return m.get(k) ?? null }, async put(k, v) { m.set(k, v) } }
  }
  it('allows up to the limit then blocks within the window', async () => {
    const kv = memKv()
    let last
    for (let i = 0; i < 3; i++) last = await checkRateLimit(kv, 'u1', 3, 60)
    expect(last!.allowed).toBe(true)
    const blocked = await checkRateLimit(kv, 'u1', 3, 60)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })
  it('keys are independent', async () => {
    const kv = memKv()
    await checkRateLimit(kv, 'a', 1, 60)
    expect((await checkRateLimit(kv, 'b', 1, 60)).allowed).toBe(true)
  })
})

describe('addSecurityHeaders', () => {
  it('sets the generic security set + optional disclaimer/retention/extra', () => {
    const r = addSecurityHeaders(new Response('x'), { disclaimer: 'Not legal advice.', retention: '7-years', extra: { 'X-Custom': '1' } })
    expect(r.headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-AI-Disclaimer')).toBe('Not legal advice.')
    expect(r.headers.get('X-Data-Retention')).toBe('7-years')
    expect(r.headers.get('X-Custom')).toBe('1')
  })
  it('omits disclaimer/retention when not provided', () => {
    const r = addSecurityHeaders(new Response('x'))
    expect(r.headers.get('X-AI-Disclaimer')).toBeNull()
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

describe('redactForIngestion', () => {
  it('redacts SSN/EIN strings + sensitive keys, recurses, never throws, round-trips the rest', () => {
    const out = redactForIngestion({
      ssn: '123-45-6789', note: 'my ssn is 123-45-6789', ein: '12-3456789',
      password: 'hunter2', nested: [{ token: 'abc', ok: 42 }], keep: 'plain', n: 7, b: true, z: null,
    }) as Record<string, unknown>
    expect(out.ssn).toBe('[REDACTED:field]')
    expect(out.note).toBe('[REDACTED:ssn]')
    expect(out.password).toBe('[REDACTED:field]')
    expect((out.nested as Array<Record<string, unknown>>)[0]!.token).toBe('[REDACTED:field]')
    expect((out.nested as Array<Record<string, unknown>>)[0]!.ok).toBe(42)
    expect(out.keep).toBe('plain'); expect(out.n).toBe(7); expect(out.b).toBe(true); expect(out.z).toBeNull()
  })
})
