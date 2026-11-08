import { type KeyboardEvent, type PointerEvent, useRef } from "react";

export interface ResizeHandleProps {
  width: number;
  minWidth: number;
  maxWidth: number;
  /** The pane edge the grip sits on: "left" for a right-anchored pane (dragging left widens it), "right" for a left-anchored one. */
  edge?: "left" | "right";
  /** Accessible name, such as "Resize assistant panel". */
  label: string;
  /** Live (non-persisted) width during a drag: the raw pointer-derived width, NOT clamped; the consumer clamps. */
  onPreview: (next: number) => void;
  /** Persist the final width, once on release; skipped when the pointer never moved. */
  onCommit: (next: number) => void;
  /** Keyboard resize delta in px (the consumer clamps and persists). */
  onNudge: (deltaPx: number) => void;
  /** Double-click: return to the default width. */
  onReset?: () => void;
  className?: string;
}

/**
 * Drag-to-resize grip on a pane's edge, an ARIA window splitter. Pointer
 * capture keeps the drag alive while the cursor moves anywhere on screen; arrow
 * keys resize in 24 px steps. The parent positions it (the grip is absolute).
 */
export function ResizeHandle({ width, minWidth, maxWidth, edge = "left", label, onPreview, onCommit, onNudge, onReset, className = "" }: ResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null);
  // Moving the pointer toward the pane's free side widens it.
  const sign = edge === "left" ? -1 : 1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // primary button / touch / pen only
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: width, lastWidth: width };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Update the in-memory width every tick (smooth), but don't persist — that
    // would hit storage on every pointermove.
    const next = drag.startWidth + sign * (e.clientX - drag.startX);
    // Skip sub-pixel jitter so a touch drag doesn't re-render the pane subtree
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
    if (drag.lastWidth !== drag.startWidth) onCommit(drag.lastWidth);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const STEP = 24;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    onNudge((e.key === "ArrowRight" ? STEP : -STEP) * sign);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable drag handle is an ARIA window-splitter (role=separator); no native HTML element provides this.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={`group absolute inset-y-0 z-10 flex w-2 cursor-ew-resize touch-none items-center justify-center ${edge === "left" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"} ${className}`}
    >
      <span
        aria-hidden="true"
        className="h-10 w-1 rounded-full bg-border transition-colors group-hover:bg-primary group-focus:bg-primary"
      />
    </div>
  );
}
