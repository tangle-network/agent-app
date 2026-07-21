import { describe, expect, it } from 'vitest'
import {
  assertSafeKeySegment,
  createProxiedArtifactRoute,
  createR2ObjectStore,
  objectKey,
  signObjectUrl,
  verifyObjectUrl,
  type R2LikeBucket,
  type R2LikeObjectBody,
  type R2LikeObjectHead,
} from './index'

// ── A faithful in-memory R2 binding ─────────────────────────────────────────
//
// Miniflare/workers-pool is not a devDependency of this package (checked
// package.json), so this is a byte-faithful in-memory stand-in for an R2 bucket.
// It STORES raw bytes and hands them back through a real `ReadableStream` on
// `.body` — deliberately exposing ONLY `.body`/`.size`/`.httpMetadata`, with no
// `.text()`/`.arrayBuffer()`, so any attempt by the store impl to buffer the
// whole object would throw. That is the point: the round-trip is proven through
// `.stream()`, exercising the streaming path, not a buffering shortcut.

function streamOfBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Chunk the emission so the reader genuinely streams multiple pulls rather
  // than receiving the whole payload in one enqueue.
  const chunkSize = Math.max(1, Math.ceil(bytes.length / 3))
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize))
      offset += chunkSize
    },
  })
}

async function collect(value: ReadableStream | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  const reader = value.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer)
    chunks.push(bytes)
    total += bytes.length
  }
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  return collect(stream)
}

class FakeR2Bucket implements R2LikeBucket {
  private readonly store = new Map<string, { bytes: Uint8Array; contentType?: string }>()

  async put(
    key: string,
    value: ReadableStream | Uint8Array | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown> {
    const bytes = await collect(value)
    this.store.set(key, { bytes, contentType: options?.httpMetadata?.contentType })
    return { key }
  }

  async get(key: string): Promise<R2LikeObjectBody | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    return {
      size: entry.bytes.length,
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
      body: streamOfBytes(entry.bytes),
    }
  }

