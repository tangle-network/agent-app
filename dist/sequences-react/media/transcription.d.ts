/**
 * Whisper transcription behind the `TranscriptionProvider` seam, powered by
 * the OPTIONAL peer `@huggingface/transformers`. The peer is loaded with a
 * dynamic variable-specifier import inside `transcribe()` so bundlers leave
 * it external and apps that never transcribe never pay for it. `available`
 * is the sync UI affordance signal; `transcribe()` re-verifies with the real
 * import and is the source of truth.
 */
import type { TranscriptionProvider, TranscriptionSegment } from '../contracts';
import type { AudioBufferLike } from './waveform';
/** Provide the default Whisper model identifier for ONNX community large v3 turbo */
export declare const DEFAULT_WHISPER_MODEL = "onnx-community/whisper-large-v3-turbo";
interface WhisperChunk {
    text: string;
    timestamp: [number, number | null];
}
/** Define the structure for transcribed text output with optional segmented chunks */
export interface WhisperOutput {
    text: string;
    chunks?: WhisperChunk[];
}
/** Mean-mixdown to mono. Single-channel buffers return the live channel data
 *  without copying — callers must treat the result as read-only. */
export declare function mixdownToMono(buffer: AudioBufferLike): Float32Array;
/** Map whisper chunk output to contract segments. A `null` end timestamp is
 *  whisper's "ran past the end of the audio" sentinel on the final chunk and
 *  resolves to the audio duration. */
export declare function mapWhisperOutput(output: WhisperOutput | WhisperOutput[], durationSeconds: number, mediaUrl: string): TranscriptionSegment[];
/** Create a Whisper-based transcription provider with optional model configuration */
export declare function createWhisperTranscriptionProvider(opts?: {
    model?: string;
}): TranscriptionProvider;
export {};
