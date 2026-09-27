/**
 * Baseline frame pipeline behind the `VideoFrameProvider` seam: an off-DOM
 * HTMLVideoElement pool for video URLs and an HTMLImageElement pool for
 * stills, merged by a per-URL kind dispatcher so the editor canvas never
 * cares which kind a clip's media is. A WebCodecs implementation can replace
 * this wholesale behind the same seam.
 *
 * Server-safe at import time, browser-only at call time: nothing touches
 * `document` or `fetch` until a provider method runs.
 */
import type { VideoFrameProvider } from '../contracts';
/** Define the default maximum number of media elements allowed in a collection */
export declare const DEFAULT_MAX_MEDIA_ELEMENTS = 4;
/** Half a frame at 30fps. Seeks closer than this repaint the decoder's
 *  current frame instead of forcing a redundant seek. */
export declare const SEEK_TOLERANCE_SECONDS: number;
/** A seek that hasn't fired `seeked` after this long is a decode failure —
 *  the draw REJECTS rather than painting whatever frame happens to be up. */
export declare const SEEK_TIMEOUT_MS = 5000;
/** Define a rectangular frame with position and size properties x, y, width, and height */
export interface FrameRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
/** Object-fit 'contain' placement: preserve aspect ratio, fit entirely inside
 *  `dest`, center the residual space. Callers own clearing the letterbox
 *  margins — this paints only the fitted region. */
export declare function containFitRect(source: {
    width: number;
    height: number;
}, dest: FrameRect): FrameRect;
/** Determine if seeking is required based on the difference between current and target times */
export declare function needsSeek(currentTimeSeconds: number, targetSeconds: number): boolean;
/** Manage a leased element from a pool and release it to enable LRU eviction */
export interface PooledElementLease<T> {
    element: T;
    /** Unpins the element; idle elements become LRU-evictable. Idempotent. */
    release(): void;
}
/** Manage a pool of media elements to acquire, check, count, and dispose resources efficiently */
export interface MediaElementPool<T> {
    acquire(url: string): PooledElementLease<T>;
    has(url: string): boolean;
    size(): number;
    dispose(): void;
}
/** LRU pool of media elements keyed by URL. Entries pinned by an outstanding
 *  lease are never evicted — a draw in flight must keep its element — so the
 *  pool can temporarily exceed `maxElements` under concurrent draws and
 *  shrinks back as leases release. */
export declare function createMediaElementPool<T>(opts: {
    maxElements: number;
    create(url: string): T;
    destroy(element: T, url: string): void;
}): MediaElementPool<T>;
/** Extension-based kind classification; 'unknown' defers to a HEAD
 *  content-type probe at draw time. */
export declare function classifyMediaUrl(url: string): 'video' | 'image' | 'unknown';
/** Stills behind the same `VideoFrameProvider` seam — `sourceSeconds` is
 *  validated for contract parity but does not affect the painted pixels. */
export declare function createImageFrameProvider(opts?: {
    maxElements?: number;
}): VideoFrameProvider;
/** The baseline provider `TimelineEditorProps.frameProvider` defaults to.
 *  Video and image pools each hold up to `maxElements` entries. */
export declare function createVideoElementFrameProvider(opts?: {
    maxElements?: number;
}): VideoFrameProvider;
