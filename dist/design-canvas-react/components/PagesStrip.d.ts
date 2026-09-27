/**
 * Horizontal page-thumbnail strip shown at the bottom of the editor. The active
 * page is highlighted. Thumbnails are rendered externally (Konva; the host
 * injects `renderThumbnail` so this component stays canvas-free and testable).
 *
 * Actions: add page, duplicate active page, delete active page (disabled when
 * only one page remains), drag-reorder pages. The strip is read-only when
 * `canWrite` is false.
 */
import type { ScenePage } from '../../design-canvas/model';
export interface PagesStripProps {
    pages: ScenePage[];
    activePageId: string;
    canWrite: boolean;
    /**
     * The host provides this to generate thumbnail data-URLs. The strip calls it
     * on mount and debounces re-calls on document changes. Returns null when the
     * thumbnail is not yet available (the strip renders a placeholder instead).
     */
    renderThumbnail(page: ScenePage): Promise<string | null>;
    onSelectPage(pageId: string): void;
    onAddPage(): void;
    onDuplicatePage(pageId: string): void;
    onDeletePage(pageId: string): void;
    onReorderPage(pageId: string, toIndex: number): void;
    /** Show page-management affordances (add / duplicate / delete). Default true.
     *  The review surface passes false: pages are navigated, not authored. */
    canManagePages?: boolean;
    /** Heading shown above the strip so it reads as page management. Overridable;
     *  defaults to "Pages". Set to '' to hide the visible label (the container
     *  keeps its accessible name regardless). */
    label?: string;
}
export declare function PagesStrip({ pages, activePageId, canWrite, renderThumbnail, onSelectPage, onAddPage, onDuplicatePage, onDeletePage, onReorderPage, canManagePages, label, }: PagesStripProps): import("react").JSX.Element;
