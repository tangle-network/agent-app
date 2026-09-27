/**
 * Pure builders for the human "add element to the canvas" path — the math and
 * `SceneOperation` construction behind {@link CanvasInsertPanel}, separated from
 * the React/DOM layer so every insert is unit-testable without Konva or a
 * browser. The panel calls these to produce `add_element` operations and hands
 * them to the host's `onApplyOperations` (server-validated, undoable) — the same
 * pipeline every other edit flows through.
 *
 * Media boundary: image inserts must pass {@link assertSceneMediaSrc} (remote
 * http(s) or a rooted `/api/` path — never `data:` blobs or sandbox-local
 * files). Builders that take a src assert it up front so a bad url fails here,
 * not deep in the apply layer.
 */
import type { SceneOperation } from '../design-canvas/operations';
/** Largest dimension (document px) a freshly inserted element is fitted to,
 *  before the page-size cap applies. Keeps a huge upload from filling the page. */
export declare const MAX_INSERT_DIMENSION = 600;
/** Active page geometry an insert lands into — drives centering and fitting. */
export interface InsertPageGeometry {
    pageId: string;
    width: number;
    height: number;
    background?: string;
}
/** Mint a DOM-safe element id. Prefers `crypto.randomUUID`; falls back to a
 *  time+random id where crypto is unavailable (older runtimes, some test envs). */
export declare function mintElementId(): string;
/** Fit (naturalW, naturalH) under a max-dimension cap (further bounded by the
 *  page), preserving aspect ratio. Never upscales past natural size. */
export declare function fittedSize(naturalW: number, naturalH: number, pageWidth: number, pageHeight: number): {
    width: number;
    height: number;
};
/** Top-left position that centers a (width, height) box on the page. */
export declare function centeredPosition(width: number, height: number, pageWidth: number, pageHeight: number): {
    x: number;
    y: number;
};
/**
 * Build an `add_element` op placing an image, fitted and centered on the page.
 * `naturalSize` is the probed image dimensions (the panel reads them in the
 * browser); pass `{ width: 0, height: 0 }` when unknown to fall back to the cap.
 *
 * Throws (via `assertSceneMediaSrc`) when `src` is not http(s) or a rooted
 * `/api/` path — callers should surface the error, never insert a `data:` src.
 */
export declare function buildInsertImageOp(src: string, naturalSize: {
    width: number;
    height: number;
}, page: InsertPageGeometry): SceneOperation;
/** A template the insert panel can drop without the agent. `build` is pure and
 *  produces the operations for the active page geometry. */
export interface InsertTemplate {
    id: string;
    label: string;
    build(page: InsertPageGeometry): SceneOperation[];
}
/** The built-in starter templates (heading, body text, rectangle, ellipse).
 *  Consumers can pass their own list to {@link CanvasInsertPanel}; this is the
 *  default so every canvas gets a usable set out of the box. */
export declare const DEFAULT_INSERT_TEMPLATES: readonly InsertTemplate[];
