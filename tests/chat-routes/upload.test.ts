import { describe, expect, it } from 'vitest'

import {
  bytesToBase64,
  createUploadRoute,
  sanitizeUploadFilename,
  type SandboxUploadSink,
  type UploadedChatFile,
} from '../../src/chat-routes/index'

function uploadRequest(files: Array<{ name: string; type: string; bytes: Uint8Array }>): Request {
  const form = new FormData()
  for (const file of files) {
    form.append('files', new File([file.bytes as BlobPart], file.name, { type: file.type }))
  }
  return new Request('http://app.test/api/chat/upload', { method: 'POST', body: form })
}

function recordingSink() {
  const writes: Array<{ path: string; content: string; options?: { encoding?: string } }> = []
  const sink: SandboxUploadSink = {
    async write(path, content, options) {
      writes.push({ path, content, ...(options ? { options } : {}) })
    },
  }
  return { sink, writes }
}

describe('createUploadRoute', () => {
  it('returns an inline data-URI part for a small image', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10])
    const route = createUploadRoute({ authorize: async () => ({ ok: true }) })
    const res = await route(uploadRequest([{ name: 'chart.png', type: 'image/png', bytes }]))

    expect(res.status).toBe(200)
    const { files } = await res.json() as { files: UploadedChatFile[] }
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      name: 'chart.png',
      size: bytes.length,
      mediaType: 'image/png',
      inline: true,
      part: {
        type: 'image',
        filename: 'chart.png',
        mediaType: 'image/png',
        url: `data:image/png;base64,${bytesToBase64(bytes)}`,
      },
    })
  })

  it('writes a large file to the sandbox as base64 and returns a path-ref part', async () => {
    const { sink, writes } = recordingSink()
    const bytes = new Uint8Array(64).fill(7)
    const route = createUploadRoute({
      authorize: async () => ({ ok: true, sink }),
      inlineMaxBytes: 16, // force the sandbox lane
    })
    const res = await route(uploadRequest([{ name: 'report.pdf', type: 'application/pdf', bytes }]))

    expect(res.status).toBe(200)
    const { files } = await res.json() as { files: UploadedChatFile[] }
    expect(files[0]).toMatchObject({ inline: false, mediaType: 'application/pdf' })
    expect(files[0]!.part.type).toBe('file')
    expect(files[0]!.part.url).toBeUndefined()
    expect(files[0]!.part.path).toMatch(/^uploads\/[0-9a-f-]+-report\.pdf$/)

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      path: files[0]!.part.path,
      content: bytesToBase64(bytes),
      options: { encoding: 'base64' },
    })
  })

  it('rejects an over-inline-cap file when no sandbox sink is available', async () => {
    const route = createUploadRoute({
      authorize: async () => ({ ok: true }),
      inlineMaxBytes: 8,
    })
    const res = await route(uploadRequest([{ name: 'big.bin', type: 'application/octet-stream', bytes: new Uint8Array(32) }]))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe('SANDBOX_REQUIRED')
  })

  it('rejects a file over the hard per-file cap even with a sink', async () => {
    const { sink, writes } = recordingSink()
    const route = createUploadRoute({
      authorize: async () => ({ ok: true, sink }),
      inlineMaxBytes: 8,
      maxFileBytes: 16,
    })
    const res = await route(uploadRequest([{ name: 'huge.bin', type: 'application/octet-stream', bytes: new Uint8Array(64) }]))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { code: string }).code).toBe('FILE_TOO_LARGE')
    expect(writes).toHaveLength(0)
  })

  it('short-circuits with the authorize response and rejects empty/non-form bodies', async () => {
    const denied = createUploadRoute({
      authorize: async () => ({ ok: false, response: Response.json({ error: 'no' }, { status: 401 }) }),
    })
    expect((await denied(uploadRequest([{ name: 'x', type: 'text/plain', bytes: new Uint8Array(1) }]))).status).toBe(401)

    const route = createUploadRoute({ authorize: async () => ({ ok: true }) })
    expect((await route(uploadRequest([]))).status).toBe(400)
    const notForm = new Request('http://app.test/upload', { method: 'POST', body: '{"not":"form"}' })
    expect((await route(notForm)).status).toBe(400)
  })

  it('sanitizes hostile filenames into path-safe basenames', () => {
    expect(sanitizeUploadFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeUploadFilename('..\\..\\boot.ini')).toBe('boot.ini')
    expect(sanitizeUploadFilename('.hidden')).toBe('_hidden')
    expect(sanitizeUploadFilename('spaced name (1).png')).toBe('spaced_name_1_.png')
    expect(sanitizeUploadFilename('')).toBe('file')
    expect(sanitizeUploadFilename('x'.repeat(300))).toHaveLength(120)
  })

  it('honors the per-request uploadDir override from authorize', async () => {
    const { sink, writes } = recordingSink()
    const route = createUploadRoute({
      authorize: async () => ({ ok: true, sink, uploadDir: 'workspaces/ws-1/uploads' }),
      inlineMaxBytes: 1,
    })
    await route(uploadRequest([{ name: 'a.txt', type: 'text/plain', bytes: new Uint8Array(8) }]))
    expect(writes[0]!.path.startsWith('workspaces/ws-1/uploads/')).toBe(true)
  })
})
