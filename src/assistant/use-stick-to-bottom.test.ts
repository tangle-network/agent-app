// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type StickToBottomOptions,
  useStickToBottom,
} from "./use-stick-to-bottom";

/** A stand-in for the scroll container: jsdom doesn't compute layout, so the
 *  geometry the hook reads (`scrollHeight`/`clientHeight`) is set explicitly and
 *  `scrollTop` is a plain mutable field the hook writes. Mutable on purpose (the
 *  real element's `scrollHeight` is read-only), cast to `HTMLElement` at the ref. */
interface MockScrollEl {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}
function makeEl(scrollHeight = 1000, clientHeight = 400, scrollTop = 0): MockScrollEl {
  return { scrollHeight, clientHeight, scrollTop };
}
function refOf(el: MockScrollEl): { current: HTMLElement | null } {
  return { current: el as unknown as HTMLElement };
}

function mount(ref: { current: HTMLElement | null }, props: StickToBottomOptions) {
  return renderHook((p: StickToBottomOptions) => useStickToBottom(ref, p), {
    initialProps: props,
  });
}

const base: StickToBottomOptions = {
  enabled: true,
  contentSignature: "0",
  streamingId: "turn-a",
  threadId: "thread-1",
};

describe("useStickToBottom", () => {
  it("follows: pins to the bottom on mount and as content grows", () => {
    const el = makeEl(1000, 400, 0);
    const { rerender } = mount(refOf(el), base);
    // Pinned by default → scrolled to the bottom on mount.
    expect(el.scrollTop).toBe(1000);
    // Content streams in (scrollHeight grows) → follows to the new bottom.
    el.scrollHeight = 1600;
    rerender({ ...base, contentSignature: "1" });
    expect(el.scrollTop).toBe(1600);
  });

  it("yields: stops following once the user scrolls up", () => {
    const el = makeEl(1000, 400, 1000);
    const ref = refOf(el);
    const { result, rerender } = mount(ref, base);
    // User scrolls up to read (far from the bottom).
    el.scrollTop = 100;
    act(() => result.current.onScroll());
    // More content arrives — the hook must NOT yank the view back down.
    el.scrollHeight = 1600;
    rerender({ ...base, contentSignature: "1" });
    expect(el.scrollTop).toBe(100);
  });

  it("re-arms on the user returning to the bottom", () => {
    const el = makeEl(1000, 400, 1000);
    const ref = refOf(el);
    const { result, rerender } = mount(ref, base);
    // Scroll up (unstick), then back to the bottom (re-stick).
    el.scrollTop = 100;
    act(() => result.current.onScroll());
    el.scrollTop = 1000; // scrollHeight(1000) - 1000 - clientHeight(400) < 0 < slack
    act(() => result.current.onScroll());
    el.scrollHeight = 1600;
    rerender({ ...base, contentSignature: "1" });
    expect(el.scrollTop).toBe(1600);
  });

  it("re-arms follow when a new streaming turn starts", () => {
    const el = makeEl(1000, 400, 1000);
    const ref = refOf(el);
    const { result, rerender } = mount(ref, base);
    // Scroll up mid-turn → unstuck; content while unstuck is not followed.
    el.scrollTop = 100;
    act(() => result.current.onScroll());
    el.scrollHeight = 1600;
    rerender({ ...base, contentSignature: "1" });
    expect(el.scrollTop).toBe(100);
    // A NEW turn starts AND its first content lands in the SAME rerender — the
    // re-arm must scroll it, not be deferred to a later render.
    el.scrollHeight = 2200;
    rerender({ ...base, contentSignature: "2", streamingId: "turn-b" });
    expect(el.scrollTop).toBe(2200);
  });

  it("re-arms follow when the thread changes", () => {
    const el = makeEl(1000, 400, 1000);
    const ref = refOf(el);
    const { result, rerender } = mount(ref, base);
    el.scrollTop = 100;
    act(() => result.current.onScroll());
    el.scrollHeight = 1600;
    rerender({ ...base, contentSignature: "1" });
    expect(el.scrollTop).toBe(100);
    // Switch threads AND load the new thread's content in the SAME rerender (the
    // real path: a thread switch updates threadId and the messages together). The
    // combined layout effect must re-arm THEN scroll — a deferred re-arm would
    // leave the user stranded at the old position.
    el.scrollHeight = 2000;
    rerender({ ...base, contentSignature: "2", threadId: "thread-2" });
    expect(el.scrollTop).toBe(2000);
  });

  it("ignores scroll events while disabled, so the history view can't unstick the chat", () => {
    const el = makeEl(1000, 400, 1000);
    const ref = refOf(el);
    const { result, rerender } = mount(ref, { ...base, enabled: false });
    // Scroll away from the bottom WHILE disabled (the shared container showing
    // the history view) — this must NOT unstick the chat's auto-follow.
    el.scrollTop = 100;
    act(() => result.current.onScroll());
    // Back to the chat view with new content → still follows (the disabled scroll
    // was ignored, so the stuck ref was never cleared).
    rerender({ ...base, enabled: true, contentSignature: "1" });
    el.scrollHeight = 1600;
    rerender({ ...base, enabled: true, contentSignature: "2" });
    expect(el.scrollTop).toBe(1600);
  });

  it("does not follow while disabled (e.g. the history view is open)", () => {
    const el = makeEl(1000, 400, 0);
    const { rerender } = mount(refOf(el), { ...base, enabled: false });
    expect(el.scrollTop).toBe(0); // never pinned while disabled
    el.scrollHeight = 1600;
    rerender({ ...base, enabled: false, contentSignature: "1" });
    expect(el.scrollTop).toBe(0);
  });
});
