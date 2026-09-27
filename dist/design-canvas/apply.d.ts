/**
 * Pure application of validated scene operations to a SceneDocument.
 * `applySceneOperations` deep-clones the document then mutates the clone,
 * returning the new document and per-op results. It never touches the store,
 * a clock, or a PRNG — all id generation goes through the caller-supplied
 * `mintId` option so callers control determinism (counter in tests,
 * crypto.randomUUID in production).
 *
 * Rotation semantics for group/ungroup:
 *   Group: children retain their absolute rotation. The group origin is the
 *   min-x, min-y corner of the AABB union of all member elements. Children
 *   are rebased so their position in group-local space equals
 *   (element.x - group.x, element.y - group.y). A rotated child appears at
 *   the same absolute page position after grouping because the group's additive
 *   translation preserves the child's own-origin transform.
 *   Ungroup: inverse — child.x += group.x, child.y += group.y; rotation stays.
 *   This is consistent with Konva's transform-about-own-origin model without
 *   needing a full matrix concatenation for the common case.
 *
 * `storeApplyScenePlan` layers store I/O on top: getDocument → validate →
 * apply → saveDocument(expectedRev) → recordDecision, retrying once on
 * stale-rev by refetch + revalidate + reapply.
 */
import type { SceneDocument, SceneElement, ScenePage } from './model';
import type { SceneOperation, ScenePlan } from './operations';
import type { NewSceneDecision, SceneDocumentRecord, SceneStore } from './store';
/** Represent the result of applying changes to a scene as an element, page, or entire document */
export type SceneApplyResult = {
    kind: 'element';
    pageId: string;
    element: SceneElement;
} | {
    kind: 'page';
    page: ScenePage;
} | {
    kind: 'document';
};
/** Resolve element ID conflicts by providing fresh unique identifiers during scene application */
export interface ApplySceneOptions {
    /**
     * Provides fresh ids when duplicate_page re-mints element ids. Never called
     * by any other operation. Counter-based in tests; crypto.randomUUID in
     * production (wrapped so `mintId()` has no arguments, matching this signature).
     */
    mintId: () => string;
}
/** Full form: returns the new document AND per-op results. `mintId` must be
 *  provided when any operation in the list may be `duplicate_page` (which
 *  re-mints element ids); for all other operation types it is never called. */
export declare function applySceneOperations(document: SceneDocument, operations: SceneOperation[], options: ApplySceneOptions): {
    document: SceneDocument;
    results: SceneApplyResult[];
};
/** Convenience 2-arg form: returns the new document directly. Uses a
 *  monotonic counter as the mintId so `duplicate_page` never collides within
 *  a single call (suitable for editor-local optimistic state; server will
 *  re-mint on persist). */
export declare function applySceneOperations(document: SceneDocument, operations: SceneOperation[]): SceneDocument;
/** Apply a single operation to a document and return the new document.
 *  Equivalent to `applySceneOperations(doc, [op])` but returns `SceneDocument`
 *  directly — the common case in editor commands and tests. */
export declare function applySceneOperation(document: SceneDocument, operation: SceneOperation): SceneDocument;
/** Resolve and apply a scene plan to the store with specified actor context and generate results */
export declare function storeApplyScenePlan(store: SceneStore, plan: ScenePlan, opts: {
    actorKind: NewSceneDecision['kind'];
    mintId: () => string;
}): Promise<{
    record: SceneDocumentRecord;
    results: SceneApplyResult[];
}>;
