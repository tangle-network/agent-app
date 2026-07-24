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

import type { SceneDocument, SceneElement, ScenePage } from '../../design-canvas/model'
import { requireElement, requirePage } from '../../design-canvas/model'
import { applySceneOperation, applySceneOperations } from '../../design-canvas/apply'
import type {
  AddElementOperation,
  DeleteElementOperation,
  SceneAttrsPatch,
  SceneOperation,
} from '../../design-canvas/operations'
import type { EditorSceneState, SceneCommand } from '../contracts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function applyOps(state: EditorSceneState, ops: SceneOperation[]): EditorSceneState {
  return { ...state, document: applySceneOperations(state.document, ops) }
}

function applyOp(state: EditorSceneState, op: SceneOperation): EditorSceneState {
  return { ...state, document: applySceneOperation(state.document, op) }
}

// ---------------------------------------------------------------------------
// add_element  /  inverse = delete_element
// ---------------------------------------------------------------------------

/** Define input parameters for adding a scene element with optional index and parent group ID */
export interface AddElementInput {
  pageId: string
  element: SceneElement
  /** Insertion z-index within owner; omitted → top. */
  index?: number
  /** Parent group id; omitted → page root. */
  parentGroupId?: string
}

/** Create a command to add an element to a scene with optional positioning and grouping */
export function addElementCommand(input: AddElementInput): SceneCommand {
  const addOp: SceneOperation = {
    type: 'add_element',
    pageId: input.pageId,
    element: structuredClone(input.element),
    ...(input.index !== undefined ? { index: input.index } : {}),
    ...(input.parentGroupId !== undefined ? { parentGroupId: input.parentGroupId } : {}),
  }
  const deleteOp: SceneOperation = {
    type: 'delete_element',
    pageId: input.pageId,
    elementId: input.element.id,
  }

  return {
    label: `Add ${input.element.kind}`,
    execute: (state) => applyOp(state, addOp),
    undo: (state) => applyOp(state, deleteOp),
    operations: () => [structuredClone(addOp)],
    inverseOperations: () => [structuredClone(deleteOp)],
  }
}

// ---------------------------------------------------------------------------
// set_attrs  — THE gesture command (one undo step per drag/transform)
// ---------------------------------------------------------------------------

/** Define input parameters for setting element attributes within a specific page context */
export interface SetAttrsInput {
  pageId: string
  elementId: string
  /** Final attribute values after the gesture. */
  attrs: SceneAttrsPatch
  /** Attribute values BEFORE the gesture began — inverse is built from these. */
  priorAttrs: SceneAttrsPatch
}

/** Create a command to set attributes on a scene element with undo capability */
export function setAttrsCommand(input: SetAttrsInput): SceneCommand {
  const forwardOp: SceneOperation = {
    type: 'set_attrs',
    pageId: input.pageId,
    elementId: input.elementId,
    attrs: structuredClone(input.attrs),
  }
  const inverseOp: SceneOperation = {
    type: 'set_attrs',
    pageId: input.pageId,
    elementId: input.elementId,
    attrs: structuredClone(input.priorAttrs),
  }

  return {
    label: 'Edit element',
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)],
  }
}

// ---------------------------------------------------------------------------
// multi-select set_attrs  — N set_attrs ops, one undo step
// ---------------------------------------------------------------------------

/** Define an entry linking page and element IDs with current and prior scene attribute patches */
export interface MultiSetAttrsEntry {
  pageId: string
  elementId: string
  attrs: SceneAttrsPatch
  priorAttrs: SceneAttrsPatch
}

/** Build a scene command to set multiple attributes on elements across pages */
export function multiSetAttrsCommand(entries: MultiSetAttrsEntry[]): SceneCommand {
  if (entries.length === 0) throw new Error('multiSetAttrsCommand: entries must not be empty')

  const forwardOps: SceneOperation[] = entries.map((e) => ({
    type: 'set_attrs' as const,
    pageId: e.pageId,
    elementId: e.elementId,
    attrs: structuredClone(e.attrs),
  }))
  const inverseOps: SceneOperation[] = entries.map((e) => ({
    type: 'set_attrs' as const,
    pageId: e.pageId,
    elementId: e.elementId,
    attrs: structuredClone(e.priorAttrs),
  }))

  return {
    label: `Edit ${entries.length} elements`,
    execute: (state) => applyOps(state, forwardOps),
    undo: (state) => applyOps(state, inverseOps),
    operations: () => structuredClone(forwardOps),
    inverseOperations: () => structuredClone(inverseOps),
  }
}

