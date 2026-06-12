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

import {
  assertColor,
  assertSceneMediaSrc,
  collectSlots,
  createPage,
  elementAabb,
  requireElement,
  requirePage,
} from './model'
import type {
  GroupElement,
  NewPageOptions,
  SceneDocument,
  SceneElement,
  ScenePage,
} from './model'
import type {
  AddElementOperation,
  AddPageOperation,
  ApplyDataOperation,
  BindSlotOperation,
  DeleteElementOperation,
  DeletePageOperation,
  DuplicatePageOperation,
  GroupElementsOperation,
  ReorderElementOperation,
  ReorderPageOperation,
  SceneOperation,
  ScenePlan,
  SetAttrsOperation,
  SetDocumentTitleOperation,
  SetPageGuidesOperation,
  SetPagePropsOperation,
  UngroupElementOperation,
} from './operations'
import type { NewSceneDecision, SceneDocumentRecord, SceneStore } from './store'
import { validateSceneOperations } from './validate'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type SceneApplyResult =
  | { kind: 'element'; pageId: string; element: SceneElement }
  | { kind: 'page'; page: ScenePage }
  | { kind: 'document' }

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ApplySceneOptions {
  /**
   * Provides fresh ids when duplicate_page re-mints element ids. Never called
   * by any other operation. Counter-based in tests; crypto.randomUUID in
   * production (wrapped so `mintId()` has no arguments, matching this signature).
   */
  mintId: () => string
}

// ---------------------------------------------------------------------------
// Public: pure apply
// ---------------------------------------------------------------------------

/** Full form: returns the new document AND per-op results. `mintId` must be
 *  provided when any operation in the list may be `duplicate_page` (which
 *  re-mints element ids); for all other operation types it is never called. */
export function applySceneOperations(
  document: SceneDocument,
  operations: SceneOperation[],
  options: ApplySceneOptions,
): { document: SceneDocument; results: SceneApplyResult[] }

/** Convenience 2-arg form: returns the new document directly. Uses a
 *  monotonic counter as the mintId so `duplicate_page` never collides within
 *  a single call (suitable for editor-local optimistic state; server will
 *  re-mint on persist). */
export function applySceneOperations(
  document: SceneDocument,
  operations: SceneOperation[],
): SceneDocument

export function applySceneOperations(
  document: SceneDocument,
  operations: SceneOperation[],
  options?: ApplySceneOptions,
): { document: SceneDocument; results: SceneApplyResult[] } | SceneDocument {
  const opts = options ?? { mintId: makeCounter() }
  const doc = deepCloneDocument(document)
  const results: SceneApplyResult[] = []
  for (const operation of operations) {
    results.push(applyOneOperation(doc, operation, opts))
  }
  return options !== undefined ? { document: doc, results } : doc
}

/** Apply a single operation to a document and return the new document.
 *  Equivalent to `applySceneOperations(doc, [op])` but returns `SceneDocument`
 *  directly — the common case in editor commands and tests. */
export function applySceneOperation(
  document: SceneDocument,
  operation: SceneOperation,
): SceneDocument {
  return applySceneOperations(document, [operation])
}

function makeCounter(): () => string {
  let n = 0
  return () => `minted-${(n += 1)}`
}

// ---------------------------------------------------------------------------
// Public: store-integrated helper
// ---------------------------------------------------------------------------

/** Detects the stale-revision sentinel thrown by drizzle-store. The store
 *  throws a plain Error whose message contains "stale rev" — no custom class
 *  is needed because the store contract documents exactly this phrase. */
function isStaleRevError(err: unknown): boolean {
  return err instanceof Error && /stale rev/i.test(err.message)
}

export async function storeApplyScenePlan(
  store: SceneStore,
  plan: ScenePlan,
  opts: { actorKind: NewSceneDecision['kind']; mintId: () => string },
): Promise<{ record: SceneDocumentRecord; results: SceneApplyResult[] }> {
  let { document, rev } = await store.getDocument()

  validateSceneOperations(document, plan.operations)
  let applied = applySceneOperations(document, plan.operations, { mintId: opts.mintId })

  let record: SceneDocumentRecord
  try {
    record = await store.saveDocument(applied.document, rev)
  } catch (firstError) {
    // Only retry for stale-rev conflicts. Any other error (network, constraint,
    // permissions) is a hard failure — retrying would risk a double-apply if
    // the first save actually succeeded but the acknowledgement was lost.
    if (!isStaleRevError(firstError)) throw firstError
    const refreshed = await store.getDocument()
    validateSceneOperations(refreshed.document, plan.operations)
    applied = applySceneOperations(refreshed.document, plan.operations, { mintId: opts.mintId })
    try {
      record = await store.saveDocument(applied.document, refreshed.rev)
    } catch (secondError) {
      const reason = secondError instanceof Error ? secondError.message : String(secondError)
      throw new Error(`storeApplyScenePlan: stale rev persists after retry — ${reason}`)
    }
  }

  const opTypeCounts: Record<string, number> = {}
  for (const op of plan.operations) {
    opTypeCounts[op.type] = (opTypeCounts[op.type] ?? 0) + 1
  }

  await store.recordDecision({
    kind: opts.actorKind,
    instruction: plan.summary,
    metadata: { opTypeCounts, operationCount: plan.operations.length },
  })

  return { record, results: applied.results }
}

