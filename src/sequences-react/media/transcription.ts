/**
 * Whisper transcription behind the `TranscriptionProvider` seam, powered by
 * the OPTIONAL peer `@huggingface/transformers`. The peer is loaded with a
 * dynamic variable-specifier import inside `transcribe()` so bundlers leave
 * it external and apps that never transcribe never pay for it. `available`
 * is the sync UI affordance signal; `transcribe()` re-verifies with the real
 * import and is the source of truth.
 */

import type { TranscriptionProvider, TranscriptionSegment } from '../contracts'
import type { AudioBufferLike } from './waveform'

/** Provide the default Whisper model identifier for ONNX community large v3 turbo */
export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-large-v3-turbo'

/** Whisper models are trained on 16 kHz mono — decoding through a 16 kHz
 *  OfflineAudioContext resamples any source rate in one step. */
const WHISPER_SAMPLE_RATE = 16_000

const TRANSCRIPTION_PEER = '@huggingface/transformers'
const PEER_MISSING_MESSAGE = 'transcription requires optional peer @huggingface/transformers'

interface WhisperChunk {
  text: string
  timestamp: [number, number | null]
}

/** Define the structure for transcribed text output with optional segmented chunks */
export interface WhisperOutput {
  text: string
  chunks?: WhisperChunk[]
}

type WhisperPipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<WhisperOutput | WhisperOutput[]>

interface TransformersProgressEvent {
  status: string
  progress?: number
}

interface TransformersModule {
  pipeline(
    task: 'automatic-speech-recognition',
    model: string,
    options?: Record<string, unknown>,
  ): Promise<WhisperPipeline>
}

/** Mean-mixdown to mono. Single-channel buffers return the live channel data
 *  without copying — callers must treat the result as read-only. */
export function mixdownToMono(buffer: AudioBufferLike): Float32Array {
  if (buffer.numberOfChannels < 1) throw new Error('audio buffer has no channels — cannot mix down')
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    if (data.length !== buffer.length) {
      throw new Error(`channel ${channel} has ${data.length} samples, expected ${buffer.length}`)
    }
    for (let i = 0; i < data.length; i++) {
      // in range by the length assertion above; casts silence noUncheckedIndexedAccess
      mono[i] = (mono[i] as number) + (data[i] as number)
    }
  }
  const scale = 1 / buffer.numberOfChannels
  for (let i = 0; i < mono.length; i++) {
    mono[i] = (mono[i] as number) * scale
  }
  return mono
}

/** Map whisper chunk output to contract segments. A `null` end timestamp is
 *  whisper's "ran past the end of the audio" sentinel on the final chunk and
 *  resolves to the audio duration. */
export function mapWhisperOutput(
  output: WhisperOutput | WhisperOutput[],
  durationSeconds: number,
  mediaUrl: string,
): TranscriptionSegment[] {
  const first = Array.isArray(output) ? output[0] : output
  if (first === undefined) throw new Error(`whisper produced no output for ${mediaUrl}`)
  const chunks = first.chunks
  if (chunks === undefined || chunks.length === 0) {
    const text = first.text.trim()
    return text.length === 0 ? [] : [{ text, startSeconds: 0, endSeconds: durationSeconds }]
  }
  const segments: TranscriptionSegment[] = []
  for (const chunk of chunks) {
    const text = chunk.text.trim()
    if (text.length === 0) continue
    const [start, end] = chunk.timestamp
    if (!Number.isFinite(start)) {
      throw new Error(`whisper returned a non-numeric start timestamp for "${text}" in ${mediaUrl}`)
    }
    segments.push({ text, startSeconds: start, endSeconds: end === null ? durationSeconds : end })
  }
  return segments
}

async function loadTransformers(): Promise<TransformersModule> {
  try {
    // Variable specifier + ignore pragmas keep bundlers from statically
    // resolving an optional peer that may not be installed.
    return (await import(/* @vite-ignore */ /* webpackIgnore: true */ TRANSCRIPTION_PEER)) as TransformersModule
  } catch (error) {
    throw new Error(PEER_MISSING_MESSAGE, { cause: error })
  }
}

async function fetchMonoAudio(mediaUrl: string): Promise<{ samples: Float32Array; durationSeconds: number }> {
  const response = await fetch(mediaUrl)
  if (!response.ok) {
    throw new Error(`failed to fetch media for transcription: ${response.status} ${response.statusText} from ${mediaUrl}`)
  }
  const bytes = await response.arrayBuffer()
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('transcription requires Web Audio (OfflineAudioContext) — call transcribe() from a browser')
  }
  // decodeAudioData resamples to the context rate per the Web Audio spec, so
  // a 16 kHz context yields whisper-ready samples from any source rate.
  const context = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE)
  const decoded = await context.decodeAudioData(bytes)
  return { samples: mixdownToMono(decoded), durationSeconds: decoded.duration }
}

/** Create a Whisper-based transcription provider with optional model configuration */
export function createWhisperTranscriptionProvider(opts?: { model?: string }): TranscriptionProvider {
  const model = opts?.model ?? DEFAULT_WHISPER_MODEL
  let availability: boolean | null = null
  let pipelinePromise: Promise<WhisperPipeline> | null = null

  const probeAvailability = (): boolean => {
    if (availability !== null) return availability
    const resolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve
    if (typeof resolve !== 'function') {
      // No sync resolver in this runtime — report unavailable rather than
      // guess; transcribe() still attempts the real import either way.
      availability = false
      return availability
    }
    try {
      resolve.call(import.meta, TRANSCRIPTION_PEER)
      availability = true
    } catch {
      availability = false
    }
    return availability
  }

  const getPipeline = (
    transformers: TransformersModule,
    onProgress?: (fraction: number) => void,
  ): Promise<WhisperPipeline> => {
    if (pipelinePromise === null) {
      const device = typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm'
      pipelinePromise = transformers.pipeline('automatic-speech-recognition', model, {
        dtype: 'q4',
        device,
        // Model download progress only — it dwarfs inference time on first
        // use, and only the first transcribe ever sees a download.
        progress_callback: (event: TransformersProgressEvent) => {
          if (event.status === 'progress' && typeof event.progress === 'number' && onProgress !== undefined) {
            onProgress(Math.min(1, Math.max(0, event.progress / 100)))
          }
        },
      })
      // A failed load must not poison the cache — the next transcribe retries.
      pipelinePromise.catch(() => {
        pipelinePromise = null
      })
    }
    return pipelinePromise
  }

  return {
    get available() {
      return probeAvailability()
    },
    async transcribe(mediaUrl, transcribeOpts) {
      const transformers = await loadTransformers()
      // A successful import is ground truth and overrides a false probe.
      availability = true
      const audio = await fetchMonoAudio(mediaUrl)
      const transcriber = await getPipeline(transformers, transcribeOpts?.onProgress)
      const options: Record<string, unknown> = {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      }
      if (transcribeOpts?.language !== undefined) options.language = transcribeOpts.language
      const output = await transcriber(audio.samples, options)
      const segments = mapWhisperOutput(output, audio.durationSeconds, mediaUrl)
      transcribeOpts?.onProgress?.(1)
      return segments
    },
  }
}