// ---------------------------------------------------------------------------
// reorder_element
// ---------------------------------------------------------------------------

/** Define input parameters to reorder an element within a page */
export interface ReorderElementInput {
  pageId: string
  elementId: string
  toIndex: number
}

/** Resolve a command to reorder an element within a scene by moving it to a specified index */
export function reorderElementCommand(input: ReorderElementInput): SceneCommand {
  // Capture the element's current index at construction for the inverse
  let capturedFromIndex: number | null = null

  const forwardOp: SceneOperation = {
    type: 'reorder_element',
    pageId: input.pageId,
    elementId: input.elementId,
    toIndex: input.toIndex,
  }

  return {
    label: 'Reorder element',
    execute: (state) => {
      // Guard: on redo the element is already at toIndex, so we must not
      // overwrite the captured origin with the wrong position.
      if (capturedFromIndex === null) {
        const page = requirePage(state.document, input.pageId)
        const { index } = requireElement(page, input.elementId)
        capturedFromIndex = index
      }
      return applyOp(state, forwardOp)
    },
    undo: (state) => {
      if (capturedFromIndex === null) {
        throw new Error('reorderElementCommand: undo called before execute')
      }
      return applyOp(state, {
        type: 'reorder_element',
        pageId: input.pageId,
        elementId: input.elementId,
        toIndex: capturedFromIndex,
      })
    },
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => {
      if (capturedFromIndex === null) {
        throw new Error('reorderElementCommand: inverseOperations called before execute')
      }
      return [{
        type: 'reorder_element' as const,
        pageId: input.pageId,
        elementId: input.elementId,
        toIndex: capturedFromIndex,
      }]
    },
  }
}

// ---------------------------------------------------------------------------
// delete_element  /  inverse = add_element (full snapshot + index + parent)
// ---------------------------------------------------------------------------

/** Define input parameters required to delete an element from a specific page in a document */
export interface DeleteElementInput {
  document: SceneDocument
  pageId: string
  elementId: string
}

/** Resolve a command to delete an element from a specified page in the document */
export function deleteElementCommand(input: DeleteElementInput): SceneCommand {
  const page = requirePage(input.document, input.pageId)
  const { element, owner, index } = requireElement(page, input.elementId)
  const snapshot = structuredClone(element)

  // Determine parentGroupId by finding which group owns this element
  const parentGroupId = findParentGroupId(page, owner)

  const deleteOp: DeleteElementOperation = {
    type: 'delete_element',
    pageId: input.pageId,
    elementId: input.elementId,
  }
  const addOp: AddElementOperation = {
    type: 'add_element',
    pageId: input.pageId,
    element: snapshot,
    index,
    ...(parentGroupId !== undefined ? { parentGroupId } : {}),
  }

  return {
    label: `Delete ${element.kind}`,
    execute: (state) => {
      const next = applyOp(state, deleteOp)
      return {
        ...next,
        selectedElementIds: next.selectedElementIds.filter((id) => id !== input.elementId),
      }
    },
    undo: (state) => applyOp(state, addOp),
    operations: () => [structuredClone(deleteOp)],
    inverseOperations: () => [structuredClone(addOp)],
  }
}

function findParentGroupId(page: ScenePage, owner: SceneElement[]): string | undefined {
  if (owner === page.elements) return undefined
  // Walk the element tree looking for a group whose children === owner
  return findGroupWithChildren(page.elements, owner)
}

