// @vitest-environment jsdom
/**
 * The dictation capture seam, exercised against a fake MediaRecorder.
 *
 * jsdom has no microphone, no MediaRecorder and no `mediaDevices` — which is
 * exactly the environment the `supported` flag exists for, so the unsupported
 * case needs no stubbing at all. The supported cases stub the two globals the
 * hook reads (`navigator.mediaDevices.getUserMedia`, `MediaRecorder`) with
 * fakes that record what the hook did with them: which mime type was chosen,
 * whether the mic tracks were released, what the delivered blob contains.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import {
  formatDictationElapsed,
  useDictation,
  type DictationAudio,
  type UseDictationOptions,
} from './use-dictation'

// ── fakes ─────────────────────────────────────────────────────────────────

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []

  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: { error: Error }) => void) | null = null
  state: 'inactive' | 'recording' = 'inactive'
  readonly mimeType: string

  constructor(
    readonly stream: MediaStream,
    readonly options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? ''
    FakeMediaRecorder.instances.push(this)
  }

  start(): void {
    this.state = 'recording'
  }

  stop(): void {
    this.state = 'inactive'
    // The real recorder flushes its buffered chunk on stop, THEN fires stop.
    this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: this.mimeType }) })
    this.onstop?.()
  }

  /** The mime types this fake "browser" can record. */
  static isTypeSupported(type: string): boolean {
    return type.startsWith('audio/webm')
  }
}

function fakeStream(): { stream: MediaStream; trackStop: ReturnType<typeof vi.fn> } {
  const trackStop = vi.fn()
  const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream
  return { stream, trackStop }
}

function stubSupported(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
}

// ── probe ─────────────────────────────────────────────────────────────────

function Probe({ onDictate, onError }: UseDictationOptions) {
  const d = useDictation({ onDictate, onError })
  return (
    <div>
      <span data-testid="supported">{String(d.supported)}</span>
      <span data-testid="recording">{String(d.recording)}</span>
      <span data-testid="elapsed">{formatDictationElapsed(d.elapsedSeconds)}</span>
      <button onClick={d.start}>start</button>
      <button onClick={d.stop}>stop</button>
    </div>
  )
}

function text(id: string): string {
  return screen.getByTestId(id).textContent ?? ''
}

async function click(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label))
  })
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ── the seam ────────────────────────────────────────────────────────────────

describe('useDictation', () => {
  it('reports unsupported when the browser has no MediaRecorder and start is a harmless no-op', async () => {
    const onDictate = vi.fn()
    render(<Probe onDictate={onDictate} />)
    expect(text('supported')).toBe('false')

    // The composer hides the button on this flag — but a host that wired start
    // to a hotkey must not throw on a browser that cannot record.
    await click('start')
    expect(text('recording')).toBe('false')
    expect(onDictate).not.toHaveBeenCalled()
  })

  it('records, ticks whole seconds, and delivers the assembled blob on stop', async () => {
    vi.useFakeTimers()
    const { stream, trackStop } = fakeStream()
    const getUserMedia = vi.fn(async () => stream)
    stubSupported(getUserMedia)
    const onDictate = vi.fn()
    render(<Probe onDictate={onDictate} />)

    expect(text('supported')).toBe('true')
    await click('start')

    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true })
    expect(text('recording')).toBe('true')
    expect(text('elapsed')).toBe('0:00')
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(FakeMediaRecorder.instances[0]?.state).toBe('recording')

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(text('elapsed')).toBe('0:03')

    await click('stop')
    expect(text('recording')).toBe('false')
    expect(onDictate).toHaveBeenCalledTimes(1)
    const audio = onDictate.mock.calls[0]?.[0] as DictationAudio
    expect(audio.blob).toBeInstanceOf(Blob)
    expect(audio.blob.size).toBeGreaterThan(0)
    expect(audio.mimeType).toBe('audio/webm;codecs=opus')
    expect(audio.blob.type).toBe('audio/webm;codecs=opus')
    // Duration is measured off the clock, not counted off the ticker.
    expect(audio.durationSeconds).toBe(3)
    // The mic is released the moment the recording ends.
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('asks the recorder for the best mime type it supports', async () => {
    const { stream } = fakeStream()
    stubSupported(vi.fn(async () => stream))
    render(<Probe onDictate={vi.fn()} />)
    await click('start')
    expect(FakeMediaRecorder.instances[0]?.options?.mimeType).toBe('audio/webm;codecs=opus')
  })

  it('treats stop with no recording, and a second start while recording, as no-ops', async () => {
    const { stream } = fakeStream()
    const getUserMedia = vi.fn(async () => stream)
    stubSupported(getUserMedia)
    const onDictate = vi.fn()
    render(<Probe onDictate={onDictate} />)

    await click('stop')
    expect(onDictate).not.toHaveBeenCalled()

    await click('start')
    await click('start')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('reports a denied permission through onError and stays idle', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    stubSupported(vi.fn(async () => {
      throw denied
    }))
    const onDictate = vi.fn()
    const onError = vi.fn()
    render(<Probe onDictate={onDictate} onError={onError} />)

    await click('start')
    expect(text('recording')).toBe('false')
    expect(onDictate).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toContain('denied')
  })

  it('cancels a start that is still waiting on the permission prompt', async () => {
    const { stream, trackStop } = fakeStream()
    let resolveStream: ((stream: MediaStream) => void) | null = null
    stubSupported(vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolveStream = resolve
    })))
    const onDictate = vi.fn()
    render(<Probe onDictate={onDictate} />)

    await click('start')
    // The user changed their mind while the prompt was up.
    await click('stop')
    await act(async () => {
      resolveStream?.(stream)
    })

    expect(text('recording')).toBe('false')
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(onDictate).not.toHaveBeenCalled()
    // The stream arrived after the cancel: still released, never recorded.
    expect(trackStop).toHaveBeenCalledTimes(1)
  })

  it('discards the capture when the component unmounts mid-recording', async () => {
    const { stream, trackStop } = fakeStream()
    stubSupported(vi.fn(async () => stream))
    const onDictate = vi.fn()
    const { unmount } = render(<Probe onDictate={onDictate} />)

    await click('start')
    expect(text('recording')).toBe('true')

    unmount()
    // The mic is released and nobody is handed audio from a composer that is
    // gone — a delivery after unmount would land in a host that has moved on.
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(onDictate).not.toHaveBeenCalled()
  })

  it('recovers when the recorder itself fails mid-capture', async () => {
    const { stream, trackStop } = fakeStream()
    stubSupported(vi.fn(async () => stream))
    const onDictate = vi.fn()
    const onError = vi.fn()
    render(<Probe onDictate={onDictate} onError={onError} />)

    await click('start')
    const recorder = FakeMediaRecorder.instances[0]
    await act(async () => {
      recorder?.onerror?.({ error: new Error('encoder exploded') })
    })

    expect(text('recording')).toBe('false')
    expect(onDictate).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(trackStop).toHaveBeenCalledTimes(1)
    // A fresh start is possible after the failure — the hook is not wedged.
    await click('start')
    expect(text('recording')).toBe('true')
  })
})

describe('formatDictationElapsed', () => {
  it('renders whole seconds as m:ss', () => {
    expect(formatDictationElapsed(0)).toBe('0:00')
    expect(formatDictationElapsed(9)).toBe('0:09')
    expect(formatDictationElapsed(59)).toBe('0:59')
    expect(formatDictationElapsed(65)).toBe('1:05')
    expect(formatDictationElapsed(3600)).toBe('60:00')
  })
})