  async head(key: string): Promise<R2LikeObjectHead | null> {
    const entry = this.store.get(key)
    if (!entry) return null
    return {
      size: entry.bytes.length,
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
    }
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

const SECRET = 'test-signing-secret-0123456789'

// ── The store port over the R2 impl ─────────────────────────────────────────

describe('createR2ObjectStore', () => {
  it('round-trips a byte-identical payload through put/get and streams it', async () => {
    const store = createR2ObjectStore({ bucket: new FakeR2Bucket() })
    // Non-UTF8 binary bytes: proves we never coerce through text.
    const payload = new Uint8Array(4096)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 256
    await store.put('op/cust/u1-report.pdf', payload, { contentType: 'application/pdf' })

    const got = await store.get('op/cust/u1-report.pdf')
    expect(got).not.toBeNull()
    expect(got!.size).toBe(payload.length)
    expect(got!.contentType).toBe('application/pdf')
    const roundTripped = await readAll(got!.stream())
    expect(roundTripped).toEqual(payload)
  })

  it('accepts a ReadableStream body (the large-file path)', async () => {
    const store = createR2ObjectStore({ bucket: new FakeR2Bucket() })
    const payload = new TextEncoder().encode('streamed body content '.repeat(500))
    await store.put('op/cust/u2-big.bin', streamOfBytes(payload), { contentLength: payload.length })
    const got = await store.get('op/cust/u2-big.bin')
    expect(await readAll(got!.stream())).toEqual(payload)
  })

  it('head returns size + contentType without a body', async () => {
    const store = createR2ObjectStore({ bucket: new FakeR2Bucket() })
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    await store.put('op/cust/u3-a.txt', payload, { contentType: 'text/plain' })
    const head = await store.head('op/cust/u3-a.txt')
    expect(head).toEqual({ size: 5, contentType: 'text/plain' })
  })

  it('get on a missing key returns null and does NOT throw', async () => {
    const store = createR2ObjectStore({ bucket: new FakeR2Bucket() })
    await expect(store.get('op/cust/nope')).resolves.toBeNull()
    await expect(store.head('op/cust/nope')).resolves.toBeNull()
  })

  it('delete then get returns null', async () => {
    const store = createR2ObjectStore({ bucket: new FakeR2Bucket() })
    await store.put('op/cust/u4-x', new Uint8Array([9, 9, 9]))
    expect(await store.get('op/cust/u4-x')).not.toBeNull()
    await store.delete('op/cust/u4-x')
    expect(await store.get('op/cust/u4-x')).toBeNull()
  })
})

// ── Key construction + safety ───────────────────────────────────────────────

describe('objectKey / assertSafeKeySegment', () => {
  it('builds operator/customer/upload-filename', () => {
    expect(objectKey({ operatorId: 'op1', customerId: 'cust1', uploadId: 'u42', filename: 'Report Q3.pdf' })).toBe(
      'op1/cust1/u42-Report_Q3.pdf',
    )
  })

  it('falls back to _unattributed when no customer is given', () => {
    expect(objectKey({ operatorId: 'op1', uploadId: 'u9', filename: 'a.txt' })).toBe('op1/_unattributed/u9-a.txt')
  })

  it('sanitizes path separators and unsafe filename chars', () => {
    // Path components in the filename are dropped to the leaf; unsafe chars → _.
    expect(objectKey({ operatorId: 'op', customerId: 'c', uploadId: 'u', filename: '../../etc/passwd' })).toBe(
      'op/c/u-passwd',
    )
    expect(objectKey({ operatorId: 'op', customerId: 'c', uploadId: 'u', filename: 'a\\b\\c.png' })).toBe('op/c/u-c.png')
    expect(objectKey({ operatorId: 'op', customerId: 'c', uploadId: 'u', filename: '..' })).toBe('op/c/u-file')
  })

  it('rejects traversal / injection in segments', () => {
    expect(() => assertSafeKeySegment('..')).toThrow()
    expect(() => assertSafeKeySegment('a/../b')).toThrow() // contains ".."
    expect(() => assertSafeKeySegment('/leading')).toThrow()
    expect(() => assertSafeKeySegment('back\\slash')).toThrow()
    expect(() => assertSafeKeySegment('')).toThrow()
    // objectKey routes each id through the guard.
    expect(() => objectKey({ operatorId: '..', uploadId: 'u', filename: 'a' })).toThrow()
    expect(() => objectKey({ operatorId: 'op', customerId: '../other', uploadId: 'u', filename: 'a' })).toThrow()
  })

  it('rejects an interior / trailing "/" — a segment is a single path component', () => {
    // No "..", no leading "/": the pre-hardening gaps. A bare interior slash
    // would silently add a key level and widen the operator/customer prefix.
    expect(() => assertSafeKeySegment('a/b')).toThrow()
    expect(() => assertSafeKeySegment('op/../../attacker')).toThrow()
    expect(() => assertSafeKeySegment('trailing/')).toThrow()
    // And through the construction path: a customer id with an interior slash is
    // refused rather than widening the key from op/customer/upload to op/a/b/upload.
    expect(() => objectKey({ operatorId: 'op', customerId: 'cust/extra', uploadId: 'u', filename: 'a' })).toThrow()
    expect(() => objectKey({ operatorId: 'op', uploadId: 'u1/u2', filename: 'a' })).toThrow()
  })

  it('returns the segment on success (usable inline)', () => {
    expect(assertSafeKeySegment('op-123')).toBe('op-123')
  })
})

// ── Signed URLs ─────────────────────────────────────────────────────────────

const REQ_BASE = 'https://app.example/artifacts'

function requestFor(signed: string): Request {
  return new Request(`${REQ_BASE}${signed}`)
}

describe('signObjectUrl / verifyObjectUrl', () => {
  const key = 'op1/cust1/u42-report.pdf'

  it('accepts a freshly signed URL and returns the canonical key', async () => {
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: SECRET })
    const result = await verifyObjectUrl(requestFor(signed), { secret: SECRET })
    expect(result).toEqual({ ok: true, key })
  })

  it('rejects a tampered key (signature covers operator + customer + upload)', async () => {
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: SECRET })
    const url = new URL(`${REQ_BASE}${signed}`)
    // Swap the customer segment — the privilege-wall attack.
    url.searchParams.set('key', 'op1/cust2/u42-report.pdf')
    const result = await verifyObjectUrl(new Request(url.toString()), { secret: SECRET })
    expect(result).toEqual({ ok: false })
  })

  it('rejects a tampered expiry (exp is signed)', async () => {
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: SECRET })
    const url = new URL(`${REQ_BASE}${signed}`)
    url.searchParams.set('exp', String(Date.now() + 999_999_999))
    const result = await verifyObjectUrl(new Request(url.toString()), { secret: SECRET })
    expect(result).toEqual({ ok: false })
  })

  it('rejects an expired URL even with a valid signature', async () => {
    const signed = await signObjectUrl({ key, exp: Date.now() - 1_000, secret: SECRET })
    const result = await verifyObjectUrl(requestFor(signed), { secret: SECRET })
    expect(result).toEqual({ ok: false })
  })

  it('rejects a URL signed with a different secret', async () => {
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: 'other-secret' })
    const result = await verifyObjectUrl(requestFor(signed), { secret: SECRET })
    expect(result).toEqual({ ok: false })
  })

  it('fails closed when the verify secret is empty', async () => {
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: SECRET })
    const result = await verifyObjectUrl(requestFor(signed), { secret: '' })
    expect(result).toEqual({ ok: false })
  })

  it('refuses to sign without a secret (never mints an unsigned URL)', async () => {
    await expect(signObjectUrl({ key, exp: Date.now() + 60_000, secret: '' })).rejects.toThrow()
  })

  it('canonicalizes a slash- or percent-encoded key identically on both sides', async () => {
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: SECRET })
    const exp = new URL(`${REQ_BASE}${signed}`).searchParams.get('exp')!
    const sig = new URL(`${REQ_BASE}${signed}`).searchParams.get('sig')!

    // (a) literal slashes in the query
    const literal = `${REQ_BASE}?key=${key}&exp=${exp}&sig=${encodeURIComponent(sig)}`
    expect(await verifyObjectUrl(new Request(literal), { secret: SECRET })).toEqual({ ok: true, key })

    // (b) fully percent-encoded slashes — must verify to the SAME key
    const encoded = `${REQ_BASE}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${encodeURIComponent(sig)}`
    expect(await verifyObjectUrl(new Request(encoded), { secret: SECRET })).toEqual({ ok: true, key })
  })

  it('rejects a request missing key/exp/sig', async () => {
    expect(await verifyObjectUrl(new Request(`${REQ_BASE}?exp=${Date.now() + 1000}`), { secret: SECRET })).toEqual({
      ok: false,
    })
    expect(await verifyObjectUrl(new Request(REQ_BASE), { secret: SECRET })).toEqual({ ok: false })
  })
})

