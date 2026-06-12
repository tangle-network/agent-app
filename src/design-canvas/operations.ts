/**
 * The design-canvas operation union — the ONE mutation vocabulary shared by
 * the editor's command stack (human edits, undo/redo), the MCP tool
 * dispatcher (agent edits), and programmatic automation (template
 * instantiation, data sync). Every state change the editor can express is an
 * operation here; anything not expressible here does not happen to a
 * document. That closure is the automation contract: replaying a decision
 * log reproduces the document.
 *
 * Attribute patches are validated per element kind in ./validate before
 * ./apply mutates the document; both run server-side on every path.
 */

import type { NewPageOptions, PageBleed, PageGuides, SceneElement } from './model'

/** Per-kind attribute patch. `kind` is immutable after creation; ids are
 *  immutable always. Validation rejects attrs foreign to the target's kind. */
export type SceneAttrsPatch = Partial<Omit<SceneElement, 'id' | 'kind' | 'children'>> & {
  text?: string
  width?: number
  height?: number
  points?: number[]
  fill?: string
  stroke?: string
  strokeWidth?: number
  cornerRadius?: number
  dash?: number[]
  fontFamily?: string
  fontSize?: number
  fontStyle?: 'normal' | 'bold' | 'italic' | 'bold italic'
  align?: 'left' | 'center' | 'right'
  lineHeight?: number
  letterSpacing?: number
  src?: string
  posterSrc?: string
  fit?: 'fill' | 'cover' | 'contain'
}

export interface AddElementOperation {
  type: 'add_element'
  pageId: string
  /** Complete element including caller-minted id (reconciled like sequences
   *  clips when the server re-mints). */
  element: SceneElement
  /** Insertion z-index; omitted → top. */
  index?: number
  /** Parent group; omitted → page root. */
  parentGroupId?: string
}

export interface SetAttrsOperation {
  type: 'set_attrs'
  pageId: string
  elementId: string
  attrs: SceneAttrsPatch
}

export interface ReorderElementOperation {
  type: 'reorder_element'
  pageId: string
  elementId: string
  /** Target index within the element's CURRENT owner (page root or group). */
  toIndex: number
}

export interface DeleteElementOperation {
  type: 'delete_element'
  pageId: string
  elementId: string
}

export interface GroupElementsOperation {
  type: 'group_elements'
  pageId: string
  /** ≥ 2 sibling elements (same owner); grouped in their current z-order. */
  elementIds: string[]
  /** Caller-minted id for the new group. */
  groupId: string
  name?: string
}

export interface UngroupElementOperation {
  type: 'ungroup_element'
  pageId: string
  groupId: string
}

export interface AddPageOperation {
  type: 'add_page'
  /** Caller-minted page id. */
  pageId: string
  options?: NewPageOptions
  /** Position in the page list; omitted → end. */
  index?: number
}

export interface DuplicatePageOperation {
  type: 'duplicate_page'
  sourcePageId: string
  /** Caller-minted id for the copy; element ids are re-minted server-side. */
  pageId: string
}

export interface DeletePageOperation {
  type: 'delete_page'
  pageId: string
}

export interface ReorderPageOperation {
  type: 'reorder_page'
  pageId: string
  toIndex: number
}

export interface SetPagePropsOperation {
  type: 'set_page_props'
  pageId: string
  name?: string
  width?: number
  height?: number
  background?: string
  /** null clears bleed; omitted leaves unchanged. */
  bleed?: PageBleed | null
}

export interface SetPageGuidesOperation {
  type: 'set_page_guides'
  pageId: string
  guides: PageGuides
}

export interface BindSlotOperation {
  type: 'bind_slot'
  pageId: string
  elementId: string
  /** null unbinds. Slot names are unique document-wide. */
  slot: string | null
}

/** Fill slots with data — text slots take strings, image/video slots take
 *  src URLs. Unknown slot names throw; partial application is allowed. */
export interface ApplyDataOperation {
  type: 'apply_data'
  bindings: Record<string, string>
}

export interface SetDocumentTitleOperation {
  type: 'set_document_title'
  title: string
}

export type SceneOperation =
  | AddElementOperation
  | SetAttrsOperation
  | ReorderElementOperation
  | DeleteElementOperation
  | GroupElementsOperation
  | UngroupElementOperation
  | AddPageOperation
  | DuplicatePageOperation
  | DeletePageOperation
  | ReorderPageOperation
  | SetPagePropsOperation
  | SetPageGuidesOperation
  | BindSlotOperation
  | ApplyDataOperation
  | SetDocumentTitleOperation

export interface ScenePlan {
  summary: string
  operations: SceneOperation[]
}

export type SceneOperationType = SceneOperation['type']

export const SCENE_OPERATION_TYPES: readonly SceneOperationType[] = [
  'add_element',
  'set_attrs',
  'reorder_element',
  'delete_element',
  'group_elements',
  'ungroup_element',
  'add_page',
  'duplicate_page',
  'delete_page',
  'reorder_page',
  'set_page_props',
  'set_page_guides',
  'bind_slot',
  'apply_data',
  'set_document_title',
] as const
