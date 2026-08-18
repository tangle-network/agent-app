/**
 * `useDictation` — the capture half of composer dictation.
 *
 * Dictation splits at a clean seam: the browser owns capture (`getUserMedia` +
 * `MediaRecorder`), the host owns what the audio MEANS (transcription —
 * `sequences-react`'s Whisper provider — or a straight upload). This hook is
 * the capture half and nothing else: it asks for the mic, records, ticks whole
 * seconds while it does, and hands the assembled `Blob` to the host's
 * `onDictate`. A hook rather than composer-private code, because a host whose
 * composer is fully composed (hotkey, push-to-talk) needs the same capture
 * without re-deriving it.
 *
 * The rules the implementation exists to hold:
 *
 *  - **Unsupported is a render signal, not an exception.** A browser without
 *    `MediaRecorder`/`getUserMedia` gets `supported: false`, and the composer
 *    renders no dead button. `start()` stays a no-op rather than throwing, so
 *    a host that wired it to a hotkey cannot crash on such a browser.
 *  - **The mic is released the moment recording ends.** Tracks are stopped in
 *    every exit — stop, error, cancel-during-prompt, unmount. A red dot the
 *    browser keeps showing after the composer says "idle" is the failure this
 *    is written against.
 *  - **A denied prompt is a message, not a crash.** `NotAllowedError` and a
 *    missing device are reported through `onError` as words the composer can
 *    show; the hook returns to idle.
 *  - **Unmount discards.** A composer that unmounts mid-recording delivers
 *    nothing: the host it would have called has moved on, and an arriving
 *    transcript would land in a conversation the user left.
 *  - **Duration is measured, not counted.** `durationSeconds` comes off the
 *    clock at stop; the one-second ticker drives only the visible elapsed
 *    display, so a throttled timer never falsifies the delivered figure.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

/** The audio a finished recording hands to the host. */
export interface DictationAudio {
  /** The assembled recording, typed with the MIME the recorder actually used. */
  readonly blob: Blob
  /** `blob.type`, surfaced so a host can switch on it without touching the blob. */
  readonly mimeType: string
  /** Clock-measured whole seconds between start and stop. */
  readonly durationSeconds: number
}

export interface UseDictationOptions {
  /** The host callback: receive the recording. Transcription is the host's. */
  onDictate: (audio: DictationAudio) => void
  /** Capture failures in words ("Microphone access was denied…"). Optional —
   *  the composer shows its own notice either way; this is for hosts that log. */
  onError?: (message: string) => void
}

export interface DictationControls {
  /** Whether this browser can record at all. When false, render no affordance. */
  readonly supported: boolean
  readonly recording: boolean
  /** Whole seconds since the current recording started; drives the indicator. */
  readonly elapsedSeconds: number
  /** Ask for the mic and start. A no-op while a recording or a prompt is open. */
  readonly start: () => void
  /** Stop and deliver. Cancels a still-pending permission prompt instead. */
  readonly stop: () => void
}

/** Preference order: opus-in-webm first, Safari's mp4 last, UA default if none. */
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const

/** The mime to ask the recorder for, or `undefined` to take the UA default. */
export function pickDictationMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return undefined
  }
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return undefined
}

/** Capture support is a property of the browser, so it is read once per mount. */
function detectDictationSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  )
}

/** The failure as a sentence. The denied prompt is the common case and the one
 *  whose generic name ("NotAllowedError") says nothing to a reader. */
export function dictationErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Microphone access was denied — allow it in the browser to dictate.'
    if (error.name === 'NotFoundError') return 'No microphone found on this device.'
  }
  return 'Could not start recording.'
}

