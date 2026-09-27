/**
 * Template helpers for design-canvas documents. A template is any document
 * whose elements carry `slot` names — those slots define the fillable surface
 * that data sources and agents target. The helpers here are pure (no store,
 * no Konva) so they run server-side, in MCP tools, or in tests without a DOM.
 *
 * Binding semantics (shared with `apply_data` operation):
 *   - text elements: binding value replaces `element.text`
 *   - image/video elements: binding value replaces `element.src`
 *   - rect/ellipse elements with a slot: binding value replaces `element.fill`
 *     (color-slot convention — background swatch templates)
 *   - line/group slots are reserved; binding them throws a loud error
 * Unknown binding keys (no matching slot) throw — callers must preflight with
 * `validateBindings` or accept that the throw is the signal to fix their data.
 */
import { type SceneDocument, type SceneElementKind } from './model';
/** Define allowed string literals representing different slot fill kinds */
export type SlotFillKind = 'text' | 'src' | 'color';
/** Define a slot template specifying its name, page, element, and fill characteristics */
export interface TemplateSlot {
    name: string;
    pageId: string;
    elementId: string;
    elementKind: SceneElementKind;
    fillKind: SlotFillKind;
}
/**
 * Wraps `collectSlots` with kind-aware fill typing so callers know WHAT to
 * put in each slot without inspecting the element tree themselves.
 * Throws when duplicate slot names exist (propagated from collectSlots).
 */
export declare function listTemplateSlots(document: SceneDocument): TemplateSlot[];
/**
 * Preflight check: every key in `bindings` must name a slot in the document.
 * Returns a list of problems; an empty array means the bindings are clean.
 * Does NOT throw — designed to run before `instantiateTemplate` so callers
 * can surface a structured error instead of catching.
 */
export declare function validateBindings(document: SceneDocument, bindings: Record<string, string>): string[];
/** Define options for instantiating a document with title, optional bindings, and custom id minting */
export interface InstantiateOptions {
    /** Human-readable title for the new document. */
    title: string;
    /** Slot bindings to apply after id re-minting. Partial application allowed. */
    bindings?: Record<string, string>;
    /**
     * Caller-supplied id factory — every page/element id in the source document
     * is replaced with a fresh value from this callback. The callback receives
     * the source id so implementations can build stable deterministic ids (e.g.
     * `crypto.randomUUID()` or `nanoid()` from the host).
     */
    mintId(sourceId: string): string;
}
/**
 * Produces a new `SceneDocument` from a template:
 * 1. Re-mints every page and element id via `options.mintId` (slot *names* are
 *    preserved so apply_data still targets them by name).
 * 2. Applies `options.bindings` with the same semantics as `apply_data`.
 * 3. Stamps `metadata.templateSourceId` with the source document's title so
 *    the lineage is traceable without storing separate template provenance rows.
 *
 * Throws when bindings reference unknown slots (validated via `validateBindings`
 * before mutation so no partial state is possible).
 */
export declare function instantiateTemplate(document: SceneDocument, options: InstantiateOptions): SceneDocument;
/**
 * Applies slot bindings to a document in place (mutates a deep copy produced
 * by the caller). Unknown slot names throw — the preflight in `instantiateTemplate`
 * guarantees this is unreachable there; exported so the `apply_data` operation
 * handler can reuse it without duplicating the switch.
 */
export declare function applyBindingsToDocument(document: SceneDocument, bindings: Record<string, string>): SceneDocument;
