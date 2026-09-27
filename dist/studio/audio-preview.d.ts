/** A deterministic waveform bar used when decoded audio is unavailable. */
export interface WaveformBar {
    /** 7–100, % of tile height. */
    heightPct: number;
    opacity: number;
}
export declare const GRID_WAVEFORM_BARS = 26;
export declare const WIDE_WAVEFORM_BARS = 72;
/** Hash a string with FNV-1a into an unsigned 32-bit seed. */
export declare function hashSeed(value: string): number;
/** Build stable pseudo-waveform bars for a media preview. */
export declare function previewWaveformBars(seed: string, count: number): readonly WaveformBar[];