/** `0:00`, `0:09`, `1:05`, `60:00` — minutes unbounded, seconds always two digits. */
export function formatDictationElapsed(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** One capture's mutable internals, kept in a ref: they move with recorder
 *  events, not with renders. */
interface DictationSession {
  readonly stream: MediaStream
  readonly recorder: MediaRecorder
  readonly chunks: Blob[]
  readonly mimeType: string
  readonly startedAt: number
  /** Set when the capture must deliver nothing (unmount, recorder failure). */
  cancelled: boolean
}

/** Release the mic. Idempotent — every exit path ends here. */
function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

export function useDictation({ onDictate, onError }: UseDictationOptions): DictationControls {
  const [supported] = useState(detectDictationSupport)
  const [recording, setRecording] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const sessionRef = useRef<DictationSession | null>(null)
  /** Cancels a start whose getUserMedia has not resolved yet. */
  const cancelPendingStartRef = useRef<(() => void) | null>(null)
  // The recorder's event handlers fire outside React's render, so they read the
  // LATEST callbacks — a re-rendered host must not have its audio delivered to
  // the props the recording started with.
  const callbacksRef = useRef({ onDictate, onError })
  callbacksRef.current = { onDictate, onError }

  // The visible elapsed ticker. Follows `recording`; reset on each start so a
  // reused composer never opens at the previous capture's stale count.
  useEffect(() => {
    if (!recording) return
    setElapsedSeconds(0)
    const id = setInterval(() => setElapsedSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [recording])

  /** End the session: release the mic, reset state. Delivery is onstop's job. */
  const teardown = useCallback((cancelled: boolean) => {
    const session = sessionRef.current
    if (session === null) return
    session.cancelled = session.cancelled || cancelled
    sessionRef.current = null
    releaseStream(session.stream)
    setRecording(false)
  }, [])

  const stop = useCallback(() => {
    // A stop while the permission prompt is still open cancels the start: when
    // the stream arrives it is released unused, and nothing ever records.
    cancelPendingStartRef.current?.()
    cancelPendingStartRef.current = null
    const session = sessionRef.current
    if (session === null || session.cancelled) return
    // stop() flushes the buffered chunk (dataavailable) and THEN fires stop —
    // the blob is assembled in onstop, so a stop mid-chunk loses nothing.
    if (session.recorder.state !== 'inactive') session.recorder.stop()
  }, [])

  const start = useCallback(() => {
    if (!supported) return
    if (sessionRef.current !== null || cancelPendingStartRef.current !== null) return

    let pendingCancelled = false
    cancelPendingStartRef.current = () => {
      pendingCancelled = true
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        cancelPendingStartRef.current = null
        if (pendingCancelled) {
          releaseStream(stream)
          return
        }
        const mimeType = pickDictationMimeType()
        const recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType })
        const session: DictationSession = {
          stream,
          recorder,
          chunks: [],
          mimeType: recorder.mimeType || mimeType || '',
          startedAt: Date.now(),
          cancelled: false,
        }
        sessionRef.current = session

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) session.chunks.push(event.data)
        }

        recorder.onstop = () => {
          teardown(session.cancelled)
          if (session.cancelled) return
          const blob = new Blob(session.chunks, { type: session.mimeType })
          if (blob.size === 0) {
            // A tap on/off can produce no bytes at all. Handing the host a
            // 0-byte blob reads as a recording that happened; it did not.
            callbacksRef.current.onError?.('Nothing was recorded.')
            return
          }
          const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000))
          callbacksRef.current.onDictate({ blob, mimeType: session.mimeType, durationSeconds })
        }

        recorder.onerror = () => {
          // The capture is dead; what matters is that the mic is released and
          // the hook is not wedged — the next start builds a fresh session.
          teardown(true)
          callbacksRef.current.onError?.('Recording stopped unexpectedly.')
        }

        recorder.start()
        setRecording(true)
      },
      (error: unknown) => {
        cancelPendingStartRef.current = null
        if (pendingCancelled) return
        callbacksRef.current.onError?.(dictationErrorMessage(error))
      },
    )
  }, [supported, teardown])

  // Unmount mid-recording discards the capture: mark it cancelled so onstop
  // delivers nothing, then stop the recorder to flush its events, and release
  // the mic whether or not those events ever fire.
  useEffect(
    () => () => {
      cancelPendingStartRef.current?.()
      cancelPendingStartRef.current = null
      const session = sessionRef.current
      if (session === null) return
      session.cancelled = true
      sessionRef.current = null
      try {
        if (session.recorder.state !== 'inactive') session.recorder.stop()
      } finally {
        releaseStream(session.stream)
      }
    },
    [],
  )

  return { supported, recording, elapsedSeconds, start, stop }
}
