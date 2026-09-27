/**
 * Drag-to-resize grip on the assistant drawer's left edge. Pointer capture keeps
 * the drag alive while the cursor moves anywhere on screen; arrow keys resize in
 * coarse steps for keyboard users. The drawer is right-anchored, so dragging
 * left widens it. The in-memory width updates every move (`onPreview`); the
 * final width is persisted once on release (`onCommit`).
 */
export declare function ResizeHandle({ width, maxWidth, onPreview, onCommit, onNudge, }: {
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
}): import("react").JSX.Element;
