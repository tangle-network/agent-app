// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  __resetAttachmentFileCacheForTests,
  MessageAttachments,
  triggerAttachmentDownload,
} from '../../src/web-react/message-attachments'
import { ChatMessages } from '../../src/web-react/index'
import type { ChatAttachmentPart } from '../../src/web-react/chat-attachments'

afterEach(cleanup)

const imagePart: ChatAttachmentPart = { type: 'image', path: 'uploads/a.png', name: 'a.png', size: 2048, mediaType: 'image/png' }
const filePart: ChatAttachmentPart = { type: 'file', path: 'uploads/b.csv', name: 'b.csv', size: 512, mediaType: 'text/csv' }

function resolveFileUrl(part: ChatAttachmentPart): string {
  return `https://example.test/files/${part.path}`
}

/** A controllable fake `fetchFile`: each call is recorded and resolved/rejected
 *  by the caller, so tests can assert intermediate loading states. */
function fakeFetchFile() {
  const calls: { url: string; resolve: (res: Response) => void; reject: (err: unknown) => void }[] = []
  const fetchFile = vi.fn((url: string) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, resolve, reject })
    }),
  )
  return { fetchFile, calls }
}

/** Structural Response stub: Node's undici `Response` rejects a jsdom `Blob`
 *  body on CI ("object.stream is not a function"), and `loadAttachmentFile`
 *  only reads `ok`/`status`/`blob()`. */
function blobResponse(body: BlobPart[], init?: ResponseInit): Response {
  const status = init?.status ?? 200
  const blob = new Blob(body)
  return { ok: status >= 200 && status < 300, status, blob: async () => blob } as unknown as Response
}

