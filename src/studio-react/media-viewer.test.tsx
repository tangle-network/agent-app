// @vitest-environment jsdom
import { type ReactNode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Generation, StudioMediaActions } from '../studio'
import { MediaViewerModal, type MediaViewerModalProps } from './media-viewer'
import {
  type StudioAudioElementLike,
  StudioPlaybackProvider,
  useStudioPlayback,
} from './studio-playback'

class FakeAudio implements StudioAudioElementLike {
  src = ''
  currentTime = 0
  duration = Number.NaN
  play = vi.fn<() => void>()
  pause = vi.fn<() => void>()
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }
}

function generation(overrides: Partial<Generation> = {}): Generation {
  return {
    id: 'generation-1',
    type: 'image',
    prompt: 'A glass city at dusk',
    result: 'https://media.test/result.png',
    model: null,
    cost: null,
    createdAt: null,
    metadata: null,
    ...overrides,
  }
}

function PlaybackProbe(): ReactNode {
  const playback = useStudioPlayback()
  return <output data-testid="playback-probe" data-active-id={playback.activeId ?? ''} />
}

function Viewer(props: MediaViewerModalProps & { audio?: FakeAudio; probe?: boolean }) {
  return (
    <StudioPlaybackProvider createAudioElement={() => props.audio ?? new FakeAudio()}>
      {props.probe && <PlaybackProbe />}
      <MediaViewerModal
        generation={props.generation}
        onClose={props.onClose}
        actions={props.actions}
        onRequestDelete={props.onRequestDelete}
        onSaved={props.onSaved}
      />
    </StudioPlaybackProvider>
  )
}

afterEach(() => {
  cleanup()
  document.querySelectorAll('[data-agent-app-popover]').forEach((node) => node.remove())
})

describe('MediaViewerModal', () => {
  it('renders nothing for a null generation', () => {
    const { container } = render(<Viewer generation={null} onClose={() => {}} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('focuses Close on open and restores the previously focused element on close', () => {
    const row = generation()
    const onClose = vi.fn()
    const view = render(<Viewer generation={null} onClose={onClose} />)
    const opener = document.createElement('button')
    opener.textContent = 'Open media'
    document.body.appendChild(opener)
    opener.focus()

    view.rerender(<Viewer generation={row} onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'Media detail' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('closes on Escape and backdrop mousedown, but not panel mousedown', () => {
    const onClose = vi.fn()
    render(<Viewer generation={generation()} onClose={onClose} />)
    const dialog = screen.getByRole('dialog')
    const backdrop = dialog.parentElement!

    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('wraps Tab from the last focusable control and Shift+Tab from Close', () => {
    render(
      <Viewer
        generation={generation()}
        onClose={() => {}}
        onRequestDelete={() => {}}
      />,
    )
    const dialog = screen.getByRole('dialog')
    const close = within(dialog).getByRole('button', { name: 'Close' })
    const deleteButton = within(dialog).getByRole('button', { name: 'Delete' })

    deleteButton.focus()
    fireEvent.keyDown(deleteButton, { key: 'Tab', code: 'Tab' })
    expect(document.activeElement).toBe(close)

    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', code: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(deleteButton)
  })

  it('suspends the focus trap and viewer Escape handler while a popover surface is open', () => {
    const onClose = vi.fn()
    render(
      <Viewer
        generation={generation()}
        onClose={onClose}
        onRequestDelete={() => {}}
      />,
    )
    const popover = document.createElement('div')
    popover.setAttribute('data-agent-app-popover', 'test')
    document.body.appendChild(popover)
    const close = screen.getByRole('button', { name: 'Close' })
    const deleteButton = screen.getByRole('button', { name: 'Delete' })

    deleteButton.focus()
    fireEvent.keyDown(deleteButton, { key: 'Tab', code: 'Tab' })
    expect(document.activeElement).toBe(deleteButton)
    expect(document.activeElement).not.toBe(close)

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('joins only present metadata segments with separators', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T12:00:00Z'))
    const view = render(
      <Viewer
        generation={generation({
          model: 'image-model-x',
          createdAt: new Date('2026-08-19T12:00:00Z'),
          metadata: { size: '1536x1024' },
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/Image · image-model-x · 1536×1024 · just now/)).toBeTruthy()

    view.rerender(<Viewer generation={generation({ model: null, createdAt: null })} onClose={() => {}} />)
    const dialogText = screen.getByRole('dialog').textContent ?? ''
    expect(dialogText).toContain('Image')
    expect(dialogText).not.toContain('··')
    expect(dialogText).not.toContain('image-model-x')
    vi.useRealTimers()
  })

  it('shows Save or View according to vault state and hides Delete without its callback', () => {
    const actions: StudioMediaActions = {
      save: vi.fn(async () => []),
      vaultHref: (path) => `/vault/${path}`,
    }
    const view = render(<Viewer generation={generation()} onClose={() => {}} actions={actions} />)
    expect(screen.getByRole('button', { name: 'Save to vault' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'View in vault' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()

    view.rerender(
      <Viewer
        generation={generation({ metadata: { vaultPath: 'generated/images/city.png' } })}
        onClose={() => {}}
        actions={actions}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Save to vault' })).toBeNull()
    expect(screen.getByRole('link', { name: 'View in vault' }).getAttribute('href')).toBe('/vault/generated/images/city.png')
  })

  it('plays and seeks speech, then stops playback when the viewer closes', () => {
    const audio = new FakeAudio()
    const row = generation({
      type: 'speech',
      result: 'https://media.test/result.mp3',
      metadata: { durationSeconds: 30 },
    })
    render(<Viewer generation={row} onClose={() => {}} audio={audio} probe />)
    const seek = screen.getByRole('slider', { name: 'Seek' })

    act(() => fireEvent.keyDown(seek, { key: ' ', code: 'Space' }))
    expect(audio.play).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()

    act(() => fireEvent.keyDown(seek, { key: 'ArrowRight', code: 'ArrowRight' }))
    expect(audio.currentTime).toBe(5)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(audio.pause).toHaveBeenCalled()
    expect(audio.currentTime).toBe(0)
    expect(screen.getByTestId('playback-probe').getAttribute('data-active-id')).toBe('')
  })

  it('stops playback during unmount cleanup', () => {
    const audio = new FakeAudio()
    const row = generation({ type: 'speech', result: 'https://media.test/result.mp3', metadata: { durationSeconds: 10 } })
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <StudioPlaybackProvider createAudioElement={() => audio}>
          {open && <MediaViewerModal generation={row} onClose={() => setOpen(false)} />}
        </StudioPlaybackProvider>
      )
    }
    const view = render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    view.unmount()
    expect(audio.pause).toHaveBeenCalled()
    expect(audio.currentTime).toBe(0)
  })
})
