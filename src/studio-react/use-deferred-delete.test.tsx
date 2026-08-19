// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Generation } from '../studio/generation'
import {
  StudioPlaybackProvider,
  useStudioPlayback,
  type StudioAudioElementLike,
} from './studio-playback'
import { StudioToastProvider } from './studio-toasts'
import {
  useDeferredDelete,
  type DeferredDelete,
  type UseDeferredDeleteOptions,
} from './use-deferred-delete'

let deferredDelete: DeferredDelete
let playback: ReturnType<typeof useStudioPlayback>

function generation(id: string, type = 'image'): Generation {
  return {
    id,
    type,
    prompt: `prompt ${id}`,
    result: `https://example.test/${id}`,
    model: 'studio-model',
    cost: null,
    createdAt: null,
    metadata: null,
  }
}

function audioElement(): StudioAudioElementLike {
  return {
    src: '',
    currentTime: 0,
    duration: 30,
    play: vi.fn(),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

function Probe({ options }: { options: UseDeferredDeleteOptions }) {
  deferredDelete = useDeferredDelete(options)
  playback = useStudioPlayback()
  return (
    <>
      <output aria-label="Pending ids">{[...deferredDelete.pendingIds].join(',')}</output>
      <output aria-label="Active id">{playback.activeId ?? 'none'}</output>
    </>
  )
}

function setup(options: Partial<UseDeferredDeleteOptions> = {}) {
  const remove = options.remove ?? vi.fn().mockResolvedValue(undefined)
  const fullOptions: UseDeferredDeleteOptions = { remove, undoWindowMs: 1000, ...options }
  const view = render(
    <StudioToastProvider>
      <StudioPlaybackProvider createAudioElement={audioElement}>
        <Probe options={fullOptions} />
      </StudioPlaybackProvider>
    </StudioToastProvider>,
  )
  return { remove, ...view }
}

async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

describe('useDeferredDelete', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hides a requested batch immediately without calling the server', () => {
    const { remove } = setup()

    act(() => deferredDelete.request([generation('a'), generation('b')]))

    expect(screen.getByLabelText('Pending ids').textContent).toBe('a,b')
    expect(remove).not.toHaveBeenCalled()
  })

  it('commits once after the undo window and keeps the ids pending', async () => {
    const onCommitted = vi.fn()
    const { remove } = setup({ onCommitted })
    const rows = [generation('a'), generation('b')]
    act(() => deferredDelete.request(rows))

    await advance(1000)

    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(['a', 'b'])
    expect(onCommitted).toHaveBeenCalledWith(['a', 'b'])
    expect(screen.getByLabelText('Pending ids').textContent).toBe('a,b')
  })

  it('undoes before the window without calling the server', () => {
    const { remove } = setup()
    act(() => deferredDelete.request([generation('a'), generation('b')]))

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(screen.getByLabelText('Pending ids').textContent).toBe('')
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText('Restored 2 items')).toBeTruthy()
  })

  it('commits early when the delete toast is dismissed', async () => {
    const { remove } = setup()
    act(() => deferredDelete.request([generation('a')]))

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await act(async () => {})

    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(['a'])
  })

  it('restores failed deletes and reports the failure', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('offline'))
    const onRestoreFailed = vi.fn()
    setup({ remove, onRestoreFailed })
    act(() => deferredDelete.request([generation('a'), generation('b')]))

    await advance(1000)

    expect(screen.getByLabelText('Pending ids').textContent).toBe('')
    expect(screen.getByText('Could not delete 2 items')).toBeTruthy()
    expect(onRestoreFailed).toHaveBeenCalledWith(['a', 'b'])
  })

  it('keeps concurrent batches independent', async () => {
    const { remove } = setup()
    act(() => deferredDelete.request([generation('a')]))
    await advance(200)
    act(() => deferredDelete.request([generation('b')]))

    const undoButtons = screen.getAllByRole('button', { name: 'Undo' })
    fireEvent.click(undoButtons[1]!)
    expect(screen.getByLabelText('Pending ids').textContent).toBe('a')

    await advance(800)
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(['a'])
  })

  it('flushes a live batch on unmount', () => {
    const { remove, unmount } = setup()
    act(() => deferredDelete.request([generation('a')]))

    unmount()

    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(['a'])
  })

  it('stops playback when the active audio is deleted', () => {
    setup()
    const audio = generation('audio', 'speech')
    act(() => playback.play(audio))
    expect(screen.getByLabelText('Active id').textContent).toBe('audio')

    act(() => deferredDelete.request([audio]))

    expect(screen.getByLabelText('Active id').textContent).toBe('none')
  })
})
