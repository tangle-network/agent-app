// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

// jsdom's PointerEvent doesn't carry button/clientX from the event init, which
// would trip the primary-button guard. Back it with MouseEvent (which does) so
// the drag handlers receive real coordinates.
class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 0;
  }
}
beforeAll(() => {
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
});

afterEach(() => cleanup());

function setup(width = 500, maxWidth = 1000) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const onNudge = vi.fn();
  const { getByRole } = render(
    <ResizeHandle
      width={width}
      maxWidth={maxWidth}
      onPreview={onPreview}
      onCommit={onCommit}
      onNudge={onNudge}
    />,
  );
  const el = getByRole("separator") as HTMLElement;
  // jsdom's pointer-capture support is incomplete; stub so the handlers run.
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = () => true;
  return { el, onPreview, onCommit, onNudge };
}

describe("ResizeHandle", () => {
  it("exposes the current/min/max width via ARIA", () => {
    const { el } = setup(620, 980);
    expect(el.getAttribute("aria-valuenow")).toBe("620");
    expect(el.getAttribute("aria-valuemin")).toBe("360");
    expect(el.getAttribute("aria-valuemax")).toBe("980");
  });

  it("previews during drag (right-anchored: dragging left widens) and commits on release", () => {
    const { el, onPreview, onCommit } = setup(500);
    fireEvent.pointerDown(el, { clientX: 800, button: 0, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 750, pointerId: 1 });
    // startWidth 500 + (800 - 750) = 550
    expect(onPreview).toHaveBeenLastCalledWith(550);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerMove(el, { clientX: 700, pointerId: 1 });
    expect(onPreview).toHaveBeenLastCalledWith(600);

    fireEvent.pointerUp(el, { pointerId: 1 });
    // Persisted once, with the last previewed width.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(600);
  });

  it("does not preview pointer moves before a drag starts", () => {
    const { el, onPreview } = setup();
    fireEvent.pointerMove(el, { clientX: 700, pointerId: 1 });
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("nudges by ±24 on arrow keys", () => {
    const { el, onNudge } = setup();
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(onNudge).toHaveBeenLastCalledWith(24);
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onNudge).toHaveBeenLastCalledWith(-24);
  });
});
