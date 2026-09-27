import { type RefObject } from "react";
export interface StickToBottomOptions {
    /** Auto-follow only applies while this is true (e.g. the chat view is shown,
     *  not the history view). */
    enabled: boolean;
    /** A value that changes whenever streamed content grows or the turn's shape
     *  changes — the trigger to (re-)scroll to the bottom while pinned. */
    contentSignature: string | number;
    /** Current streaming turn id (null between turns). A null→id transition
     *  re-arms follow so a fresh response scrolls from the top. */
    streamingId: string | null;
    /** Current thread id (null before any thread loads). A change re-arms follow so
     *  switching threads lands at the newest content. */
    threadId: string | null;
}
/**
 * Keep a scroll container pinned to its newest content as it streams, while
 * yielding the instant the user scrolls up to read. It re-arms when the user
 * returns to the bottom (via {@link onScroll}) or when a new turn/thread starts.
 * Returns the `onScroll` handler to attach to the container.
 *
 * Extracted from the panel so the follow/yield/re-arm contract is unit-testable
 * independent of the full component (jsdom doesn't compute scroll geometry, so a
 * hook test mocks the element's `scrollHeight`/`clientHeight`/`scrollTop`).
 */
export declare function useStickToBottom(ref: RefObject<HTMLElement | null>, { enabled, contentSignature, streamingId, threadId }: StickToBottomOptions): {
    onScroll: () => void;
};
