// @vitest-environment jsdom
/**
 * CanvasInsertPanel: tab visibility driven by callbacks/templates, the
 * upload→insert flow (host callback returns a url, panel inserts via onInsert),
 * template insertion, and the media-boundary error path (a bad upload url is
 * surfaced inline, never inserted).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CanvasInsertPanel } from '../../src/design-canvas-react/components/CanvasInsertPanel'
import type { InsertPageGeometry } from '../../src/design-canvas-react/insert-builders'

afterEach(cleanup)

const PAGE: InsertPageGeometry = { pageId: 'page-1', width: 1080, height: 1080 }

function setup(overrides: Partial<Parameters<typeof CanvasInsertPanel>[0]> = {}) {
  const onInsert = vi.fn().mockResolvedValue(undefined)
  const onUploadImage = vi.fn().mockResolvedValue('https://cdn.example.com/up.png')
  render(
    createElement(CanvasInsertPanel, {
      canWrite: true,
      page: PAGE,
      onInsert,
      onUploadImage,
      ...overrides,
    }),
  )
  return { onInsert, onUploadImage }
}

describe('tabs', () => {
  it('shows Uploads + Templates by default, hides Generations without a provider', () => {
    setup()
    expect(screen.getByText('Uploads')).toBeTruthy()
    expect(screen.getByText('Templates')).toBeTruthy()
    expect(screen.queryByText('Generations')).toBeNull()
  })

  it('shows Generations when a loader is provided', () => {
    setup({ loadGenerations: vi.fn().mockResolvedValue([]) })
    expect(screen.getByText('Generations')).toBeTruthy()
  })

  it('view-only access hides the insert affordances', () => {
    setup({ canWrite: false })
    expect(screen.getByText(/view-only access/)).toBeTruthy()
  })
})

describe('upload → insert', () => {
  // jsdom's Image never fires load/error, so probeImageSize relies on its
  // timeout fallback. Drive it with fake timers instead of waiting wall-clock.
  it('uploads each file via the host callback and inserts the returned url', async () => {
    vi.useFakeTimers()
    try {
      const { onInsert, onUploadImage } = setup()
      const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
      const input = document.querySelector('input[type=file]') as HTMLInputElement
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } })
      })
      // Upload resolves on a microtask; flush, then fire the probe timeout.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(onUploadImage).toHaveBeenCalledWith(file)
      expect(onInsert).toHaveBeenCalledTimes(1)
      const ops = onInsert.mock.calls[0]![0]
      expect(ops[0].type).toBe('add_element')
      expect(ops[0].element.src).toBe('https://cdn.example.com/up.png')
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces an error and does NOT insert when the host returns a data: url', async () => {
    // The boundary check runs before any image probe, so no timers are needed.
    const onInsert = vi.fn().mockResolvedValue(undefined)
    const onUploadImage = vi.fn().mockResolvedValue('data:image/png;base64,AAAA')
    render(
      createElement(CanvasInsertPanel, { canWrite: true, page: PAGE, onInsert, onUploadImage }),
    )
    const file = new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' })
    const input = document.querySelector('input[type=file]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByText(/http\(s\) URL or a rooted/)).toBeTruthy())
    expect(onInsert).not.toHaveBeenCalled()
  })
})

describe('templates', () => {
  it('inserts a template through onInsert', async () => {
    const { onInsert } = setup()
    fireEvent.click(screen.getByText('Templates'))
    await act(async () => {
      fireEvent.click(screen.getByText('Heading'))
    })
    await waitFor(() => expect(onInsert).toHaveBeenCalledTimes(1))
    const ops = onInsert.mock.calls[0]![0]
    expect(ops[0].element.kind).toBe('text')
  })
})
