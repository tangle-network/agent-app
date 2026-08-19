// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

import type { Generation } from '../studio/generation'
import type {
  FetchGenerationsPage,
  GenerationPage,
  GenerationPageQuery,
  StudioMediaActions,
} from '../studio/ports'
import { type StudioAudioElementLike, StudioPlaybackProvider } from './studio-playback'
import { StudioToastProvider } from './studio-toasts'
import { StudioHistoryScreen, type StudioHistoryScreenProps } from './studio-history-screen'

class FakeAudio implements StudioAudioElementLike {
  src = ''
  currentTime = 0
  duration = 10
  play = vi.fn<() => void>()
  pause = vi.fn<() => void>()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

/** The sentinel observer, driven by hand: jsdom never intersects anything. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  /** Report every observed element as on-screen. */
  intersect() {
    const entries = [...this.targets].map((target) => ({ isIntersecting: true, target }))
    this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}

function generation(id: string, overrides: Partial<Generation> = {}): Generation {
  return {
    id,
    type: 'image',
    prompt: `prompt ${id}`,
    result: `https://media.test/${id}.png`,
    model: 'image-model',
    cost: null,
    createdAt: null,
    metadata: null,
    ...overrides,
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  // The screen only ever awaits these through the hook, which catches; an
  // unhandled rejection here would still fail the run.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** A `fetchPage` whose every call is resolved (or rejected) by the test. */
function controlledFetch() {
  const calls: Array<{ query: GenerationPageQuery; result: Deferred<GenerationPage> }> = []
  const fetchPage: FetchGenerationsPage = vi.fn((query) => {
    const result = deferred<GenerationPage>()
    calls.push({ query, result })
    return result.promise
  })
  return { fetchPage, calls }
}

function wrap(node: ReactElement, audio = new FakeAudio()) {
  return (
    <StudioToastProvider>
      <StudioPlaybackProvider createAudioElement={() => audio}>
        {node}
      </StudioPlaybackProvider>
    </StudioToastProvider>
  )
}

function setup(props: Partial<StudioHistoryScreenProps> = {}) {
  const { fetchPage, calls } = controlledFetch()
  const onBack = vi.fn()
  const audio = new FakeAudio()
  const view = render(wrap(
    <StudioHistoryScreen fetchPage={props.fetchPage ?? fetchPage} onBack={onBack} {...props} />,
    audio,
  ))
  return { ...view, audio, calls, fetchPage: props.fetchPage ?? fetchPage, onBack }
}

/** Resolve the pending fetch at `index` and let React commit the result. */
async function resolvePage(
  calls: Array<{ query: GenerationPageQuery; result: Deferred<GenerationPage> }>,
  index: number,
  page: GenerationPage,
) {
  await act(async () => {
    calls[index]!.result.resolve(page)
    await calls[index]!.result.promise
  })
}

const tileTitles = () =>
  screen.queryAllByRole('button', { name: /— open$/ }).map((tile) => tile.getAttribute('aria-label'))

const selectCircles = () => screen.getAllByRole('button', { name: 'Select this item' })

/** The type pill's menu renders synchronously, so this stays fake-timer safe:
 *  RTL's `findBy*` polls on a timer the debounce tests have frozen. */
function chooseMediaType(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Filter by media type' }))
  const menu = screen.getByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitemradio', { name: label }))
}

/** The batch pills, scoped: a tile carries its own Download/Delete buttons. */
const batchButton = (name: string) =>
  within(screen.getByRole('toolbar', { name: 'Selection actions' })).getByRole('button', { name }) as HTMLButtonElement

const typePillLabel = () => screen.getByRole('button', { name: 'Filter by media type' }).textContent

beforeEach(() => {
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StudioHistoryScreen', () => {
  it('loads the default view on mount and renders its tiles', async () => {
    const { calls } = setup()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.query).toMatchObject({ q: '', type: 'all', cursor: null })

    await resolvePage(calls, 0, { items: [generation('a'), generation('b')] })

    expect(tileTitles()).toEqual(['prompt a — open', 'prompt b — open'])
    expect(typePillLabel()).toContain('All media')
  })

  it('debounces the search box into exactly one fetch carrying the final term', async () => {
    vi.useFakeTimers()
    const { calls } = setup({ searchDebounceMs: 250 })
    await resolvePage(calls, 0, { items: [generation('a')] })

    const input = screen.getByLabelText('Search prompts')
    fireEvent.change(input, { target: { value: 'b' } })
    fireEvent.change(input, { target: { value: 'bi' } })
    fireEvent.change(input, { target: { value: 'bird' } })

    act(() => { vi.advanceTimersByTime(249) })
    expect(calls).toHaveLength(1)

    act(() => { vi.advanceTimersByTime(1) })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.query).toMatchObject({ q: 'bird', type: 'all', cursor: null })
  })

  it('filters by media type and composes the filter with the search term', async () => {
    vi.useFakeTimers()
    const { calls } = setup({ searchDebounceMs: 250 })
    await resolvePage(calls, 0, { items: [generation('a')] })

    chooseMediaType('Images')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.query).toMatchObject({ q: '', type: 'image' })
    expect(typePillLabel()).toContain('Images')

    fireEvent.change(screen.getByLabelText('Search prompts'), { target: { value: 'gull' } })
    act(() => { vi.advanceTimersByTime(250) })

    expect(calls).toHaveLength(3)
    expect(calls[2]!.query).toMatchObject({ q: 'gull', type: 'image' })
  })

  it('swaps the bar for the select bar and disables the batch pills at zero', async () => {
    const actions: StudioMediaActions = { save: vi.fn(), remove: vi.fn() }
    const { calls } = setup({ actions })
    await resolvePage(calls, 0, { items: [generation('a'), generation('b')] })

    fireEvent.click(selectCircles()[0]!)

    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(screen.queryByLabelText('Search prompts')).toBeNull()
    for (const label of ['Download', 'Save to vault', 'Delete']) {
      expect(batchButton(label).disabled).toBe(false)
    }

    fireEvent.click(selectCircles()[0]!)

    expect(screen.getByText('0 selected')).toBeTruthy()
    for (const label of ['Download', 'Save to vault', 'Delete']) {
      expect(batchButton(label).disabled).toBe(true)
    }
  })

  it('downloads the whole selection in one call and leaves select mode', async () => {
    const download = vi.fn()
    const { calls } = setup({ actions: { download } })
    await resolvePage(calls, 0, { items: [generation('a'), generation('b')] })

    fireEvent.click(selectCircles()[0]!)
    fireEvent.click(selectCircles()[1]!)
    fireEvent.click(batchButton('Download'))

    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]![0].map((row: Generation) => row.id)).toEqual(['a', 'b'])
    expect(screen.queryByText(/selected$/)).toBeNull()
    expect(screen.getByLabelText('Search prompts')).toBeTruthy()
  })

  it('confirms a batch delete, hides the rows, offers Undo and leaves select mode', async () => {
    const remove = vi.fn(async () => {})
    const { calls } = setup({ actions: { remove } })
    await resolvePage(calls, 0, { items: [generation('a'), generation('b'), generation('c')] })

    fireEvent.click(selectCircles()[0]!)
    fireEvent.click(selectCircles()[1]!)
    fireEvent.click(batchButton('Delete'))

    expect((await screen.findByRole('alertdialog')).textContent).toContain('Delete 2 items?')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(tileTitles()).toEqual(['prompt c — open']))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    expect(screen.queryByText(/selected$/)).toBeNull()
  })

  it('offers Clear on a searched empty state and Clear restores the default view', async () => {
    vi.useFakeTimers()
    const { calls } = setup({ searchDebounceMs: 250 })
    await resolvePage(calls, 0, { items: [generation('a')] })

    chooseMediaType('Images')
    await resolvePage(calls, 1, { items: [generation('a')] })

    fireEvent.change(screen.getByLabelText('Search prompts'), { target: { value: 'zzz' } })
    act(() => { vi.advanceTimersByTime(250) })
    await resolvePage(calls, 2, { items: [] })

    expect(screen.getByText('No media matches “zzz”.')).toBeTruthy()
    expect(screen.getByText('Try a shorter word, or drop the type filter.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(calls).toHaveLength(4)
    expect(calls[3]!.query).toMatchObject({ q: '', type: 'all', cursor: null })
    expect(typePillLabel()).toContain('All media')
    expect((screen.getByLabelText('Search prompts') as HTMLInputElement).value).toBe('')
  })

  it('renders the error branch instead of the empty state, and Retry refetches', async () => {
    const { calls } = setup()

    await act(async () => {
      calls[0]!.result.reject(new Error('offline'))
      await calls[0]!.result.promise.catch(() => {})
    })

    expect(screen.getByText('Could not load media.')).toBeTruthy()
    expect(screen.queryByText('Your history is empty.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(calls).toHaveLength(2)
    expect(calls[1]!.query).toMatchObject({ q: '', type: 'all', cursor: null })
  })

  it('carries the cursor when the sentinel scrolls into view', async () => {
    const { calls } = setup()
    await resolvePage(calls, 0, { items: [generation('a')], nextCursor: 'page-2' })

    const observer = FakeIntersectionObserver.instances.at(-1)
    expect(observer).toBeTruthy()

    act(() => observer!.intersect())

    expect(calls).toHaveLength(2)
    expect(calls[1]!.query).toMatchObject({ q: '', type: 'all', cursor: 'page-2' })

    await resolvePage(calls, 1, { items: [generation('b')] })
    expect(tileTitles()).toEqual(['prompt a — open', 'prompt b — open'])
  })

  it('keeps loaded rows visible and offers inline Retry when load more fails', async () => {
    const { calls } = setup()
    await resolvePage(calls, 0, { items: [generation('a')], nextCursor: 'page-2' })
    act(() => FakeIntersectionObserver.instances.at(-1)!.intersect())

    await act(async () => {
      calls[1]!.result.reject(new Error('offline'))
      await calls[1]!.result.promise.catch(() => {})
    })

    expect(tileTitles()).toEqual(['prompt a — open'])
    expect(screen.getByText('Could not load more media.')).toBeTruthy()
    expect(screen.queryByText('Could not load media.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(calls).toHaveLength(3)
    expect(calls[2]!.query.cursor).toBe('page-2')
  })

  it('stops playback after a settled filter removes the playing row', async () => {
    const { audio, calls } = setup()
    await resolvePage(calls, 0, {
      items: [generation('speech-a', { type: 'speech', result: 'https://media.test/speech-a.mp3' })],
    })
    fireEvent.click(screen.getByRole('button', { name: 'Play prompt speech-a' }))
    expect(audio.play).toHaveBeenCalledOnce()

    chooseMediaType('Images')
    await resolvePage(calls, 1, { items: [] })

    expect(audio.pause).toHaveBeenCalled()
  })
})