// ── Proxied download route ──────────────────────────────────────────────────

describe('createProxiedArtifactRoute', () => {
  async function seededRoute() {
    const bucket = new FakeR2Bucket()
    const store = createR2ObjectStore({ bucket })
    const key = objectKey({ operatorId: 'op1', customerId: 'cust1', uploadId: 'u42', filename: 'brief.pdf' })
    const payload = new Uint8Array(2048)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 3) % 256
    await store.put(key, payload, { contentType: 'application/pdf' })
    const route = createProxiedArtifactRoute({ store, secret: SECRET })
    return { route, key, payload }
  }

  it('200 streams bytes for a valid signature with conservative headers', async () => {
    const { route, key, payload } = await seededRoute()
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: SECRET })
    const res = await route(requestFor(signed))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Disposition')).toBe('attachment')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Length')).toBe(String(payload.length))
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(payload)
  })

  it('403 on a tampered signature', async () => {
    const { route, key } = await seededRoute()
    const signed = await signObjectUrl({ key, exp: Date.now() + 60_000, secret: SECRET })
    const url = new URL(`${REQ_BASE}${signed}`)
    url.searchParams.set('sig', 'not-the-real-signature')
    const res = await route(new Request(url.toString()))
    expect(res.status).toBe(403)
  })

  it('403 on an expired signature', async () => {
    const { route, key } = await seededRoute()
    const signed = await signObjectUrl({ key, exp: Date.now() - 1_000, secret: SECRET })
    const res = await route(requestFor(signed))
    expect(res.status).toBe(403)
  })

  it('404 when the signature is valid but the object is missing', async () => {
    const { route } = await seededRoute()
    const missingKey = objectKey({ operatorId: 'op1', customerId: 'cust1', uploadId: 'u99', filename: 'gone.pdf' })
    const signed = await signObjectUrl({ key: missingKey, exp: Date.now() + 60_000, secret: SECRET })
    const res = await route(requestFor(signed))
    expect(res.status).toBe(404)
  })

  it('400 on a missing or malformed key (before auth — leaks no existence)', async () => {
    const { route } = await seededRoute()
    // no key at all
    expect((await route(new Request(`${REQ_BASE}?exp=1&sig=x`))).status).toBe(400)
    // traversal in the key
    const traversal = `${REQ_BASE}?key=${encodeURIComponent('op1/../secret/x')}&exp=${Date.now() + 1000}&sig=x`
    expect((await route(new Request(traversal))).status).toBe(400)
  })
})