function findGroupWithChildren(elements: SceneElement[], target: SceneElement[]): string | undefined {
  for (const el of elements) {
    if (el.kind === 'group') {
      if (el.children === target) return el.id
      const found = findGroupWithChildren(el.children, target)
      if (found !== undefined) return found
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// group_elements  /  inverse = ungroup_element
// ---------------------------------------------------------------------------

/** Define input parameters for grouping elements within a scene document on a specific page */
export interface GroupElementsInput {
  document: SceneDocument
  pageId: string
  elementIds: string[]
  groupId: string
  name?: string
}

/** Create a command to group multiple elements into a single group within a scene */
export function groupElementsCommand(input: GroupElementsInput): SceneCommand {
  if (input.elementIds.length < 2) {
    throw new Error('groupElementsCommand: requires ≥ 2 elementIds')
  }

  const groupOp: SceneOperation = {
    type: 'group_elements',
    pageId: input.pageId,
    elementIds: input.elementIds.slice(),
    groupId: input.groupId,
    ...(input.name !== undefined ? { name: input.name } : {}),
  }
  const ungroupOp: SceneOperation = {
    type: 'ungroup_element',
    pageId: input.pageId,
    groupId: input.groupId,
  }

  return {
    label: `Group ${input.elementIds.length} elements`,
    execute: (state) => {
      const next = applyOp(state, groupOp)
      return {
        ...next,
        selectedElementIds: [input.groupId],
      }
    },
    undo: (state) => {
      const next = applyOp(state, ungroupOp)
      return { ...next, selectedElementIds: input.elementIds.slice() }
    },
    operations: () => [structuredClone(groupOp)],
    inverseOperations: () => [structuredClone(ungroupOp)],
  }
}

// ---------------------------------------------------------------------------
// ungroup_element  /  inverse = group_elements (re-using original ids)
// ---------------------------------------------------------------------------

/** Define input parameters required to ungroup elements within a specific page and group */
export interface UngroupElementInput {
  document: SceneDocument
  pageId: string
  groupId: string
}

/** Resolve a command to ungroup a group element into its child elements within a scene */
export function ungroupElementCommand(input: UngroupElementInput): SceneCommand {
  const page = requirePage(input.document, input.pageId)
  const { element } = requireElement(page, input.groupId)
  if (element.kind !== 'group') {
    throw new Error(`ungroupElementCommand: element ${input.groupId} is kind ${element.kind}, not group`)
  }
  const childIds = element.children.map((c) => c.id)

  const ungroupOp: SceneOperation = {
    type: 'ungroup_element',
    pageId: input.pageId,
    groupId: input.groupId,
  }
  const regroupOp: SceneOperation = {
    type: 'group_elements',
    pageId: input.pageId,
    elementIds: childIds,
    groupId: input.groupId,
    name: element.name,
  }

  return {
    label: `Ungroup`,
    execute: (state) => {
      const next = applyOp(state, ungroupOp)
      return { ...next, selectedElementIds: childIds.slice() }
    },
    undo: (state) => {
      const next = applyOp(state, regroupOp)
      return { ...next, selectedElementIds: [input.groupId] }
    },
    operations: () => [structuredClone(ungroupOp)],
    inverseOperations: () => [structuredClone(regroupOp)],
  }
}

// ---------------------------------------------------------------------------
// Page commands
// ---------------------------------------------------------------------------

/** Define input parameters for adding a new page with optional settings and position index */
export interface AddPageInput {
  pageId: string
  options?: import('../../design-canvas/model').NewPageOptions
  index?: number
}

/** Create a command to add a page with optional settings and index in the scene */
export function addPageCommand(input: AddPageInput): SceneCommand {
  const addOp: SceneOperation = {
    type: 'add_page',
    pageId: input.pageId,
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.index !== undefined ? { index: input.index } : {}),
  }
  const deleteOp: SceneOperation = { type: 'delete_page', pageId: input.pageId }

  return {
    label: 'Add page',
    execute: (state) => {
      const next = applyOp(state, addOp)
      return { ...next, activePageId: input.pageId }
    },
    undo: (state) => {
      const next = applyOp(state, deleteOp)
      // Switch active page to first surviving page if we deleted the active one
      const activeExists = next.document.pages.some((p) => p.id === next.activePageId)
      return activeExists ? next : { ...next, activePageId: next.document.pages[0]!.id }
    },
    operations: () => [structuredClone(addOp)],
    inverseOperations: () => [structuredClone(deleteOp)],
  }
}

/** Define input parameters required to duplicate a page within a scene document */
export interface DuplicatePageInput {
  document: SceneDocument
  sourcePageId: string
  /** Caller-minted id for the copy. */
  pageId: string
}

/** Create a command to duplicate a page and prepare its deletion operation in the scene */
export function duplicatePageCommand(input: DuplicatePageInput): SceneCommand {
  requirePage(input.document, input.sourcePageId)

  const dupOp: SceneOperation = {
    type: 'duplicate_page',
    sourcePageId: input.sourcePageId,
    pageId: input.pageId,
  }
  const deleteOp: SceneOperation = { type: 'delete_page', pageId: input.pageId }

  return {
    label: 'Duplicate page',
    execute: (state) => {
      const next = applyOp(state, dupOp)
      return { ...next, activePageId: input.pageId }
    },
    undo: (state) => {
      const next = applyOp(state, deleteOp)
      const activeExists = next.document.pages.some((p) => p.id === next.activePageId)
      return activeExists ? next : { ...next, activePageId: input.sourcePageId }
    },
    operations: () => [structuredClone(dupOp)],
    inverseOperations: () => [structuredClone(deleteOp)],
  }
}

/** Define input parameters required to delete a page from a scene document */
export interface DeletePageInput {
  document: SceneDocument
  pageId: string
}

/** Delete a page from a document ensuring it is not the last remaining page */
export function deletePageCommand(input: DeletePageInput): SceneCommand {
  if (input.document.pages.length <= 1) {
    throw new Error('deletePageCommand: cannot delete the last page')
  }
  const page = requirePage(input.document, input.pageId)
  const currentIndex = input.document.pages.findIndex((p) => p.id === input.pageId)
  const snapshot = structuredClone(page)

  const deleteOp: SceneOperation = { type: 'delete_page', pageId: input.pageId }

  // Undo uses add_page + per-element add_element to restore the full snapshot.
  // The page shell is added first, then elements are inserted in z-order so
  // subsequent undo/redo round-trips see the correct stack. This also makes
  // inverseOperations() safe to emit server-side: the server will see the same
  // full restore instead of a bare shell.
  function buildRestoreOps(): SceneOperation[] {
    const ops: SceneOperation[] = [
      {
        type: 'add_page',
        pageId: snapshot.id,
        options: {
          name: snapshot.name,
          width: snapshot.width,
          height: snapshot.height,
          background: snapshot.background,
        },
        index: currentIndex,
      },
    ]
    if (snapshot.bleed) {
      ops.push({ type: 'set_page_props', pageId: snapshot.id, bleed: snapshot.bleed })
    }
    if (snapshot.guides.vertical.length > 0 || snapshot.guides.horizontal.length > 0) {
      ops.push({ type: 'set_page_guides', pageId: snapshot.id, guides: snapshot.guides })
    }
    for (let i = 0; i < snapshot.elements.length; i++) {
      ops.push({
        type: 'add_element',
        pageId: snapshot.id,
        element: structuredClone(snapshot.elements[i]!),
        index: i,
      })
    }
    return ops
  }

  return {
    label: 'Delete page',
    execute: (state) => {
      const next = applyOp(state, deleteOp)
      const activeExists = next.document.pages.some((p) => p.id === next.activePageId)
      if (activeExists) return next
      const fallbackIndex = Math.min(currentIndex, next.document.pages.length - 1)
      return { ...next, activePageId: next.document.pages[fallbackIndex]!.id }
    },
    undo: (state) => {
      const next = applyOps(state, buildRestoreOps())
      return { ...next, activePageId: input.pageId }
    },
    operations: () => [structuredClone(deleteOp)],
    inverseOperations: () => buildRestoreOps(),
  }
}

/** Define input parameters to reorder a page by specifying its ID and target index */
export interface ReorderPageInput {
  pageId: string
  toIndex: number
}

/** Create a command to reorder a page to a specified index within a scene */
export function reorderPageCommand(input: ReorderPageInput): SceneCommand {
  let capturedFromIndex: number | null = null

  const forwardOp: SceneOperation = {
    type: 'reorder_page',
    pageId: input.pageId,
    toIndex: input.toIndex,
  }

  return {
    label: 'Reorder page',
    execute: (state) => {
      // Guard: on redo the page is already at toIndex; capture only on first execute.
      if (capturedFromIndex === null) {
        capturedFromIndex = state.document.pages.findIndex((p) => p.id === input.pageId)
        if (capturedFromIndex === -1) throw new Error(`reorderPageCommand: page ${input.pageId} not found`)
      }
      return applyOp(state, forwardOp)
    },
    undo: (state) => {
      if (capturedFromIndex === null) throw new Error('reorderPageCommand: undo called before execute')
      return applyOp(state, {
        type: 'reorder_page',
        pageId: input.pageId,
        toIndex: capturedFromIndex,
      })
    },
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => {
      if (capturedFromIndex === null) throw new Error('reorderPageCommand: inverseOperations called before execute')
      return [{ type: 'reorder_page' as const, pageId: input.pageId, toIndex: capturedFromIndex }]
    },
  }
}

/** Define input parameters for setting properties on a specific page within a scene document */
export interface SetPagePropsInput {
  document: SceneDocument
  pageId: string
  props: {
    name?: string
    width?: number
    height?: number
    background?: string
    bleed?: import('../../design-canvas/model').PageBleed | null
  }
}

/** Build a command to update page properties based on the provided input */
export function setPagePropsCommand(input: SetPagePropsInput): SceneCommand {
  const page = requirePage(input.document, input.pageId)
  const prior: NonNullable<import('../../design-canvas/operations').SetPagePropsOperation> = {
    type: 'set_page_props',
    pageId: input.pageId,
    ...(input.props.name !== undefined ? { name: page.name } : {}),
    ...(input.props.width !== undefined ? { width: page.width } : {}),
    ...(input.props.height !== undefined ? { height: page.height } : {}),
    ...(input.props.background !== undefined ? { background: page.background } : {}),
    ...(input.props.bleed !== undefined ? { bleed: page.bleed } : {}),
  }

  const forwardOp: SceneOperation = {
    type: 'set_page_props',
    pageId: input.pageId,
    ...input.props,
  }

  return {
    label: 'Edit page',
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, prior),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(prior) as SceneOperation],
  }
}

