// @vitest-environment jsdom
/**
 * The composer's dictation affordance: opt-in, honest about support, and never
 * in the way of the input it serves.
 *
 * The microphone itself is faked (`use-dictation.test.tsx` covers the capture
 * seam against the same fakes); these tests are about the COMPOSER'S contract —
 * when the button exists, what it shows while recording, what the host
 * receives, and what a denied prompt looks like.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { ChatComposer } from './chat-composer'
import type { DictationAudio } from './use-dictation'

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
    this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: this.mimeType }) })
    this.onstop?.()
  }

  static isTypeSupported(type: string): boolean {
    return type.startsWith('audio/webm')
  }
}

function stubMic(opts?: { deny?: boolean }) {
  const getUserMedia = vi.fn(async () => {
    if (opts?.deny) throw new DOMException('Permission denied', 'NotAllowedError')
    return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
  })
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  return getUserMedia
}

beforeEach(() => {
  FakeMediaRecorder.instances = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ChatComposer dictation', () => {
  it('renders no mic button without an onDictate handler, even when the browser could record', () => {
    stubMic()
    render(<ChatComposer onSend={vi.fn()} />)
    expect(screen.queryByLabelText('Dictate message')).toBeNull()
  })

  it('renders no mic button when the browser cannot record, even with a handler', () => {
    // jsdom IS the unsupported case: no MediaRecorder, no mediaDevices.
    render(<ChatComposer onSend={vi.fn()} onDictate={vi.fn()} />)
    expect(screen.queryByLabelText('Dictate message')).toBeNull()
  })

  it('records on click, ticks elapsed seconds, and hands the host the audio on stop', async () => {
    vi.useFakeTimers()
    stubMic()
    const onDictate = vi.fn()
    render(<ChatComposer onSend={vi.fn()} onDictate={onDictate} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dictate message'))
    })
    // The affordance flips to its own stop control with the running elapsed.
    expect(screen.queryByLabelText('Dictate message')).toBeNull()
    expect(screen.getByLabelText('Stop dictation')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Recording')

    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByTestId('composer-dictate-elapsed').textContent).toBe('0:04')

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Stop dictation'))
    })
    expect(onDictate).toHaveBeenCalledTimes(1)
    const audio = onDictate.mock.calls[0]?.[0] as DictationAudio
    expect(audio.blob).toBeInstanceOf(Blob)
    expect(audio.blob.size).toBeGreaterThan(0)
    expect(audio.mimeType).toBe('audio/webm;codecs=opus')
    expect(audio.durationSeconds).toBe(4)
    // Back to idle: the mic returns, the indicator leaves.
    expect(screen.getByLabelText('Dictate message')).toBeTruthy()
    expect(screen.queryByTestId('composer-dictate-elapsed')).toBeNull()
  })

  it('shows an inline notice and reports when the mic is denied', async () => {
    stubMic({ deny: true })
    const onDictate = vi.fn()
    const onDictateError = vi.fn()
    render(<ChatComposer onSend={vi.fn()} onDictate={onDictate} onDictateError={onDictateError} />)

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dictate message'))
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Microphone access was denied')
    expect(onDictateError).toHaveBeenCalledTimes(1)
    expect(onDictate).not.toHaveBeenCalled()

    // The notice is dismissible, and dismissing it does not remove the affordance.
    fireEvent.click(screen.getByLabelText('Dismiss dictation error'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Dictate message')).toBeTruthy()
  })

  it('disables the mic with the composer, but never strands a recording', async () => {
    stubMic()
    const { rerender } = render(<ChatComposer onSend={vi.fn()} onDictate={vi.fn()} disabled />)
    expect((screen.getByLabelText('Dictate message') as HTMLButtonElement).disabled).toBe(true)

    rerender(<ChatComposer onSend={vi.fn()} onDictate={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Dictate message'))
    })
    // `disabled` arriving mid-recording must not disable the stop control —
    // that would strand the capture with the mic held open.
    rerender(<ChatComposer onSend={vi.fn()} onDictate={vi.fn()} disabled />)
    expect((screen.getByLabelText('Stop dictation') as HTMLButtonElement).disabled).toBe(false)
  })
})
