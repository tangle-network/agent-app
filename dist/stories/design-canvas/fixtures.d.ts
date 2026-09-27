/**
 * Local fixtures + harness helpers for the design-canvas stories.
 *
 * `makeLaunchPosterScene` mirrors the shared `../fixtures/canvas.ts` fixture
 * (kept local so these stories are self-contained); the multi-page and empty
 * scenes are additions covering the editor's page strip, layers states, and
 * empty-state doors.
 */
import type { SceneDocument, ScenePage } from '../../design-canvas';
import type { SceneOperation } from '../../design-canvas';
/** Single-page poster scene — populated enough that every editor surface
 *  (layers, toolbar, rulers, guides) renders with real content. Text elements
 *  reference Inter, loaded in `.storybook/preview-head.html`. */
export declare function makeLaunchPosterScene(): SceneDocument;
/** One blank 1080×1080 page — drives the branded empty state (three doors). */
export declare function makeEmptyScene(): SceneDocument;
/**
 * Three pages with distinct aspect ratios so the pages strip shows real
 * variety. Page 2 carries the layers-showcase set: a group with children,
 * a hidden element, a locked element, a slot-bound element, and one element
 * of every remaining kind (image/video included — their media never loads in
 * Storybook, which exercises the placeholder/broken treatments). One
 * data-URL art card (`el-hero-art`) gives the page a designed focal point
 * amid the intentional placeholders.
 */
export declare function makeMultiPageScene(): SceneDocument;
/** The layers-showcase page on its own (panel stories). */
export declare function makeLayersShowcasePage(): ScenePage;
/**
 * Read the live theme from the document element so the Konva canvas (which
 * cannot resolve CSS vars) paints with the active palette. Tracks the global
 * Storybook theme toolbar, which mutates `data-theme` / `.dark` on
 * `document.documentElement`. Stories never set the theme themselves.
 */
export declare function useIsDark(): boolean;
/**
 * Host-side persistence for editor stories, mirroring the playground canvas
 * route: ops are reduced into local document state with the engine's real
 * `applySceneOperations`, so the editor rebases onto a coherent post-apply
 * document on every save (and a rejected op would surface, not echo stale).
 */
export declare function useLocalSceneDocument(initial: SceneDocument): {
    document: SceneDocument;
    rev: number;
    onApplyOperations: (operations: SceneOperation[]) => Promise<{
        rev: number;
        document: SceneDocument;
    }>;
};
/**
 * Deterministic offline thumbnail for PagesStrip stories: an SVG data URL
 * painting the page background plus simplified element fills. The real
 * Konva-based renderer is exercised through the full editor stories.
 */
export declare function renderFakeThumbnail(page: ScenePage): Promise<string | null>;
/** Never resolves — drives the PagesStrip placeholder (loading) treatment. */
export declare function renderPendingThumbnail(): Promise<string | null>;