/** Define input parameters for setting guides on a specific page within a document */
export interface SetPageGuidesInput {
  document: SceneDocument
  pageId: string
  guides: import('../../design-canvas/model').PageGuides
}

/** Create a command to update page guides with undo support */
export function setPageGuidesCommand(input: SetPageGuidesInput): SceneCommand {
  const page = requirePage(input.document, input.pageId)
  const priorGuides = structuredClone(page.guides)

  const forwardOp: SceneOperation = {
    type: 'set_page_guides',
    pageId: input.pageId,
    guides: structuredClone(input.guides),
  }
  const inverseOp: SceneOperation = {
    type: 'set_page_guides',
    pageId: input.pageId,
    guides: priorGuides,
  }

  return {
    label: 'Edit guides',
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)],
  }
}

// ---------------------------------------------------------------------------
// bind_slot
// ---------------------------------------------------------------------------

/** Define input parameters for binding a slot within a scene document element */
export interface BindSlotInput {
  document: SceneDocument
  pageId: string
  elementId: string
  slot: string | null
}

/** Bind a slot to an element within a page and generate the corresponding scene command */
export function bindSlotCommand(input: BindSlotInput): SceneCommand {
  const page = requirePage(input.document, input.pageId)
  const { element } = requireElement(page, input.elementId)
  const priorSlot = element.slot ?? null

  const forwardOp: SceneOperation = {
    type: 'bind_slot',
    pageId: input.pageId,
    elementId: input.elementId,
    slot: input.slot,
  }
  const inverseOp: SceneOperation = {
    type: 'bind_slot',
    pageId: input.pageId,
    elementId: input.elementId,
    slot: priorSlot,
  }

  return {
    label: input.slot === null ? 'Unbind slot' : `Bind slot "${input.slot}"`,
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)],
  }
}

// ---------------------------------------------------------------------------
// set_document_title
// ---------------------------------------------------------------------------

/** Define input parameters for setting the title of a scene document */
export interface SetDocumentTitleInput {
  document: SceneDocument
  title: string
}

/** Resolve a command to rename a document title with undo and redo operations */
export function setDocumentTitleCommand(input: SetDocumentTitleInput): SceneCommand {
  const priorTitle = input.document.title

  const forwardOp: SceneOperation = { type: 'set_document_title', title: input.title }
  const inverseOp: SceneOperation = { type: 'set_document_title', title: priorTitle }

  return {
    label: `Rename document`,
    execute: (state) => applyOp(state, forwardOp),
    undo: (state) => applyOp(state, inverseOp),
    operations: () => [structuredClone(forwardOp)],
    inverseOperations: () => [structuredClone(inverseOp)],
  }
}
