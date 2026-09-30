import { describe, expect, it, vi } from 'vitest'
import {
  createObjectUploadRoute,
  createR2ObjectStore,
  DEFAULT_MAX_OBJECT_UPLOAD_BYTES,
  MAX_WORKERS_OBJECT_UPLOAD_BYTES,
  type ObjectStore,
  type R2LikeBucket,
} from './index'

function memoryStore(): ObjectStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    async put(key, body) {
      const chunks: Uint8Array[] = []
      if (body instanceof Uint8Array) chunks.push(body)
      else for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk)
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      objects.set(key, bytes)
    },
    async get(key) {
      const bytes = objects.get(key)
      return bytes ? { size: bytes.byteLength, stream: () => new Blob([bytes as BlobPart]).stream() } : null
    },
    async head(key) {
      const bytes = objects.get(key)
      return bytes ? { size: bytes.byteLength } : null
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

function uploadRequest(body: BodyInit, headers: HeadersInit = {}, query = '?filename=clip.mp4'): Request {
  return new Request(`https://app.example/api/upload${query}`, {
    method: 'PUT',
    body,
    headers,
    duplex: 'half',
  } as RequestInit)
}

describe('createObjectUploadRoute', () => {
  it('keeps the default at 25 MiB until the larger deployed path is proved', () => {
    expect(DEFAULT_MAX_OBJECT_UPLOAD_BYTES).toBe(25 * 1024 * 1024)
  })

  it('rejects a configured ceiling above the baseline Workers ingress limit', () => {
    expect(MAX_WORKERS_OBJECT_UPLOAD_BYTES).toBe(100_000_000)
    expect(() => createObjectUploadRoute({
      store: memoryStore(),
      authorize: async () => ({ ok: true, operatorId: 'owner' }),
      maxBytes: 100 * 1024 * 1024,
    })).toThrow('Cloudflare Workers request limit')
  })

  it('streams raw bytes into a server-owned key and returns a readback key', async () => {
    const store = memoryStore()
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: true, operatorId: 'real-owner', customerId: 'real-customer' }),
    })
    const payload = new Uint8Array(512 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const request = uploadRequest(payload, {
      'Content-Type': 'video/mp4',
      'X-Upload-Length': String(payload.byteLength),
    }, '?filename=clip.mp4&operatorId=attacker')
    Object.defineProperty(request, 'formData', { value: () => { throw new Error('buffered formData') } })
    Object.defineProperty(request, 'arrayBuffer', { value: () => { throw new Error('buffered arrayBuffer') } })

    const response = await route(request)
    expect(response.status).toBe(201)
    const receipt = await response.json() as { key: string; size: number; contentType: string }
    expect(receipt.key).toMatch(/^real-owner\/real-customer\/[0-9a-f-]+-clip\.mp4$/)
    expect(receipt.size).toBe(payload.byteLength)
    expect(receipt.contentType).toBe('video/mp4')
    expect(store.objects.get(receipt.key)).toEqual(payload)
  })

  it('requires the request stream to finish before exposing a stored key', async () => {
    const store = memoryStore()
    store.put = async (key, body) => {
      const chunk = await (body as ReadableStream<Uint8Array>).getReader().read()
      if (chunk.value) store.objects.set(key, chunk.value)
    }
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: true, operatorId: 'owner' }),
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
    })
    const response = await route(uploadRequest(body, { 'X-Upload-Length': '3' }))
    expect(response.status).toBe(503)
    expect(store.objects.size).toBe(0)
  })

  it('denies before reading a body or writing any object', async () => {
    const store = memoryStore()
    const put = vi.spyOn(store, 'put')
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: false, response: new Response('Forbidden', { status: 403 }) }),
    })
    const request = uploadRequest(new Uint8Array([1, 2, 3]))
    expect((await route(request)).status).toBe(403)
    expect(request.bodyUsed).toBe(false)
    expect(put).not.toHaveBeenCalled()
  })

  it('rejects a declared oversize body before writing', async () => {
    const store = memoryStore()
    const put = vi.spyOn(store, 'put')
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: true, operatorId: 'owner' }),
      maxBytes: 3,
    })
    const request = uploadRequest(new Uint8Array([1, 2, 3, 4]), { 'X-Upload-Length': '4' })
    expect((await route(request)).status).toBe(413)
    expect(put).not.toHaveBeenCalled()
  })

  it('requires a browser-settable declared length before R2 receives the stream', async () => {
    const store = memoryStore()
    const put = vi.spyOn(store, 'put')
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: true, operatorId: 'owner' }),
    })
    expect((await route(uploadRequest(new Uint8Array([1])))).status).toBe(411)
    expect(put).not.toHaveBeenCalled()
  })

  it('rejects conflicting application and transport lengths before writing', async () => {
    const store = memoryStore()
    const put = vi.spyOn(store, 'put')
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: true, operatorId: 'owner' }),
    })
    const request = uploadRequest(new Uint8Array([1, 2, 3]), {
      'X-Upload-Length': '3',
      'Content-Length': '2',
    })
    expect((await route(request)).status).toBe(400)
    expect(put).not.toHaveBeenCalled()
  })

  it('aborts an underreported oversize stream and removes an ambiguous partial write', async () => {
    const store = memoryStore()
    let attemptedKey = ''
    store.put = async (key, body) => {
      attemptedKey = key
      store.objects.set(key, new Uint8Array([99]))
      for await (const _chunk of body as AsyncIterable<Uint8Array>) {
        // The byte limiter rejects after the first chunk; emulate a backend
        // that had persisted a prefix before surfacing the stream error.
      }
    }
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: true, operatorId: 'owner' }),
      maxBytes: 3,
    })
    const request = uploadRequest(new Uint8Array([1, 2, 3, 4]), { 'X-Upload-Length': '2' })
    const response = await route(request)
    expect(response.status).toBe(413)
    expect(attemptedKey).toMatch(/^owner\/_unattributed\//)
    expect(store.objects.has(attemptedKey)).toBe(false)
  })

  it('removes a committed object when the declared length does not match', async () => {
    const store = memoryStore()
    const route = createObjectUploadRoute({
      store,
      authorize: async () => ({ ok: true, operatorId: 'owner' }),
    })
    const request = uploadRequest(new Uint8Array([1, 2, 3]), { 'X-Upload-Length': '2' })
    const response = await route(request)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('invalid_length')
    expect(store.objects.size).toBe(0)
  })
})

describe('createR2ObjectStore streamed writes', () => {
  it('passes a known-length stream to an R2 binding', async () => {
    let received = 0
    class ProofFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
      constructor(length: number) {
        let count = 0
        super({
          transform(chunk, controller) {
            count += chunk.byteLength
            if (count > length) throw new Error('excess bytes')
            controller.enqueue(chunk)
          },
          flush() {
            if (count !== length) throw new Error('missing bytes')
          },
        })
        Object.defineProperty(this.readable, 'proofLength', { value: length })
      }
    }
    vi.stubGlobal('FixedLengthStream', ProofFixedLengthStream)
    try {
      const bucket: R2LikeBucket = {
        async put(_key, body) {
          if ((body as ReadableStream & { proofLength?: number }).proofLength !== 3) {
            throw new Error('R2 requires a known-length stream')
          }
          for await (const chunk of body as AsyncIterable<Uint8Array>) received += chunk.byteLength
        },
        async get() { return null },
        async head() { return null },
        async delete() {},
      }
      const store = createR2ObjectStore({ bucket })
      await store.put('owner/customer/proof.bin', new Blob([new Uint8Array([1, 2, 3])]).stream(), {
        contentLength: 3,
      })
      expect(received).toBe(3)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
