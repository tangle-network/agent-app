/**
 * rAF playback clock. The playhead is derived from a (start time, start
 * frame) anchor and `performance.now()` deltas — never from per-tick
 * increments — so dropped animation frames cannot accumulate drift.
 *
 * Browser-only at PLAY time, import-safe everywhere: `requestAnimationFrame`
 * and `performance` are resolved off `globalThis` when playback starts, never
 * at module load or construction, so server bundles that import the editor
 * engine do not crash.
 */
import type { PlaybackClock } from '../contracts';
/** Define configuration settings for playback clock including frames per second and total duration frames */
export interface PlaybackClockConfig {
    fps: number;
    durationFrames: number;
}
/** Create a playback clock that manages frame timing and playback state based on configuration */
export declare function createPlaybackClock(config: PlaybackClockConfig): PlaybackClock;
