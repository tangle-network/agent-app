import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { MIN_PANEL_WIDTH } from "./usePanelPrefs";

/**
 * Drag-to-resize grip on the assistant drawer's left edge. Pointer capture keeps
 * the drag alive while the cursor moves anywhere on screen; arrow keys resize in
 * coarse steps for keyboard users. The drawer is right-anchored, so dragging
 * left widens it. The in-memory width updates every move (`onPreview`); the
 * final width is persisted once on release (`onCommit`).
 */
export function ResizeHandle({
  width,
  maxWidth,
  onPreview,
  onCommit,
  onNudge,
}: {
  width: number;
  maxWidth: number;
  /** Live (non-persisted) width update during a drag. The value is the raw
   *  pointer-derived width and is NOT clamped — the consumer must clamp it to its
   *  own min/max (the bundled `usePanelWidth.previewWidth` does). */
  onPreview: (next: number) => void;
  /** Persist the final width (drag end). */
  onCommit: (next: number) => void;
  /** Keyboard resize delta (clamped + persisted). */
  onNudge: (deltaPx: number) => void;
}) {
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    lastWidth: number;
  } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // primary button / touch / pen only
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startWidth: width,
      lastWidth: width,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Update the in-memory width every tick (smooth), but don't persist — that
    // would hit localStorage on every pointermove.
    const next = drag.startWidth + (drag.startX - e.clientX);
    // Skip sub-pixel jitter so a touch drag doesn't re-render the panel subtree
    // on every noise event.
    if (Math.abs(next - drag.lastWidth) < 1) return;
    drag.lastWidth = next;
    onPreview(next);
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Persist once, on release.
    onCommit(drag.lastWidth);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const STEP = 24;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onNudge(STEP);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onNudge(-STEP);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable drag handle is an ARIA window-splitter (role=separator); no native HTML element provides this.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize assistant panel"
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 left-0 z-10 flex w-2 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center focus:outline-none"
    >
      <span
        aria-hidden="true"
        className="h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-primary group-focus:bg-primary"
      />
    </div>
  );
}
