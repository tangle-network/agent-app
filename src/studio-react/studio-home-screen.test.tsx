// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import type { Generation, MediaModelCatalogResponse } from '../studio'
import {
  StudioPlaybackProvider,
  type StudioAudioElementLike,
} from './studio-playback'
import { StudioToastProvider } from './studio-toasts'
import { StudioHomeScreen, type StudioHomeScreenProps } from './studio-home-screen'
import { useBatchNavigation } from './use-batch-navigation'

class FakeAudio implements StudioAudioElementLike {
  src = ''
  currentTime = 0
  duration = Number.NaN
  play = vi.fn<() => void>()
  pause = vi.fn<() => void>()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

const EMPTY_CATALOG: MediaModelCatalogResponse = {
  defaults: { image: '', video: '', speech: '', avatar: '', transcription: '' },
  models: { image: [], video: [], speech: [], avatar: [], transcription: [] },
}

function generation(id: string, metadata: Record<string, unknown> | null = null): Generation {
  return {
    id,
    type: 'image',
    prompt: `Prompt ${id}`,
    result: `https://media.test/${id}.png`,
    model: 'image-model',
    cost: null,
    createdAt: null,
    metadata,
  }
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <StudioToastProvider>
      <StudioPlaybackProvider createAudioElement={() => new FakeAudio()}>
        {children}
      </StudioPlaybackProvider>
    </StudioToastProvider>
  )
}

function mount(props: Partial<StudioHomeScreenProps> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.startsWith('/api/media-models')) {
      return { ok: true, json: async () => EMPTY_CATALOG } as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))

  const fullProps: StudioHomeScreenProps = {
    generations: [],
    onGenerated: vi.fn(),
    onOpenGeneration: vi.fn(),
    onOpenHistory: vi.fn(),
    workspaceId: 'workspace-1',
    ...props,
  }
  return { props: fullProps, ...render(<StudioHomeScreen {...fullProps} />, { wrapper: Providers }) }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('StudioHomeScreen', () => {
  it('renders the heading and composer and caps recent tiles at the default and configured limits', () => {
    const rows = Array.from({ length: 25 }, (_, index) => generation(String(index + 1)))
    const view = mount({ generations: rows })

    expect(screen.getByRole('heading', { name: 'What do you want to create?' })).toBeTruthy()
    expect(screen.getByLabelText('Prompt')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /— open$/ })).toHaveLength(20)

    view.rerender(<StudioHomeScreen {...view.props} recentLimit={5} />)
    expect(screen.getAllByRole('button', { name: /— open$/ })).toHaveLength(5)
  })

  it('opens history from the card-surface button', () => {
    const onOpenHistory = vi.fn()
    mount({ onOpenHistory })

    fireEvent.click(screen.getByRole('button', { name: 'View history' }))
    expect(onOpenHistory).toHaveBeenCalledOnce()
  })

  it('renders both empty-state copy lines when there is no media', () => {
    mount()

    expect(screen.getByText('Nothing generated yet.')).toBeTruthy()
    expect(screen.getByText('Whatever you make lands here first — it only reaches the vault when you save it.')).toBeTruthy()
  })

  it('opens a tile in the media viewer', () => {
    mount({ generations: [generation('viewer-row')] })

    fireEvent.click(screen.getByRole('button', { name: 'Prompt viewer-row — open' }))
    const dialog = screen.getByRole('dialog', { name: 'Media detail' })
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText('Prompt viewer-row')).toBeTruthy()
  })

  it('confirms tile deletion, hides the row immediately, and offers Undo', () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    mount({ generations: [generation('delete-row')], actions: { remove } })

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Delete 1 item?' })
    expect(dialog).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('button', { name: 'Prompt delete-row — open' })).toBeNull()
    expect(screen.getByText('Deleted 1 item')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('useBatchNavigation', () => {
  it('opens a four-row batch once and ignores keys seeded from initial generations', () => {
    const onOpenGeneration = vi.fn()
    const seeded = generation('seeded-row', { batchId: 'seeded-batch' })
    const { result } = renderHook(
      () => useBatchNavigation({ seed: [seeded], onOpenGeneration }),
    )
    const batch = Array.from(
      { length: 4 },
      (_, index) => generation(`batch-row-${index}`, { batchId: 'new-batch' }),
    )

    act(() => {
      result.current(seeded)
      batch.forEach(result.current)
    })

    expect(onOpenGeneration).toHaveBeenCalledOnce()
    expect(onOpenGeneration).toHaveBeenCalledWith('new-batch', batch[0])
  })
})