// ---------------------------------------------------------------------------
// Per-operation dispatch (mutates cloned doc in-place)
// ---------------------------------------------------------------------------

function applyOneOperation(
  doc: SceneDocument,
  operation: SceneOperation,
  options: ApplySceneOptions,
): SceneApplyResult {
  switch (operation.type) {
    case 'add_element':
      return applyAddElement(doc, operation)
    case 'set_attrs':
      return applySetAttrs(doc, operation)
    case 'reorder_element':
      return applyReorderElement(doc, operation)
    case 'delete_element':
      return applyDeleteElement(doc, operation)
    case 'group_elements':
      return applyGroupElements(doc, operation)
    case 'ungroup_element':
      return applyUngroupElement(doc, operation)
    case 'add_page':
      return applyAddPage(doc, operation)
    case 'duplicate_page':
      return applyDuplicatePage(doc, operation, options)
    case 'delete_page':
      return applyDeletePage(doc, operation)
    case 'reorder_page':
      return applyReorderPage(doc, operation)
    case 'set_page_props':
      return applySetPageProps(doc, operation)
    case 'set_page_guides':
      return applySetPageGuides(doc, operation)
    case 'bind_slot':
      return applyBindSlot(doc, operation)
    case 'apply_data':
      return applyApplyData(doc, operation)
    case 'set_document_title':
      return applySetDocumentTitle(doc, operation)
  }
}

// ---------------------------------------------------------------------------
// Operation implementations (all mutate the deep-cloned doc)
// ---------------------------------------------------------------------------

function applyAddElement(doc: SceneDocument, op: AddElementOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  const owner: SceneElement[] = op.parentGroupId !== undefined
    ? (() => {
        const { element: g } = requireElement(page, op.parentGroupId)
        return (g as GroupElement).children
      })()
    : page.elements
  const index = op.index !== undefined ? op.index : owner.length
  owner.splice(index, 0, op.element)
  return { kind: 'element', pageId: op.pageId, element: op.element }
}

function applySetAttrs(doc: SceneDocument, op: SetAttrsOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  const { element, owner, index } = requireElement(page, op.elementId)
  const patched = { ...element, ...op.attrs } as SceneElement
  owner[index] = patched
  return { kind: 'element', pageId: op.pageId, element: patched }
}

function applyReorderElement(doc: SceneDocument, op: ReorderElementOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  const { element, owner, index } = requireElement(page, op.elementId)
  owner.splice(index, 1)
  owner.splice(op.toIndex, 0, element)
  return { kind: 'element', pageId: op.pageId, element }
}

function applyDeleteElement(doc: SceneDocument, op: DeleteElementOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  const { element, owner, index } = requireElement(page, op.elementId)
  owner.splice(index, 1)
  return { kind: 'element', pageId: op.pageId, element }
}

function applyGroupElements(doc: SceneDocument, op: GroupElementsOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  const members = op.elementIds.map((id) => requireElement(page, id))

  // Group origin = min AABB corner of all members in the owner coordinate space.
  let minX = Infinity, minY = Infinity
  for (const { element } of members) {
    const aabb = elementAabb(element)
    if (aabb.x < minX) minX = aabb.x
    if (aabb.y < minY) minY = aabb.y
  }

  const owner = members[0]!.owner
  // Sort ascending by index to preserve z-order in children array.
  const sortedByIndex = [...members].sort((a, b) => a.index - b.index)

  // Children retain rotation; x/y rebased to group-local space.
  const children: SceneElement[] = sortedByIndex.map(({ element }) => ({
    ...element,
    x: element.x - minX,
    y: element.y - minY,
  }))

  // Remove in reverse order to avoid index drift.
  for (const { index } of [...sortedByIndex].reverse()) {
    owner.splice(index, 1)
  }

  // Group inserted at the slot vacated by the bottommost former member.
  const insertAt = sortedByIndex[0]!.index

  const group: GroupElement = {
    id: op.groupId,
    kind: 'group',
    name: op.name ?? 'Group',
    x: minX,
    y: minY,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    children,
  }

  owner.splice(insertAt, 0, group)
  return { kind: 'element', pageId: op.pageId, element: group }
}

function applyUngroupElement(doc: SceneDocument, op: UngroupElementOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  const { element: groupEl, owner, index: groupIndex } = requireElement(page, op.groupId)
  const group = groupEl as GroupElement

  // Re-absolutize: child.x/y += group.x/y; rotation unchanged.
  const promoted: SceneElement[] = group.children.map((child) => ({
    ...child,
    x: child.x + group.x,
    y: child.y + group.y,
  }))

  owner.splice(groupIndex, 1, ...promoted)
  return { kind: 'element', pageId: op.pageId, element: groupEl }
}

