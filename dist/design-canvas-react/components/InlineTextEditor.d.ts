/**
 * Inline text editor: a positioned <textarea> that appears over a text element
 * on double-click, mirroring its font properties at the current zoom. The
 * parent Workspace mounts this when `editingElementId` is set and unmounts it
 * on commit/cancel.
 *
 * V1 simplification: rotation is NOT applied to the textarea — rotated text
 * elements are edited in a non-rotated overlay at the element's AABB origin.
 * The textarea stays axis-aligned to avoid browser textarea rotation bugs.
 * Document the intent: a v2 pass may add a CSS transform to align with rotation.
 *
 * Commit: Meta+Enter or blur → emits `onCommit(newText)`.
 * Cancel: Escape → emits `onCancel()` and restores pre-edit text.
 */
import type { TextElement } from '../../design-canvas/model';
interface InlineTextEditorProps {
    element: TextElement;
    zoom: number;
    panX: number;
    panY: number;
    onCommit(text: string): void;
    onCancel(): void;
}
export declare function InlineTextEditor({ element, zoom, panX, panY, onCommit, onCancel, }: InlineTextEditorProps): import("react").JSX.Element;
export {};
