import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

/** Distance (px) from the bottom within which we still consider the user
 *  "pinned" — a small slack so sub-pixel rounding, or a programmatic scroll that
 *  lands a hair short, doesn't unstick auto-follow. */
const STICK_SLACK_PX = 48;

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
export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  { enabled, contentSignature, streamingId, threadId }: StickToBottomOptions,
): { onScroll: () => void } {
  const stuckRef = useRef(true);
  const prevStreamingRef = useRef<string | null>(streamingId);
  const prevThreadRef = useRef<string | null>(threadId);

  // Re-arm at the start of a new streaming turn (streamingId null→id) or a thread
  // switch, so a fresh response always follows from the top even if the user had
  // scrolled up during the previous turn. A turn ENDING (id→null) does NOT re-arm,
  // so it never yanks a user who scrolled up to read.
  useEffect(() => {
    const turnStarted =
      streamingId != null && streamingId !== prevStreamingRef.current;
    const threadChanged = threadId !== prevThreadRef.current;
    prevStreamingRef.current = streamingId;
    prevThreadRef.current = threadId;
    if (turnStarted || threadChanged) stuckRef.current = true;
  }, [streamingId, threadId]);

  // The user's scroll position drives whether we keep following. A programmatic
  // scroll also fires this, so compare against a small slack rather than exact
  // equality.
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    stuckRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX;
  }, [ref]);

  // useLayoutEffect (pre-paint) so pinned content never flashes above the fold.
  useLayoutEffect(() => {
    if (!enabled || !stuckRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, enabled, contentSignature]);

  return { onScroll };
}
