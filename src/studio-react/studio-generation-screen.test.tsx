// @vitest-environment jsdom
/**
 * The generation screen's contract is that the batch it shows is HONEST while it
 * is still running: one skeleton per slot that has not landed, a busy grid, and
 * a live line saying how many are coming — then the same slots carrying tiles.
 * The other half is the dock: it measures itself, because everything above it
 * has to clear a band whose height depends on the composer's own content.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type {
  Generation,
  MediaModelCatalogResponse,
  MediaModelOption,
  GenerationType,
} from '../studio'
import { StudioGenerationScreen, type StudioGenerationScreenProps } from './studio-generation-screen'
import { type StudioAudioElementLike, StudioPlaybackProvider } from './studio-playback'
import { StudioToastProvider } from './studio-toasts'

class FakeAudio implements StudioAudioElementLike {
  src = ''
  currentTime = 0
  duration = 10
  play = vi.fn<() => void>()
  pause = vi.fn<() => void>()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

const PROMPT = 'A bright horizon over a still lake'

function row(index: number, overrides: Partial<Generation> = {}, metadata: Record<string, unknown> = {}): Generation {
  return {
    id: `gen-${index}`,
    type: 'image',
    prompt: PROMPT,
    result: null,
    model: 'gpt-image-2',
    cost: null,
    createdAt: null,
    metadata: { batchId: 'batch-1', outputIndex: index, generationStatus: 'pending', ...metadata },
    ...overrides,
  }
}

function settled(index: number): Generation {
  return row(index, { result: `https://media.test/${index}.png` }, { generationStatus: 'succeeded' })
}

function tree(props: Partial<StudioGenerationScreenProps>) {
  return (
    <StudioToastProvider>
      <StudioPlaybackProvider createAudioElement={() => new FakeAudio()}>
        <StudioGenerationScreen
          generations={props.generations ?? []}
          batchKey={props.batchKey ?? 'batch-1'}
          onGenerated={props.onGenerated ?? vi.fn()}
          onOpenGeneration={props.onOpenGeneration ?? vi.fn()}
          {...props}
        />
      </StudioPlaybackProvider>
    </StudioToastProvider>
  )
}

function renderScreen(props: Partial<StudioGenerationScreenProps> = {}) {
  const view = render(tree(props))
  return {
    ...view,
    root: view.container.firstElementChild as HTMLElement,
    grid: () => view.container.querySelector('[aria-busy]') as HTMLElement,
    skeletons: () => view.container.querySelectorAll('.studio-skeleton'),
    show: (next: Partial<StudioGenerationScreenProps>) => view.rerender(tree({ ...props, ...next })),
  }
}

/** jsdom has no ResizeObserver. This one reports a fixed height the moment it is
 *  asked to observe, which is the only thing the dock measurement reads. */
function stubResizeObserver(height: number) {
  class StubResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      const entry = { target, contentRect: { height } } as unknown as ResizeObserverEntry
      this.callback([entry], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
}

const EMPTY_LANES: Record<GenerationType, MediaModelOption[]> = {
  image: [], video: [], speech: [], avatar: [], transcription: [],
}

/** The composer's two endpoints, plus a deterministic request id so the batch
 *  key a dock submit produces is known to the test. */
function stubComposerBackend(serverGenerations: Generation[]) {
  const realCrypto = globalThis.crypto
  vi.stubGlobal('crypto', {
    randomUUID: () => 'batch-2',
    getRandomValues: (array: Uint8Array) => realCrypto.getRandomValues(array),
  })
  const catalog: MediaModelCatalogResponse = {
    defaults: { image: 'gpt-image-2', video: '', speech: '', avatar: '', transcription: '' },
    models: { ...EMPTY_LANES, image: [{ id: 'gpt-image-2', name: 'gpt-image-2', type: 'image', status: 'available' }] },
  }
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.startsWith('/api/media-models')) return { ok: true, json: async () => catalog } as unknown as Response
    if (url === '/api/generate') {
      return { ok: true, json: async () => ({ generations: serverGenerations }) } as unknown as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StudioGenerationScreen — a running batch', () => {
  it('draws one skeleton per unfinished slot, marks the grid busy, and says how many are coming', () => {
    const view = renderScreen({ generations: [row(0), row(1), row(2)] })

    expect(view.skeletons()).toHaveLength(3)
    expect(view.grid().getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Generating 3 results…')).not.toBeNull()
  })

  it('replaces skeletons with tiles as the slots land', () => {
    const view = renderScreen({ generations: [row(0), row(1), row(2)] })
    expect(view.container.querySelectorAll('img')).toHaveLength(0)

    view.show({ generations: [settled(0), settled(1), settled(2)] })

    expect(view.skeletons()).toHaveLength(0)
    expect(view.container.querySelectorAll('img')).toHaveLength(3)
    expect(view.grid().getAttribute('aria-busy')).toBe('false')
    expect(screen.queryByText(/^Generating/)).toBeNull()
  })

  it('lays a four-result batch out in two columns', () => {
    const view = renderScreen({ generations: [settled(0), settled(1), settled(2), settled(3)] })

    expect(view.grid().style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))')
  })
})

describe('StudioGenerationScreen — the dock', () => {
  it('publishes the measured dock height on the screen root', async () => {
    stubResizeObserver(190)
    const view = renderScreen({ generations: [settled(0)] })

    await waitFor(() => expect(view.root.style.getPropertyValue('--studio-dock-h')).toBe('190px'))
  })

  it('reports a submit that starts a new batch once, however many rows it produces', async () => {
    stubComposerBackend([
      row(0, { id: 'srv-1', result: 'https://media.test/new.png' }, { batchId: 'batch-2', generationStatus: 'succeeded' }),
    ])
    const onGenerated = vi.fn()
    const onOpenGeneration = vi.fn()
    renderScreen({ generations: [settled(0)], workspaceId: 'ws-1', onGenerated, onOpenGeneration })
    await screen.findByRole('button', { name: 'Model: gpt-image-2' })

    const textarea = screen.getByLabelText('Prompt')
    fireEvent.change(textarea, { target: { value: 'A second idea' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    // The optimistic row opens the new batch; the server row for the SAME batch
    // must not navigate a second time.
    await waitFor(() => expect(onGenerated.mock.calls.length).toBeGreaterThan(1))
    expect(onOpenGeneration).toHaveBeenCalledTimes(1)
    expect(onOpenGeneration.mock.calls[0]?.[0]).toBe('batch-2')
  })
})

describe('StudioGenerationScreen — header and deletion', () => {
  it('shows the batch prompt in full on the chip', () => {
    renderScreen({ generations: [settled(0)] })

    expect(screen.getByTitle(PROMPT).textContent).toBe(PROMPT)
  })

  it('empties the screen once the last row is confirmed deleted', async () => {
    const remove = vi.fn(async () => {})
    renderScreen({ generations: [settled(0)], actions: { remove } })

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(screen.getByText('Nothing left from this generation.')).not.toBeNull()
    expect(screen.getByText('Send another prompt below to start a new one.')).not.toBeNull()
  })
})
