/**
 * Waveform rendering for audio clips: bucketed max-abs peaks computed once
 * per (media, zoom bucket count) and painted as mirrored bars around the
 * track lane's midline. `computeWaveform` is pure so peak math is testable
 * without Web Audio; `loadWaveform` is the browser edge that decodes real
 * media into it.
 */
import type { WaveformData } from '../contracts';
/** Structural slice of Web Audio's AudioBuffer so peak math runs on synthetic
 *  fixtures in tests and on real decoded buffers in the browser. */
export interface AudioBufferLike {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    duration: number;
    getChannelData(channel: number): Float32Array;
}
/** One max-abs peak per bucket, taken across all channels. `peaks[b]` is the
 *  loudest absolute sample in bucket `b`; rendering mirrors it around the
 *  midline, which is what the contract's "peak pair" denotes. Buckets past
 *  the end of short audio hold 0. */
export declare function computeWaveform(buffer: AudioBufferLike, bucketCount: number): WaveformData;
/** Fetch + decode `mediaUrl` and bucket it. Pass `ctx` to reuse a shared
 *  AudioContext; otherwise one is created and closed around the decode. */
export declare function loadWaveform(mediaUrl: string, bucketCount: number, ctx?: AudioContext): Promise<WaveformData>;
/** Paint mirrored peak bars centered on the rect's midline. Silent buckets
 *  still paint a 1px hairline so the lane reads as audio, not as empty;
 *  peaks beyond ±1.0 (hot masters) clip to the full lane height. */
export declare function drawWaveform(ctx: CanvasRenderingContext2D, data: WaveformData, rect: {
    x: number;
    y: number;
    width: number;
    height: number;
}, color: string): void;