function applyAddPage(doc: SceneDocument, op: AddPageOperation): SceneApplyResult {
  const opts: NewPageOptions = op.options ?? {}
  const page = createPage(opts, op.pageId)
  const index = op.index !== undefined ? op.index : doc.pages.length
  doc.pages.splice(index, 0, page)
  return { kind: 'page', page }
}

function applyDuplicatePage(
  doc: SceneDocument,
  op: DuplicatePageOperation,
  options: ApplySceneOptions,
): SceneApplyResult {
  const source = requirePage(doc, op.sourcePageId)
  const copy: ScenePage = JSON.parse(JSON.stringify(source)) as ScenePage
  copy.id = op.pageId
  // Re-mint all element ids so the copy has no id collisions with the source.
  remintElementIds(copy.elements, options.mintId)
  doc.pages.push(copy)
  return { kind: 'page', page: copy }
}

function remintElementIds(elements: SceneElement[], mintId: () => string): void {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!
    const newEl: SceneElement = { ...el, id: mintId() }
    if (newEl.kind === 'group') {
      remintElementIds((newEl as GroupElement).children, mintId)
    }
    elements[i] = newEl
  }
}

function applyDeletePage(doc: SceneDocument, op: DeletePageOperation): SceneApplyResult {
  if (doc.pages.length <= 1) throw new Error('delete_page: cannot delete the last page')
  const index = doc.pages.findIndex((p) => p.id === op.pageId)
  if (index < 0) throw new Error(`page ${op.pageId} not found`)
  const [page] = doc.pages.splice(index, 1) as [ScenePage]
  return { kind: 'page', page }
}

function applyReorderPage(doc: SceneDocument, op: ReorderPageOperation): SceneApplyResult {
  const index = doc.pages.findIndex((p) => p.id === op.pageId)
  if (index < 0) throw new Error(`page ${op.pageId} not found`)
  const [page] = doc.pages.splice(index, 1) as [ScenePage]
  doc.pages.splice(op.toIndex, 0, page)
  return { kind: 'page', page }
}

function applySetPageProps(doc: SceneDocument, op: SetPagePropsOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  if (op.name !== undefined) page.name = op.name
  if (op.width !== undefined) page.width = op.width
  if (op.height !== undefined) page.height = op.height
  if (op.background !== undefined) page.background = op.background
  if (op.bleed !== undefined) page.bleed = op.bleed
  return { kind: 'page', page }
}

function applySetPageGuides(doc: SceneDocument, op: SetPageGuidesOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  page.guides = op.guides
  return { kind: 'page', page }
}

function applyBindSlot(doc: SceneDocument, op: BindSlotOperation): SceneApplyResult {
  const page = requirePage(doc, op.pageId)
  const { element, owner, index } = requireElement(page, op.elementId)
  const patched: SceneElement = op.slot === null ? omitSlot(element) : { ...element, slot: op.slot }
  owner[index] = patched
  return { kind: 'element', pageId: op.pageId, element: patched }
}

function omitSlot(element: SceneElement): SceneElement {
  const { slot: _slot, ...rest } = element as SceneElement & { slot?: string }
  return rest as SceneElement
}

function applyApplyData(doc: SceneDocument, op: ApplyDataOperation): SceneApplyResult {
  const slots = collectSlots(doc)
  for (const [slotName, value] of Object.entries(op.bindings)) {
    const slot = slots.get(slotName)
    if (!slot) throw new Error(`slot "${slotName}" not found in document`)
    const page = requirePage(doc, slot.pageId)
    const { element, owner, index } = requireElement(page, slot.elementId)
    owner[index] = applySlotValue(element, value)
  }
  return { kind: 'document' }
}

function applySlotValue(element: SceneElement, value: string): SceneElement {
  switch (element.kind) {
    case 'text':
      return { ...element, text: value }
    case 'image':
    case 'video':
      assertSceneMediaSrc(value, 'slot value')
      return { ...element, src: value }
    case 'rect':
    case 'ellipse':
      assertColor(value, 'slot value')
      return { ...element, fill: value }
    case 'line':
      assertColor(value, 'slot value')
      return { ...element, stroke: value }
    case 'group':
      // Group recolor: propagate fill/stroke to children that carry the property.
      assertColor(value, 'slot value')
      return recolorGroupChildren(element as GroupElement, value)
  }
}

function recolorGroupChildren(group: GroupElement, color: string): GroupElement {
  const children = group.children.map((child): SceneElement => {
    switch (child.kind) {
      case 'rect':
      case 'ellipse':
        return { ...child, fill: color }
      case 'line':
        return { ...child, stroke: color }
      case 'text':
        return { ...child, fill: color }
      case 'image':
      case 'video':
        return child
      case 'group':
        return recolorGroupChildren(child, color)
    }
  })
  return { ...group, children }
}

function applySetDocumentTitle(doc: SceneDocument, op: SetDocumentTitleOperation): SceneApplyResult {
  doc.title = op.title
  return { kind: 'document' }
}

// ---------------------------------------------------------------------------
// Deep clone
// ---------------------------------------------------------------------------

function deepCloneDocument(document: SceneDocument): SceneDocument {
  return JSON.parse(JSON.stringify(document)) as SceneDocument
}
