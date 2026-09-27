/**
 * Smooth text reveal — turns chunky network deltas into a continuous
 * typewriter paint. Streamed turns arrive in 100-500ms slabs (model burst,
 * flush windows, replay polls); revealing characters at an adaptive rate
 * makes the same bytes read as top-tier streaming. The rate scales with the
 * backlog so the reveal never falls behind the stream — it crawls when caught
 * up and sprints when a burst lands (e.g. a reasoning summary arriving all at
 * once still *types out* instead of popping in).
 */
/** Define configuration options for controlling smooth text reveal animation rates */
export interface SmoothRevealOptions {
    /** Baseline reveal rate when nearly caught up. Default 90 chars/s. */
    baseCharsPerSecond?: number;
    /** Extra chars/s per backlog character — the catch-up pressure. Default 5. */
    catchUpPerChar?: number;
    /** Hard ceiling so giant bursts still animate. Default 2400 chars/s. */
    maxCharsPerSecond?: number;
}
/** Pure reveal step: how many characters should be visible after `dtMs`.
 *  Exposed for tests; the hook is a thin rAF wrapper around it. */
export declare function nextRevealCount(shown: number, targetLength: number, dtMs: number, opts?: SmoothRevealOptions): number;
/**
 * Animate `target` text into view. While `enabled`, the returned string grows
 * smoothly toward `target` (which may itself keep growing); when `enabled` is
 * false the full text returns immediately (history, completed turns). A
 * target that is not an extension of the revealed prefix (new message) resets
 * the reveal.
 */
export declare function useSmoothText(target: string, enabled: boolean, opts?: SmoothRevealOptions): string;