beforeEach(() => {
  __resetAttachmentFileCacheForTests()
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock') as unknown as typeof URL.createObjectURL
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('MessageAttachments', () => {
  it('renders nothing for an empty parts array', () => {
    const { container } = render(<MessageAttachments parts={[]} resolveFileUrl={resolveFileUrl} />)
    expect(container.innerHTML).toBe('')
  })

  it('eager-fetches an image thumbnail on mount and renders an <img> once it resolves', async () => {
    const { fetchFile, calls } = fakeFetchFile()
    render(<MessageAttachments parts={[imagePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.url).toBe('https://example.test/files/uploads/a.png')
    expect(screen.queryByRole('img')).toBeNull()

    calls[0]!.resolve(blobResponse(['fake-bytes'], { status: 200 }))

    const img = await screen.findByRole('img')
    expect(img.getAttribute('src')).toBe('blob:mock')
  })

  it('shows a visible error box (never blank) when the thumbnail fetch fails', async () => {
    const { fetchFile, calls } = fakeFetchFile()
    render(<MessageAttachments parts={[imagePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)
    await waitFor(() => expect(calls).toHaveLength(1))

    calls[0]!.resolve(new Response(null, { status: 404 }))

    await waitFor(() => expect(screen.queryByRole('img')).toBeNull())
    expect(screen.getByText('a.png')).toBeTruthy()
  })

  it('renders a file chip with name and formatted size', () => {
    const { fetchFile } = fakeFetchFile()
    render(<MessageAttachments parts={[filePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)
    const button = screen.getByRole('button')
    expect(button.textContent).toContain('b.csv')
    expect(button.textContent).toContain('512B')
  })

  it('does not fetch a chip on mount', () => {
    const { fetchFile } = fakeFetchFile()
    render(<MessageAttachments parts={[filePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('fetches and downloads on chip click', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { fetchFile, calls } = fakeFetchFile()
    render(<MessageAttachments parts={[filePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.url).toBe('https://example.test/files/uploads/b.csv')

    calls[0]!.resolve(blobResponse(['a,b,c'], { status: 200 }))

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1))
    clickSpy.mockRestore()
  })

  it('switches the chip to a visible error state when the download fetch fails', async () => {
    const { fetchFile, calls } = fakeFetchFile()
    render(<MessageAttachments parts={[filePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(calls).toHaveLength(1))

    calls[0]!.resolve(new Response(null, { status: 403 }))

    await waitFor(() => expect(screen.getByRole('button').getAttribute('title')).toBe('Failed to load attachment (403)'))
    expect(screen.getByText(/b\.csv/)).toBeTruthy()
  })

  it('evicts a failed result so a subsequent click issues a fresh fetch', async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const { fetchFile, calls } = fakeFetchFile()
    render(<MessageAttachments parts={[filePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0]!.resolve(new Response(null, { status: 500 }))
    await waitFor(() => expect(screen.getByRole('button').getAttribute('title')).toBe('Failed to load attachment (500)'))

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(calls).toHaveLength(2))
    calls[1]!.resolve(blobResponse(['a,b,c'], { status: 200 }))

    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1))
    clickSpy.mockRestore()
  })

  it('caches a successful fetch so a remount does not re-fetch', async () => {
    const { fetchFile, calls } = fakeFetchFile()
    const { unmount } = render(<MessageAttachments parts={[imagePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0]!.resolve(blobResponse(['fake-bytes'], { status: 200 }))
    await screen.findByRole('img')
    unmount()

    render(<MessageAttachments parts={[imagePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)
    await screen.findByRole('img')
    expect(calls).toHaveLength(1) // still just the one fetch
  })

  it('dedupes two concurrent mounts of the same part to exactly one fetch', async () => {
    const { fetchFile, calls } = fakeFetchFile()
    render(
      <>
        <MessageAttachments parts={[imagePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />
        <MessageAttachments parts={[imagePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />
      </>,
    )
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls).toHaveLength(1)
  })

  it('right-aligns (justify-end) by default', () => {
    const { fetchFile } = fakeFetchFile()
    const { container } = render(<MessageAttachments parts={[filePart]} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />)
    expect(container.firstElementChild?.className).toContain('justify-end')
    expect(container.firstElementChild?.className).not.toContain('justify-start')
  })

  it('left-aligns (justify-start) when justify="start"', () => {
    const { fetchFile } = fakeFetchFile()
    const { container } = render(
      <MessageAttachments parts={[filePart]} resolveFileUrl={resolveFileUrl} justify="start" fetchFile={fetchFile} />,
    )
    expect(container.firstElementChild?.className).toContain('justify-start')
    expect(container.firstElementChild?.className).not.toContain('justify-end')
  })
})

describe('triggerAttachmentDownload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('synthesizes an <a download> click and revokes the object URL', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const outcome = triggerAttachmentDownload('report.pdf', new Blob(['hi']))
    expect(outcome).toEqual({ ok: true })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })

  it('returns a typed failure when creating the object URL throws', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    globalThis.URL.createObjectURL = vi.fn(() => {
      throw new Error('createObjectURL unsupported')
    }) as unknown as typeof URL.createObjectURL
    const outcome = triggerAttachmentDownload('report.pdf', new Blob(['hi']))
    expect(outcome).toEqual({ ok: false, message: 'createObjectURL unsupported' })
  })
})

describe('ChatMessages attachment wiring', () => {
  const messageWithAttachment = {
    id: 'user-1',
    role: 'user' as const,
    content: 'here is a file',
    parts: [{ type: 'file', path: 'uploads/b.csv', name: 'b.csv', size: 512, mediaType: 'text/csv' }],
  }

  it('renders attachments when resolveAttachmentUrl is set and the message carries attachment parts', () => {
    render(<ChatMessages messages={[messageWithAttachment]} resolveAttachmentUrl={resolveFileUrl} />)
    const button = screen.getByRole('button')
    expect(button.textContent).toContain('b.csv')
  })

  it('renders as before (no attachment row) when resolveAttachmentUrl is absent', () => {
    render(<ChatMessages messages={[messageWithAttachment]} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('here is a file')).toBeTruthy()
  })
})
