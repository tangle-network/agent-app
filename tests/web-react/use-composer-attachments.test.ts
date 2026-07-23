// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import { ATTACHMENT_ACCEPT, useComposerAttachments } from '../../src/web-react/use-composer-attachments'
import type { ChatAttachmentInput } from '../../src/web-react/chat-stream'

// Port of gtm-agent's `src/components/composer-attachments.test.tsx`, adapted
// to the new contract: `uploadUrl`/`buildUploadRequest` instead of a
// hardcoded vault URL, `onReject`/`onError` instead of sonner toasts, a full
// `ChatAttachmentInput` server response instead of `{path, name}`, and
// `enabled` instead of a `workspaceId`-truthiness gate. The hand-rolled
// `createRoot`+`act` harness becomes `@testing-library/react`'s `renderHook`.

interface FakeResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

interface PendingCall {
  url: string
  init: RequestInit
  resolve: (res: FakeResponse) => void
  reject: (err: unknown) => void
}

let calls: PendingCall[] = []
let blobCount = 0

/** Real PNG magic bytes, so `sniffBinary` classifies content instead of the
 *  plain-ASCII stand-in `png()` produces (which sniffs as text and never
 *  exercises the type gate). */
function png(name: string, extraBytes: number[] = [1, 2, 3, 4]): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extraBytes])
  return new File([bytes], name, { type: 'image/png' })
}

/** PNG signature followed by zero-padding out to `size` — passes the type
 *  gate while staying cheap to allocate for size-ceiling tests. */
function pngOfSize(name: string, size: number): File {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return new File([bytes], name, { type: 'image/png' })
}

/** ID3v2-tagged mp3 magic bytes — a disallowed attachment type. */
function mp3(name: string): File {
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01])
  return new File([bytes], name, { type: 'audio/mpeg' })
}

function textFile(name: string, size: number): File {
  return new File([new Uint8Array(size).fill(97)], name, { type: 'text/plain' })
}

function ok(files: ChatAttachmentInput[]): FakeResponse {
  return { ok: true, status: 200, json: async () => ({ files }) }
}

function fail(status: number, error: unknown): FakeResponse {
  return { ok: false, status, json: async () => ({ error }) }
}

