/**
 * Concrete `SceneCommand` factories for the design-canvas editor. Every factory
 * captures the inverse from PRE-state at construction — undo is a value
 * computed once, never re-derived from current state later. Local execute/undo
 * update `EditorSceneState` immutably by routing through `applySceneOperation`
 * so optimistic state matches what the server-side dispatcher will persist.
 *
 * Drag gestures coalesce: pointer moves update volatile state, ONE command
 * executes on pointer release with (finalAttrs, priorAttrs). `setAttrsCommand`
 * is that gesture command — one undo step per drag/transform/toolbar change.
 * `multiSetAttrsCommand` collects N set_attrs ops into one undo step for
 * multi-select transforms.
 *
 * Group/ungroup route through `applySceneOperation` so the group-origin
 * rebasing in `apply.ts` is the single source of truth for both optimistic and
 * server state.
 */
import type { SceneDocument, SceneElement } from '../../design-canvas/model';
import type { SceneAttrsPatch } from '../../design-canvas/operations';
import type { SceneCommand } from '../contracts';
/** Define input parameters for adding a scene element with optional index and parent group ID */
export interface AddElementInput {
    pageId: string;
    element: SceneElement;
    /** Insertion z-index within owner; omitted → top. */
    index?: number;
    /** Parent group id; omitted → page root. */
    parentGroupId?: string;
}
/** Create a command to add an element to a scene with optional positioning and grouping */
export declare function addElementCommand(input: AddElementInput): SceneCommand;
/** Define input parameters for setting element attributes within a specific page context */
export interface SetAttrsInput {
    pageId: string;
    elementId: string;
    /** Final attribute values after the gesture. */
    attrs: SceneAttrsPatch;
    /** Attribute values BEFORE the gesture began — inverse is built from these. */
    priorAttrs: SceneAttrsPatch;
}
/** Create a command to set attributes on a scene element with undo capability */
export declare function setAttrsCommand(input: SetAttrsInput): SceneCommand;
/** Define an entry linking page and element IDs with current and prior scene attribute patches */
export interface MultiSetAttrsEntry {
    pageId: string;
    elementId: string;
    attrs: SceneAttrsPatch;
    priorAttrs: SceneAttrsPatch;
}
/** Build a scene command to set multiple attributes on elements across pages */
export declare function multiSetAttrsCommand(entries: MultiSetAttrsEntry[]): SceneCommand;
/** Define input parameters to reorder an element within a page */
export interface ReorderElementInput {
    pageId: string;
    elementId: string;
    toIndex: number;
}
/** Resolve a command to reorder an element within a scene by moving it to a specified index */
export declare function reorderElementCommand(input: ReorderElementInput): SceneCommand;
/** Define input parameters required to delete an element from a specific page in a document */
export interface DeleteElementInput {
    document: SceneDocument;
    pageId: string;
    elementId: string;
}
/** Resolve a command to delete an element from a specified page in the document */
export declare function deleteElementCommand(input: DeleteElementInput): SceneCommand;
/** Define input parameters for grouping elements within a scene document on a specific page */
export interface GroupElementsInput {
    document: SceneDocument;
    pageId: string;
    elementIds: string[];
    groupId: string;
    name?: string;
}
/** Create a command to group multiple elements into a single group within a scene */
export declare function groupElementsCommand(input: GroupElementsInput): SceneCommand;
/** Define input parameters required to ungroup elements within a specific page and group */
export interface UngroupElementInput {
    document: SceneDocument;
    pageId: string;
    groupId: string;
}
/** Resolve a command to ungroup a group element into its child elements within a scene */
export declare function ungroupElementCommand(input: UngroupElementInput): SceneCommand;
/** Define input parameters for adding a new page with optional settings and position index */
export interface AddPageInput {
    pageId: string;
    options?: import('../../design-canvas/model').NewPageOptions;
    index?: number;
}
/** Create a command to add a page with optional settings and index in the scene */
export declare function addPageCommand(input: AddPageInput): SceneCommand;
/** Define input parameters required to duplicate a page within a scene document */
export interface DuplicatePageInput {
    document: SceneDocument;
    sourcePageId: string;
    /** Caller-minted id for the copy. */
    pageId: string;
}
/** Create a command to duplicate a page and prepare its deletion operation in the scene */
export declare function duplicatePageCommand(input: DuplicatePageInput): SceneCommand;
/** Define input parameters required to delete a page from a scene document */
export interface DeletePageInput {
    document: SceneDocument;
    pageId: string;
}
/** Delete a page from a document ensuring it is not the last remaining page */
export declare function deletePageCommand(input: DeletePageInput): SceneCommand;
/** Define input parameters to reorder a page by specifying its ID and target index */
export interface ReorderPageInput {
    pageId: string;
    toIndex: number;
}
/** Create a command to reorder a page to a specified index within a scene */
export declare function reorderPageCommand(input: ReorderPageInput): SceneCommand;
/** Define input parameters for setting properties on a specific page within a scene document */
export interface SetPagePropsInput {
    document: SceneDocument;
    pageId: string;
    props: {
        name?: string;
        width?: number;
        height?: number;
        background?: string;
        bleed?: import('../../design-canvas/model').PageBleed | null;
    };
}
/** Build a command to update page properties based on the provided input */
export declare function setPagePropsCommand(input: SetPagePropsInput): SceneCommand;
/** Define input parameters for setting guides on a specific page within a document */
export interface SetPageGuidesInput {
    document: SceneDocument;
    pageId: string;
    guides: import('../../design-canvas/model').PageGuides;
}
/** Create a command to update page guides with undo support */
export declare function setPageGuidesCommand(input: SetPageGuidesInput): SceneCommand;
/** Define input parameters for binding a slot within a scene document element */
export interface BindSlotInput {
    document: SceneDocument;
    pageId: string;
    elementId: string;
    slot: string | null;
}
/** Bind a slot to an element within a page and generate the corresponding scene command */
export declare function bindSlotCommand(input: BindSlotInput): SceneCommand;
/** Define input parameters for setting the title of a scene document */
export interface SetDocumentTitleInput {
    document: SceneDocument;
    title: string;
}
/** Resolve a command to rename a document title with undo and redo operations */
export declare function setDocumentTitleCommand(input: SetDocumentTitleInput): SceneCommand;
