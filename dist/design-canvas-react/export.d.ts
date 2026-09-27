/**
 * Client-side export for design-canvas pages: raster (PNG/JPEG via Konva
 * stage.toDataURL) and JSON (document serialisation).
 *
 * The heavy lifting — crop math, pixel ratio resolution, CORS taint detection
 * — lives in export-math.ts where it can be unit-tested without a canvas
 * context. This file is the thin Konva-wiring layer: hide overlays, call
 * toDataURL, restore, handle the SecurityError.
 *
 * Konva is an OPTIONAL peer. Import this file only from browser-context code
 * that has konva wired in. The types are written against a minimal structural
 * interface so the file compiles even when konva's types are absent.
 */
import type { SceneDocument, ScenePage } from '../design-canvas/model';
import type { ExportPreset } from '../design-canvas/export-presets';
interface KonvaNodeLike {
    name(): string;
    visible(): boolean;
    visible(v: boolean): void;
    getAttr(key: string): unknown;
    isCached(): boolean;
    clearCache(): void;
    cache(config?: {
        pixelRatio?: number;
    }): void;
    getAbsoluteScale(): {
        x: number;
        y: number;
    };
    /** Konva.Container only — leaf shapes lack it; the cache walk treats its
     *  absence as "no children". */
    getChildren?(): KonvaNodeLike[];
}
interface KonvaLayerLike {
    getChildren(): KonvaNodeLike[];
}
interface KonvaStageLike {
    scaleX(): number;
    scaleY(): number;
    x(): number;
    y(): number;
    getLayers(): KonvaLayerLike[];
    toDataURL(params: {
        mimeType: string;
        quality?: number;
        pixelRatio: number;
        x: number;
        y: number;
        width: number;
        height: number;
    }): string;
}
/** Define options to export a page as a data URL with format, pixel ratio, bleed, and preset settings */
export interface ExportPageDataUrlOptions {
    format: 'png' | 'jpeg';
    pixelRatio?: number;
    includeBleed?: boolean;
    preset?: ExportPreset;
}
/**
 * Render a single page to a data URL.
 *
 * The function temporarily hides every node whose name starts with 'overlay:'
 * plus any Transformer node, computes the crop rect and pixel ratio from the
 * page model and options, calls stage.toDataURL, then restores all prior view
 * state exactly — zoom, pan, and node visibility.
 *
 * Rejects with a descriptive error when a CORS-tainted image source causes
 * the SecurityError, naming the offending src so the caller can surface it.
 *
 * The `stage` argument must be the Konva stage with the page content already
 * rendered. The caller is responsible for ensuring all async image loads have
 * settled before calling this function.
 */
export declare function exportPageDataUrl(stage: KonvaStageLike, page: ScenePage, opts: ExportPageDataUrlOptions): Promise<string>;
/**
 * Serialize a scene document to pretty-printed JSON with schemaVersion
 * asserted. Throws when the document's schemaVersion does not match
 * SCENE_SCHEMA_VERSION — the caller must not smuggle stale documents through.
 */
export declare function exportDocumentJson(document: SceneDocument): string;
/**
 * Trigger a browser download for a data URL. Safe to import in SSR — the
 * function is a no-op when `document` is not defined (e.g. server-side render
 * or test environment without a DOM). The integrator must not rely on the
 * download executing in those contexts.
 */
export declare function downloadDataUrl(dataUrl: string, filename: string): void;
export {};