beforeEach(() => {
  calls = []
  blobCount = 0
  globalThis.fetch = vi.fn((url: string, init: RequestInit) =>
    new Promise<FakeResponse>((resolve, reject) => {
      calls.push({ url: String(url), init, resolve, reject })
    }),
  ) as unknown as typeof fetch
  globalThis.URL.createObjectURL = vi.fn(() => `blob:${++blobCount}`)
  globalThis.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useComposerAttachments', () => {
  it('re-exports ATTACHMENT_ACCEPT for the composer accept prop', () => {
    expect(ATTACHMENT_ACCEPT).toContain('image/*')
  })

  it('takes a file pending → uploading → ready and exposes the server reference verbatim', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))

    await act(async () => {
      await result.current.addFiles([png('a.png')])
    })
    expect(result.current.composerFiles).toHaveLength(1)
    expect(result.current.composerFiles[0]!.status).toBe('uploading')
    expect(result.current.hasPending).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/upload')

    const serverFile: ChatAttachmentInput = {
      path: 'store/a.png', name: 'a.png', size: 999, mediaType: 'image/png', kind: 'image',
    }
    calls[0]!.resolve(ok([serverFile]))
    await waitFor(() => expect(result.current.composerFiles[0]!.status).toBe('ready'))

    expect(result.current.hasPending).toBe(false)
    // Server-returned size (999) wins over the tiny client-side file size —
    // no client recompute.
    expect(result.current.references).toEqual([serverFile])
    expect(result.current.blockReason).toBeNull()
  })

  it('marks a file error from a {error: string} response body and calls onError', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload', onError }))
    await act(async () => {
      await result.current.addFiles([png('b.png')])
    })
    calls[0]!.resolve(fail(413, 'File "b.png" exceeds the limit'))
    await waitFor(() => expect(result.current.composerFiles[0]!.status).toBe('error'))

    expect(onError).toHaveBeenCalledWith('File "b.png" exceeds the limit')
    expect(result.current.hasError).toBe(true)
    expect(result.current.blockReason).toBe('Remove failed attachments to send')
    expect(result.current.references).toEqual([])
  })

  it('marks a file error from a {error: {message}} response body', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload', onError }))
    await act(async () => {
      await result.current.addFiles([png('c.png')])
    })
    calls[0]!.resolve(fail(400, { code: 'BAD_PATH', message: 'Invalid store path' }))
    await waitFor(() => expect(result.current.composerFiles[0]!.status).toBe('error'))
    expect(onError).toHaveBeenCalledWith('Invalid store path')
  })

  it('retry re-uploads the retained file and reaches ready', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))
    await act(async () => {
      await result.current.addFiles([png('d.png')])
    })
    calls[0]!.resolve(fail(500, 'boom'))
    await waitFor(() => expect(result.current.composerFiles[0]!.status).toBe('error'))
    const id = result.current.composerFiles[0]!.id

    act(() => {
      result.current.retry(id)
    })
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(result.current.composerFiles[0]!.status).toBe('uploading')

    const serverFile: ChatAttachmentInput = {
      path: 'store/d.png', name: 'd.png', size: 3, mediaType: 'image/png', kind: 'image',
    }
    calls[1]!.resolve(ok([serverFile]))
    await waitFor(() => expect(result.current.composerFiles[0]!.status).toBe('ready'))
    expect(result.current.references).toEqual([serverFile])
  })

  it('rejects an oversize binary file without any network call', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() =>
      useComposerAttachments({ uploadUrl: '/upload', onReject, limits: { maxBinaryBytes: 20 } }),
    )
    await act(async () => {
      await result.current.addFiles([pngOfSize('big.png', 30)])
    })
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('big.png'), expect.any(File))
    expect(calls).toHaveLength(0)
    expect(result.current.composerFiles).toHaveLength(0)
  })

  it('rejects an oversize text file without any network call', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() =>
      useComposerAttachments({ uploadUrl: '/upload', onReject, limits: { maxTextBytes: 5 } }),
    )
    await act(async () => {
      await result.current.addFiles([textFile('big.txt', 10)])
    })
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('big.txt'), expect.any(File))
    expect(calls).toHaveLength(0)
    expect(result.current.composerFiles).toHaveLength(0)
  })

  it('rejects a file whose content mismatches its extension', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload', onReject }))
    await act(async () => {
      await result.current.addFiles([png('invoice.pdf')])
    })
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('image/png'), expect.any(File))
    expect(calls).toHaveLength(0)
    expect(result.current.composerFiles).toHaveLength(0)
  })

  it('rejects content sniffed as a disallowed attachment type', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload', onReject }))
    await act(async () => {
      await result.current.addFiles([mp3('track.mp3')])
    })
    expect(onReject).toHaveBeenCalled()
    expect(calls).toHaveLength(0)
    expect(result.current.composerFiles).toHaveLength(0)
  })

  it('rejects an otherwise-valid file whose kind is not in allowedKinds', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() =>
      useComposerAttachments({ uploadUrl: '/upload', onReject, allowedKinds: ['file'] }),
    )
    await act(async () => {
      await result.current.addFiles([png('photo.png')])
    })
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('image'), expect.any(File))
    expect(calls).toHaveLength(0)
    expect(result.current.composerFiles).toHaveLength(0)
  })

  it('enforces the count cap including already-staged entries', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() =>
      useComposerAttachments({ uploadUrl: '/upload', onReject, limits: { maxCount: 1 } }),
    )
    await act(async () => {
      await result.current.addFiles([png('one.png'), png('two.png')])
    })
    expect(result.current.composerFiles.map((f) => f.name)).toEqual(['one.png'])
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('limit'), expect.any(File))
    expect(calls).toHaveLength(1)
  })

  it('drops files that would exceed the aggregate total-bytes ceiling (partial acceptance)', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() =>
      useComposerAttachments({ uploadUrl: '/upload', onReject, limits: { maxTotalBytes: 15 } }),
    )
    await act(async () => {
      await result.current.addFiles([pngOfSize('one.png', 10), pngOfSize('two.png', 10)])
    })
    expect(result.current.composerFiles.map((f) => f.name)).toEqual(['one.png'])
    expect(onReject).toHaveBeenCalledWith(expect.stringContaining('limited to'), expect.any(File))
    expect(calls).toHaveLength(1)
  })

  it('references contains only ready entries, pass-through from the server', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))
    await act(async () => {
      await result.current.addFiles([png('x.png'), png('y.png')])
    })
    const serverFile: ChatAttachmentInput = {
      path: 'store/x.png', name: 'x.png', size: 12, mediaType: 'image/png', kind: 'image',
    }
    calls[0]!.resolve(ok([serverFile]))
    calls[1]!.resolve(fail(500, 'no'))
    await waitFor(() => expect(result.current.composerFiles.every((f) => f.status !== 'uploading')).toBe(true))
    expect(result.current.references).toEqual([serverFile])
  })

  it('removeAttachment aborts the in-flight upload and revokes the preview with no error state', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))
    await act(async () => {
      await result.current.addFiles([png('z.png')])
    })
    const signal = calls[0]!.init.signal as AbortSignal
    const id = result.current.composerFiles[0]!.id

    act(() => {
      result.current.removeAttachment(id)
    })
    expect(signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalled()
    expect(result.current.composerFiles).toHaveLength(0)
    expect(result.current.hasError).toBe(false)
  })

  it('clear aborts every in-flight upload and revokes every preview', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))
    await act(async () => {
      await result.current.addFiles([png('a.png'), png('b.png')])
    })
    const signals = calls.map((c) => c.init.signal as AbortSignal)

    act(() => {
      result.current.clear()
    })
    for (const signal of signals) expect(signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(result.current.composerFiles).toHaveLength(0)
  })

  it('aborts every staged upload and revokes previews on unmount', async () => {
    const { result, unmount } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))
    await act(async () => {
      await result.current.addFiles([png('a.png')])
    })
    const signal = calls[0]!.init.signal as AbortSignal

    unmount()
    expect(signal.aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it('dedupes duplicate names against currently staged files with a store-safe suffix', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))
    await act(async () => {
      await result.current.addFiles([png('dup.png'), png('dup.png')])
    })
    expect(result.current.composerFiles.map((f) => f.name)).toEqual(['dup.png', 'dup-2.png'])
    expect((calls[1]!.init.body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('stages and uploads under a sanitized name when the filename has unsupported characters', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload' }))
    await act(async () => {
      await result.current.addFiles([png('CleanShot 2026-07-14 at 18.46.28@2x.png')])
    })
    expect(result.current.composerFiles[0]!.name).toBe('CleanShot-2026-07-14-at-18.46.28-2x.png')
    const form = calls[0]!.init.body as FormData
    expect((form.get('file') as File).name).toBe('CleanShot-2026-07-14-at-18.46.28-2x.png')
  })

  it('buildUploadRequest wins over uploadUrl and its url/init reach fetch', async () => {
    const buildUploadRequest = vi.fn(({ file, name, form }: { file: File; name: string; form: FormData }) => {
      expect(file.name).toBe('a.png')
      expect(name).toBe('a.png')
      expect(form.get('file')).toBeInstanceOf(File)
      return { url: '/custom-upload', init: { headers: { 'X-Test': 'yes' } } }
    })
    const { result } = renderHook(() =>
      useComposerAttachments({ uploadUrl: '/should-not-be-used', buildUploadRequest }),
    )
    await act(async () => {
      await result.current.addFiles([png('a.png')])
    })
    expect(buildUploadRequest).toHaveBeenCalledTimes(1)
    expect(calls[0]!.url).toBe('/custom-upload')
    expect((calls[0]!.init.headers as Record<string, string>)['X-Test']).toBe('yes')
  })

  it('falls back to uploadUrl when no buildUploadRequest is provided', async () => {
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/plain-upload' }))
    await act(async () => {
      await result.current.addFiles([png('a.png')])
    })
    expect(calls[0]!.url).toBe('/plain-upload')
  })

  it('enabled:false rejects addFiles via onReject with no fetch', async () => {
    const onReject = vi.fn()
    const { result } = renderHook(() => useComposerAttachments({ uploadUrl: '/upload', onReject, enabled: false }))
    await act(async () => {
      await result.current.addFiles([png('a.png')])
    })
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
    expect(result.current.composerFiles).toHaveLength(0)
    expect(result.current.blockReason).toBe('Attachments are disabled')
  })

  it('lands an entry in error (with onError) when neither uploadUrl nor buildUploadRequest is configured', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useComposerAttachments({ onError }))
    await act(async () => {
      await result.current.addFiles([png('a.png')])
    })
    expect(calls).toHaveLength(0)
    expect(result.current.composerFiles[0]!.status).toBe('error')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(result.current.hasError).toBe(true)
  })
})
