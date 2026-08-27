// @vitest-environment jsdom
import { type ReactNode, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Generation } from '../studio/generation'
import type { StudioMediaActions } from '../studio/ports'
import { downloadGenerationsViaAnchor } from './download-generations'
import { MediaTile, type MediaTileProps } from './media-tile'
import { type StudioAudioElementLike, StudioPlaybackProvider } from './studio-playback'

class FakeAudio implements StudioAudioElementLike {
  src = ''
  currentTime = 0
  duration = 10
  play = vi.fn<() => void>()
  pause = vi.fn<() => void>()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

function generation(overrides: Partial<Generation> = {}): Generation {
  return {
    id: 'gen-1',
    type: 'image',
    prompt: 'A bright horizon',
    result: 'https://media.test/output.png',
    model: null,
    cost: null,
    createdAt: null,
    metadata: null,
    ...overrides,
  }
}

function setup(props: Partial<MediaTileProps> = {}, audio = new FakeAudio()) {
  const onOpen = props.onOpen ?? vi.fn()
  const view = render(
    <StudioPlaybackProvider createAudioElement={() => audio}>
      <MediaTile
        generation={generation()}
        context="home"
        onOpen={onOpen}
        {...props}
      />
    </StudioPlaybackProvider>,
  )
  return { ...view, audio, onOpen }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MediaTile', () => {
  it('renders image art and a skeleton for a running generation', () => {
    const view = setup()
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://media.test/output.png')

    view.rerender(
      <StudioPlaybackProvider createAudioElement={() => view.audio}>
        <MediaTile generation={generation({ result: null })} context="home" onOpen={view.onOpen} />
      </StudioPlaybackProvider>,
    )
    expect(view.container.querySelector('.studio-skeleton')).toBeTruthy()
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('renders a failed generation error without a skeleton', () => {
    const view = setup({
      generation: generation({
        result: null,
        metadata: { generationStatus: 'failed', providerError: 'Provider rejected the request' },
      }),
    })
    expect(screen.getByText('Provider rejected the request')).toBeTruthy()
    expect(view.container.querySelector('.studio-skeleton')).toBeNull()
  })

  it('renders avatar art as video and transcription art as a document placeholder', () => {
    const view = setup({
      generation: generation({ type: 'avatar', result: 'https://media.test/avatar.mp4' }),
    })
    expect(view.container.querySelector('video')?.getAttribute('src')).toBe('https://media.test/avatar.mp4')
    expect(view.container.querySelector('img')).toBeNull()

    view.rerender(
      <StudioPlaybackProvider createAudioElement={() => view.audio}>
        <MediaTile
          generation={generation({ type: 'transcription', result: 'Transcript content' })}
          context="home"
          onOpen={view.onOpen}
        />
      </StudioPlaybackProvider>,
    )
    expect(view.container.querySelector('svg.lucide-file-text')).toBeTruthy()
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('renders available actions, choosing Save or View without showing both', () => {
    const actions: StudioMediaActions = {
      download: vi.fn(),
      save: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
      vaultHref: (path) => `/vault/${path}`,
    }
    const onRequestDelete = vi.fn()
    const view = setup({ actions, onRequestDelete })
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save to vault' })).toBeTruthy()
    expect(screen.queryByLabelText('View in vault')).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()

    view.rerender(
      <StudioPlaybackProvider createAudioElement={() => view.audio}>
        <MediaTile
          generation={generation({ metadata: {
            vaultPath: 'generated/images/output.png',
            savedToVaultAt: null,
          } })}
          context="home"
          onOpen={view.onOpen}
          actions={actions}
          onRequestDelete={onRequestDelete}
        />
      </StudioPlaybackProvider>,
    )
    expect(screen.getByRole('button', { name: 'Save to vault' })).toBeTruthy()
    expect(screen.queryByLabelText('View in vault')).toBeNull()

    view.rerender(
      <StudioPlaybackProvider createAudioElement={() => view.audio}>
        <MediaTile
          generation={generation({ metadata: {
            vaultPath: 'generated/images/output.png',
            savedToVaultAt: '2026-08-27T00:00:00.000Z',
          } })}
          context="home"
          onOpen={view.onOpen}
          actions={actions}
          onRequestDelete={onRequestDelete}
        />
      </StudioPlaybackProvider>,
    )
    expect(screen.queryByLabelText('Save to vault')).toBeNull()
    expect(screen.getByRole('link', { name: 'View in vault' })).toBeTruthy()

    view.rerender(
      <StudioPlaybackProvider createAudioElement={() => view.audio}>
        <MediaTile
          generation={generation({
            id: 'local-pending',
            result: null,
            metadata: { generationStatus: 'pending' },
          })}
          context="home"
          onOpen={view.onOpen}
          actions={actions}
          onRequestDelete={onRequestDelete}
        />
      </StudioPlaybackProvider>,
    )
    expect(screen.queryByLabelText('Save to vault')).toBeNull()
    expect(screen.queryByLabelText('View in vault')).toBeNull()
  })

  it('keeps Download via the anchor fallback but hides Delete without a request callback', () => {
    const view = setup({ actions: { save: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue(undefined) } })
    expect(screen.getByLabelText('Download')).toBeTruthy()
    expect(screen.queryByLabelText('Delete')).toBeNull()

    view.rerender(
      <StudioPlaybackProvider createAudioElement={() => view.audio}>
        <MediaTile generation={generation()} context="home" onOpen={view.onOpen} />
      </StudioPlaybackProvider>,
    )
    expect(screen.getByLabelText('Download')).toBeTruthy()
  })

  it('shows the persistent vault chip only for saved rows', () => {
    const view = setup()
    expect(screen.queryByText('In vault')).toBeNull()
    view.rerender(
      <StudioPlaybackProvider createAudioElement={() => view.audio}>
        <MediaTile
          generation={generation({ metadata: {
            vaultPath: 'generated/images/output.png',
            savedToVaultAt: '2026-08-27T00:00:00.000Z',
          } })}
          context="home"
          onOpen={view.onOpen}
        />
      </StudioPlaybackProvider>,
    )
    expect(screen.getByText('In vault')).toBeTruthy()
  })

  it('opens from click, Enter, and Space', () => {
    const { onOpen } = setup()
    const tile = screen.getByRole('button', { name: 'A bright horizon — open' })
    fireEvent.click(tile)
    fireEvent.keyDown(tile, { key: 'Enter' })
    fireEvent.keyDown(tile, { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(3)
  })

  it('requests deletion without opening the viewer', () => {
    const onRequestDelete = vi.fn()
    const { onOpen } = setup({
      actions: { remove: vi.fn().mockResolvedValue(undefined) },
      onRequestDelete,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onRequestDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'gen-1' }))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('uses the whole tile as a selection target in select mode', () => {
    const onOpen = vi.fn()
    const onToggleSelect = vi.fn()
    setup({ context: 'history', selectMode: true, onOpen, onToggleSelect })
    fireEvent.click(screen.getByRole('button', { name: 'A bright horizon — open' }))
    expect(onToggleSelect).toHaveBeenCalledWith('gen-1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('toggles selection from the history circle and reflects aria-pressed', () => {
    function Harness({ children }: { children?: ReactNode }) {
      const [selected, setSelected] = useState(false)
      return (
        <StudioPlaybackProvider createAudioElement={() => new FakeAudio()}>
          <MediaTile
            generation={generation()}
            context="history"
            onOpen={() => {}}
            selected={selected}
            onToggleSelect={() => setSelected((value) => !value)}
          />
          {children}
        </StudioPlaybackProvider>
      )
    }
    render(<Harness />)
    const circle = screen.getByRole('button', { name: 'Select this item' })
    expect(circle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(circle)
    expect(circle.getAttribute('aria-pressed')).toBe('true')
  })

  it('plays and pauses speech without opening the viewer', () => {
    const audio = new FakeAudio()
    const { onOpen } = setup({
      generation: generation({ type: 'speech', result: 'https://media.test/output.mp3' }),
    }, audio)
    const play = screen.getByRole('button', { name: 'Play A bright horizon' })
    fireEvent.click(play)
    expect(audio.play).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Pause A bright horizon' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pause A bright horizon' }))
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Play A bright horizon' })).toBeTruthy()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('saves a generation to a normalized vault path', async () => {
    const save = vi.fn().mockResolvedValue([{ generationId: 'gen-1', vaultPath: 'projects/art/output.png' }])
    const onSaved = vi.fn()
    setup({ actions: { save }, onSaved })
    fireEvent.click(screen.getByRole('button', { name: 'Save to vault' }))
    const input = screen.getByLabelText('Save 1 item to') as HTMLInputElement
    expect(input.value).toBe('generated/images')
    fireEvent.change(input, { target: { value: ' /projects//art/ ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      generations: [expect.objectContaining({ id: 'gen-1' })],
      path: 'projects/art',
    }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith([
      { generationId: 'gen-1', vaultPath: 'projects/art/output.png' },
    ]))
  })

  it('downloads through the anchor adapter without opening the viewer', () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const remove = vi.spyOn(HTMLAnchorElement.prototype, 'remove')
    const createElement = vi.spyOn(document, 'createElement')
    const { onOpen } = setup({ actions: { download: downloadGenerationsViaAnchor } })
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    vi.runAllTimers()
    expect(createElement).toHaveBeenCalledWith('a')
    const anchor = createElement.mock.results
      .map((result) => result.value)
      .find((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement)
    if (!anchor) throw new Error('expected an anchor element')
    expect(anchor.href).toBe('https://media.test/output.png')
    expect(anchor.download).toBe('image-gen-1')
    expect(click).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })
})
