import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

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

  // The user's scroll position drives whether we keep following. A programmatic
  // scroll also fires this, so compare against a small slack rather than exact
  // equality. Ignore scrolls while disabled: the same container is reused for
  // the (disabled) history view, and scrolling that must not unstick the chat.
  const onScroll = useCallback(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    stuckRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX;
  }, [ref, enabled]);

  // ONE layout effect (pre-paint) does the re-arm and then the scroll, in that
  // order. Re-arming here — not in a passive `useEffect` — is what makes a thread
  // switch work: switching threads updates `threadId` AND loads the new thread's
  // content (`contentSignature`) in the SAME render, so if the user was scrolled
  // up a passive re-arm would run too late (after this effect already saw the
  // stale unstuck ref and skipped the scroll), leaving them pinned to the old
  // position. Doing both here keeps them synchronous.
  useLayoutEffect(() => {
    // A new streaming turn (streamingId null→id) or a thread switch re-arms
    // follow, so a fresh response scrolls from the top even if the user had
    // scrolled up during the previous turn. A turn ENDING (id→null) is neither,
    // so it never yanks a user who scrolled up to read.
    const turnStarted =
      streamingId != null && streamingId !== prevStreamingRef.current;
    const threadChanged = threadId !== prevThreadRef.current;
    prevStreamingRef.current = streamingId;
    prevThreadRef.current = threadId;
    if (turnStarted || threadChanged) stuckRef.current = true;

    if (!enabled || !stuckRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref, enabled, contentSignature, streamingId, threadId]);

  return { onScroll };
}
