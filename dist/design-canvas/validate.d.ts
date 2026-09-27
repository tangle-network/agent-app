/**
 * Pre-write validation for scene operations. Every rule runs against a
 * `SceneDocument` snapshot BEFORE any mutation, so a rejected batch leaves no
 * partial state. Batch errors carry the shape `operation N (type): reason` —
 * precise enough for an LLM planner to repair the offending operation and
 * resubmit.
 *
 * Validation is static: a batch is checked against the document as given, so
 * an operation may not reference entities created by an earlier operation in
 * the same batch. Dispatchers that chain operations must refresh the document
 * between applications and validate per-operation.
 *
 * Slot typing contract (for apply_data bindings):
 *   text    elements  → value is any string
 *   image   elements  → value must pass assertSceneMediaSrc (src rewrite)
 *   video   elements  → value must pass assertSceneMediaSrc (src rewrite)
 *   rect    elements  → value must pass assertColor (fill recolor)
 *   ellipse elements  → value must pass assertColor (fill recolor)
 *   line    elements  → value must pass assertColor (stroke recolor)
 *   group   elements  → value must pass assertColor (fill/stroke passed down to children)
 */
import type { SceneDocument, SceneElementKind } from './model';
import type { SceneOperation } from './operations';
/** Validate each scene operation against the document and throw detailed errors for invalid operations */
export declare function validateSceneOperations(document: SceneDocument, operations: SceneOperation[]): void;
/** Validate a scene operation against the document to ensure it meets required constraints */
export declare function validateSceneOperation(document: SceneDocument, operation: SceneOperation): void;
/**
 * Validates that a slot binding value matches the slot element's kind.
 * text → any string; image/video → media src; rect/ellipse/line/group → color.
 */
export declare function validateSlotValue(slotName: string, elementKind: SceneElementKind, value: string): void;
