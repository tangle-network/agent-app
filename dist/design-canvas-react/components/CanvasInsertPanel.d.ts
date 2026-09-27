/**
 * The human "add element to the canvas" side panel — a reusable left rail any
 * canvas consumer can mount so a person (not just the agent) can put images,
 * shapes, and text on the canvas. Designed for the `renderSidePanel` slot of
 * {@link DesignCanvasProps}; pass `renderSidePanel={(ctx) => <CanvasInsertPanel … />}`.
 *
 * Endpoints are per-app, so every I/O path is a callback — no product route is
 * hardcoded:
 *  - `onUploadImage(file) => Promise<url>` — optional. When provided, the host
 *    stores the file and returns the src to insert. The url MUST be http(s) or
 *    a rooted `/api/` path (enforced by `assertSceneMediaSrc` before insertion);
 *    a `data:` url is rejected, matching the scene model's media boundary.
 *  - `loadGenerations?()` — optional provider for "already generated in this
 *    workspace" images; omit to hide the tab.
 *  - `templates?` — optional template set; defaults to {@link DEFAULT_INSERT_TEMPLATES}.
 *    A host-passed (composed) set labels its tab "Templates"; the built-in
 *    primitives label it "Elements".
 *
 * Insertion goes through `onInsert`, which the host wires to its
 * `onApplyOperations` pipeline (server-validated, undoable) — the same path
 * every other edit takes.
 *
 * Tokens/icons follow the canvas convention: CSS-var design tokens and inline
 * SVG glyphs, no icon-library or Tailwind-semantic-token dependency.
 */
import type { SceneOperation } from '../../design-canvas/operations';
import { type InsertPageGeometry, type InsertTemplate } from '../insert-builders';
/** An already-generated image the panel can offer for one-click insertion. */
export interface InsertGeneration {
    id: string;
    /** The image url to insert. Must satisfy the scene media boundary
     *  (http(s) or rooted `/api/`); rejected otherwise at insert time. */
    url: string;
    /** Optional prompt/label shown as the tile's title. */
    label?: string;
}
export interface CanvasInsertPanelProps {
    canWrite: boolean;
    /** The active page new elements are added to. */
    page: InsertPageGeometry;
    /** Submit operations through the host's apply pipeline. */
    onInsert(operations: SceneOperation[]): Promise<unknown>;
    /** Store an uploaded file and return its src (http(s) or rooted `/api/`). */
    onUploadImage?(file: File): Promise<string>;
    /** Optional provider for the Generations tab; omit to hide it. */
    loadGenerations?(): Promise<InsertGeneration[]>;
    /** Drop-in templates; defaults to the built-in starter set. */
    templates?: readonly InsertTemplate[];
    /** Accepted upload mime types. Default: PNG/JPEG/GIF/WebP. */
    accept?: string;
    className?: string;
}
export declare function CanvasInsertPanel({ canWrite, page, onInsert, onUploadImage, loadGenerations, templates, accept, className, }: CanvasInsertPanelProps): import("react").JSX.Element;
