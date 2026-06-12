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

import {
  assertColor,
  assertFinite,
  assertPositiveFinite,
  assertSceneMediaSrc,
  collectSlots,
  findElement,
  requireElement,
  requirePage,
} from './model'
import type { SceneDocument, SceneElement, SceneElementKind } from './model'
import type {
  AddElementOperation,
  ApplyDataOperation,
  BindSlotOperation,
  DeleteElementOperation,
  DeletePageOperation,
  DuplicatePageOperation,
  GroupElementsOperation,
  ReorderElementOperation,
  ReorderPageOperation,
  SceneAttrsPatch,
  SceneOperation,
  SetAttrsOperation,
  SetDocumentTitleOperation,
  SetPageGuidesOperation,
  SetPagePropsOperation,
  UngroupElementOperation,
} from './operations'

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function validateSceneOperations(document: SceneDocument, operations: SceneOperation[]): void {
  operations.forEach((operation, index) => {
    try {
      validateSceneOperation(document, operation)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`operation ${index + 1} (${operation.type}): ${reason}`)
    }
  })
}

export function validateSceneOperation(document: SceneDocument, operation: SceneOperation): void {
  switch (operation.type) {
    case 'add_element':
      return validateAddElement(document, operation)
    case 'set_attrs':
      return validateSetAttrs(document, operation)
    case 'reorder_element':
      return validateReorderElement(document, operation)
    case 'delete_element':
      return validateDeleteElement(document, operation)
    case 'group_elements':
      return validateGroupElements(document, operation)
    case 'ungroup_element':
      return validateUngroupElement(document, operation)
    case 'add_page':
      return validateAddPage(operation)
    case 'duplicate_page':
      return validateDuplicatePage(document, operation)
    case 'delete_page':
      return validateDeletePage(document, operation)
    case 'reorder_page':
      return validateReorderPage(document, operation)
    case 'set_page_props':
      return validateSetPageProps(document, operation)
    case 'set_page_guides':
      return validateSetPageGuides(document, operation)
    case 'bind_slot':
      return validateBindSlot(document, operation)
    case 'apply_data':
      return validateApplyData(document, operation)
    case 'set_document_title':
      return validateSetDocumentTitle(operation)
    default: {
      const unknown = operation as { type?: unknown }
      throw new Error(`unsupported operation type ${JSON.stringify(unknown.type)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Per-operation validators
// ---------------------------------------------------------------------------

function validateAddElement(document: SceneDocument, op: AddElementOperation): void {
  const page = requirePage(document, op.pageId)
  assertUniqueIdDocumentWide(document, op.element.id)
  if (op.parentGroupId !== undefined) {
    const { element: parent } = requireElement(page, op.parentGroupId)
    if (parent.kind !== 'group') {
      throw new Error(`parentGroupId "${op.parentGroupId}" is a ${parent.kind}, not a group`)
    }
  }
  if (op.index !== undefined) {
    const owner = op.parentGroupId
      ? (() => {
          const { element: g } = requireElement(page, op.parentGroupId)
          return (g as { kind: 'group'; children: SceneElement[] }).children
        })()
      : page.elements
    if (op.index < 0 || op.index > owner.length) {
      throw new Error(`index ${op.index} out of range (owner has ${owner.length} elements)`)
    }
  }
  validateElementAttrs(op.element.kind, op.element as unknown as SceneAttrsPatch, true)
}

function validateSetAttrs(document: SceneDocument, op: SetAttrsOperation): void {
  const page = requirePage(document, op.pageId)
  const { element } = requireElement(page, op.elementId)
  // A patch that ONLY unlocks is always permitted even on a locked element.
  const isUnlockOnly = Object.keys(op.attrs).length === 1 && op.attrs.locked === false
  if (element.locked && !isUnlockOnly) {
    throw new Error(`element "${op.elementId}" is locked; unlock it first (pass attrs: {locked: false}) before making other changes`)
  }
  validateElementAttrs(element.kind, op.attrs, false)
}

function validateReorderElement(document: SceneDocument, op: ReorderElementOperation): void {
  const page = requirePage(document, op.pageId)
  const { element, owner } = requireElement(page, op.elementId)
  if (element.locked) {
    throw new Error(`element "${op.elementId}" is locked; unlock it before reordering`)
  }
  if (op.toIndex < 0 || op.toIndex >= owner.length) {
    throw new Error(`toIndex ${op.toIndex} out of range (owner has ${owner.length} elements)`)
  }
}

function validateDeleteElement(document: SceneDocument, op: DeleteElementOperation): void {
  const page = requirePage(document, op.pageId)
  const { element } = requireElement(page, op.elementId)
  if (element.locked) {
    throw new Error(`element "${op.elementId}" is locked; unlock it before deleting`)
  }
}

function validateGroupElements(document: SceneDocument, op: GroupElementsOperation): void {
  if (op.elementIds.length < 2) {
    throw new Error(`group_elements requires ≥ 2 element ids (got ${op.elementIds.length})`)
  }
  assertUniqueIdDocumentWide(document, op.groupId)
  const page = requirePage(document, op.pageId)
  // Resolve all targets and check siblings + locked
  const owners = op.elementIds.map((id) => {
    const { element, owner } = requireElement(page, id)
    if (element.locked) throw new Error(`element "${id}" is locked; unlock before grouping`)
    return owner
  })
  // All must share the exact same owner array reference (sibling check)
  const firstOwner = owners[0]
  for (let i = 1; i < owners.length; i++) {
    if (owners[i] !== firstOwner) {
      throw new Error(`elements are not siblings — they must all share the same parent (page root or one group)`)
    }
  }
}

function validateUngroupElement(document: SceneDocument, op: UngroupElementOperation): void {
  const page = requirePage(document, op.pageId)
  const { element } = requireElement(page, op.groupId)
  if (element.kind !== 'group') {
    throw new Error(`element "${op.groupId}" is a ${element.kind}, not a group`)
  }
}

function validateAddPage(op: { options?: { width?: number; height?: number; background?: string } }): void {
  const opts = op.options
  if (!opts) return
  if (opts.width !== undefined) assertPositiveFinite(opts.width, 'page width')
  if (opts.height !== undefined) assertPositiveFinite(opts.height, 'page height')
  if (opts.background !== undefined) assertColor(opts.background, 'page background')
}

function validateDuplicatePage(document: SceneDocument, op: DuplicatePageOperation): void {
  requirePage(document, op.sourcePageId)
  const existing = document.pages.find((p) => p.id === op.pageId)
  if (existing) throw new Error(`pageId "${op.pageId}" already exists in the document`)
}

function validateDeletePage(document: SceneDocument, op: DeletePageOperation): void {
  requirePage(document, op.pageId)
  if (document.pages.length === 1) {
    throw new Error('cannot delete the last remaining page')
  }
}

function validateReorderPage(document: SceneDocument, op: ReorderPageOperation): void {
  requirePage(document, op.pageId)
  if (op.toIndex < 0 || op.toIndex >= document.pages.length) {
    throw new Error(`toIndex ${op.toIndex} out of range (document has ${document.pages.length} pages)`)
  }
}

function validateSetPageProps(document: SceneDocument, op: SetPagePropsOperation): void {
  requirePage(document, op.pageId)
  if (op.width !== undefined) assertPositiveFinite(op.width, 'page width')
  if (op.height !== undefined) assertPositiveFinite(op.height, 'page height')
  if (op.background !== undefined) assertColor(op.background, 'page background')
  if (op.bleed != null) {
    assertNonNegativeFinite(op.bleed.top, 'bleed.top')
    assertNonNegativeFinite(op.bleed.right, 'bleed.right')
    assertNonNegativeFinite(op.bleed.bottom, 'bleed.bottom')
    assertNonNegativeFinite(op.bleed.left, 'bleed.left')
  }
}

function validateSetPageGuides(document: SceneDocument, op: SetPageGuidesOperation): void {
  requirePage(document, op.pageId)
  for (const pos of op.guides.vertical) {
    if (!Number.isFinite(pos)) throw new Error(`guide position ${pos} is not finite`)
  }
  for (const pos of op.guides.horizontal) {
    if (!Number.isFinite(pos)) throw new Error(`guide position ${pos} is not finite`)
  }
}

function validateBindSlot(document: SceneDocument, op: BindSlotOperation): void {
  const page = requirePage(document, op.pageId)
  requireElement(page, op.elementId)
  if (op.slot === null) return
  // Slot names must be unique document-wide; a re-bind of the SAME element to
  // its own current slot name is fine (idempotent) — collectSlots throws on
  // duplicates owned by DIFFERENT elements, so we check manually.
  for (const p of document.pages) {
    const stack = [...p.elements]
    while (stack.length > 0) {
      const el = stack.pop()!
      if (el.slot === op.slot && el.id !== op.elementId) {
        throw new Error(`slot "${op.slot}" is already bound to element "${el.id}" on page "${p.id}"`)
      }
      if (el.kind === 'group') stack.push(...el.children)
    }
  }
}

function validateApplyData(document: SceneDocument, op: ApplyDataOperation): void {
  // Build the slot map; collectSlots throws on internal duplicates
  const slots = collectSlots(document)
  for (const [slotName, value] of Object.entries(op.bindings)) {
    const slot = slots.get(slotName)
    if (!slot) {
      throw new Error(`slot "${slotName}" does not exist in the document`)
    }
    validateSlotValue(slotName, slot.kind, value)
  }
}

function validateSetDocumentTitle(op: SetDocumentTitleOperation): void {
  if (op.title.trim().length === 0) throw new Error('title must be non-empty')
}

// ---------------------------------------------------------------------------
// Element attr validation
// ---------------------------------------------------------------------------

/** Attributes present on EVERY element kind (SceneElementBase minus id/kind). */
const BASE_ATTRS = new Set([
  'name', 'x', 'y', 'rotation', 'opacity', 'locked', 'visible', 'slot',
])

/** Per-kind allowed attributes (beyond base). */
const KIND_ATTRS: Record<SceneElementKind, Set<string>> = {
  rect:    new Set(['width', 'height', 'fill', 'stroke', 'strokeWidth', 'cornerRadius']),
  ellipse: new Set(['width', 'height', 'fill', 'stroke', 'strokeWidth']),
  line:    new Set(['points', 'stroke', 'strokeWidth', 'dash']),
  text:    new Set(['text', 'width', 'fontFamily', 'fontSize', 'fontStyle', 'fill', 'align', 'lineHeight', 'letterSpacing']),
  image:   new Set(['width', 'height', 'src', 'fit']),
  video:   new Set(['width', 'height', 'src', 'posterSrc']),
  group:   new Set([]),
}

const FONT_STYLES = new Set(['normal', 'bold', 'italic', 'bold italic'])
const ALIGN_VALUES = new Set(['left', 'center', 'right'])
const FIT_VALUES = new Set(['fill', 'cover', 'contain'])

/**
 * Validates attribute patches (or full element attrs for add_element).
 * `isConstruction` = true when validating a new element (required fields
 * must be present); false for a partial set_attrs patch.
 */
function validateElementAttrs(
  kind: SceneElementKind,
  attrs: SceneAttrsPatch,
  isConstruction: boolean,
): void {
  const allowed = KIND_ATTRS[kind]

  // Foreign attribute check: reject any key that is neither base nor kind-specific.
  for (const key of Object.keys(attrs)) {
    if (key === 'id' || key === 'kind' || key === 'children') continue
    if (!BASE_ATTRS.has(key) && !allowed.has(key)) {
      throw new Error(`attribute "${key}" is not valid for a ${kind} element`)
    }
  }

  // Base attribute validation
  if (attrs.opacity !== undefined) {
    if (typeof attrs.opacity !== 'number' || !Number.isFinite(attrs.opacity) || attrs.opacity < 0 || attrs.opacity > 1) {
      throw new Error('opacity must be a number in [0, 1]')
    }
  }
  if (attrs.x !== undefined) assertFinite(attrs.x, 'x')
  if (attrs.y !== undefined) assertFinite(attrs.y, 'y')
  if (attrs.rotation !== undefined) assertFinite(attrs.rotation, 'rotation')

  // Kind-specific attribute validation
  switch (kind) {
    case 'rect':
    case 'ellipse':
    case 'image':
    case 'video':
      if (attrs.width !== undefined) assertPositiveFinite(attrs.width, 'width')
      if (attrs.height !== undefined) assertPositiveFinite(attrs.height, 'height')
      break
    case 'text':
      if (attrs.width !== undefined) assertPositiveFinite(attrs.width, 'width')
      if (attrs.fontSize !== undefined) assertPositiveFinite(attrs.fontSize, 'fontSize')
      if (attrs.lineHeight !== undefined) {
        if (typeof attrs.lineHeight !== 'number' || !Number.isFinite(attrs.lineHeight) || attrs.lineHeight <= 0) {
          throw new Error('lineHeight must be a positive finite number')
        }
      }
      if (attrs.fontStyle !== undefined && !FONT_STYLES.has(attrs.fontStyle)) {
        throw new Error(`fontStyle must be one of: ${[...FONT_STYLES].join(', ')}`)
      }
      if (attrs.align !== undefined && !ALIGN_VALUES.has(attrs.align)) {
        throw new Error(`align must be one of: ${[...ALIGN_VALUES].join(', ')}`)
      }
      break
    case 'line':
      if (attrs.points !== undefined) {
        if (!Array.isArray(attrs.points) || attrs.points.length < 4 || attrs.points.length % 2 !== 0) {
          throw new Error('points must be an even-length array with at least 4 numbers (2 points)')
        }
        for (let i = 0; i < attrs.points.length; i++) {
          if (!Number.isFinite(attrs.points[i])) {
            throw new Error(`points[${i}] is not finite`)
          }
        }
      }
      if (attrs.strokeWidth !== undefined) assertPositiveFinite(attrs.strokeWidth, 'strokeWidth')
      break
    case 'group':
      // Group geometry derives from children; no width/height attrs.
      break
  }

  // Color validation for fill/stroke
  if (attrs.fill !== undefined) assertColor(attrs.fill, 'fill')
  if (attrs.stroke !== undefined) assertColor(attrs.stroke, 'stroke')
  if (attrs.strokeWidth !== undefined && kind !== 'line') {
    assertPositiveFinite(attrs.strokeWidth, 'strokeWidth')
  }

  // Image/video src
  if (attrs.src !== undefined) assertSceneMediaSrc(attrs.src, 'src')
  if ((attrs as { posterSrc?: string }).posterSrc !== undefined) {
    assertSceneMediaSrc((attrs as { posterSrc: string }).posterSrc, 'posterSrc')
  }

  // fit
  if (attrs.fit !== undefined && !FIT_VALUES.has(attrs.fit)) {
    throw new Error(`fit must be one of: ${[...FIT_VALUES].join(', ')}`)
  }

  // Construction-time required-field checks
  if (isConstruction) {
    validateRequiredConstructionAttrs(kind, attrs)
  }
}

function validateRequiredConstructionAttrs(kind: SceneElementKind, attrs: SceneAttrsPatch): void {
  switch (kind) {
    case 'rect':
      requireAttrPresent(attrs, 'width', kind)
      requireAttrPresent(attrs, 'height', kind)
      requireAttrPresent(attrs, 'fill', kind)
      break
    case 'ellipse':
      requireAttrPresent(attrs, 'width', kind)
      requireAttrPresent(attrs, 'height', kind)
      requireAttrPresent(attrs, 'fill', kind)
      break
    case 'line':
      requireAttrPresent(attrs, 'points', kind)
      requireAttrPresent(attrs, 'stroke', kind)
      requireAttrPresent(attrs, 'strokeWidth', kind)
      break
    case 'text':
      requireAttrPresent(attrs, 'text', kind)
      requireAttrPresent(attrs, 'width', kind)
      requireAttrPresent(attrs, 'fontFamily', kind)
      requireAttrPresent(attrs, 'fontSize', kind)
      requireAttrPresent(attrs, 'fontStyle', kind)
      requireAttrPresent(attrs, 'fill', kind)
      requireAttrPresent(attrs, 'align', kind)
      requireAttrPresent(attrs, 'lineHeight', kind)
      requireAttrPresent(attrs, 'letterSpacing', kind)
      break
    case 'image':
      requireAttrPresent(attrs, 'width', kind)
      requireAttrPresent(attrs, 'height', kind)
      requireAttrPresent(attrs, 'src', kind)
      requireAttrPresent(attrs, 'fit', kind)
      break
    case 'video':
      requireAttrPresent(attrs, 'width', kind)
      requireAttrPresent(attrs, 'height', kind)
      requireAttrPresent(attrs, 'src', kind)
      break
    case 'group':
      // Groups are created empty; children are added separately.
      break
  }
}

function requireAttrPresent(attrs: SceneAttrsPatch, key: string, kind: SceneElementKind): void {
  if ((attrs as Record<string, unknown>)[key] === undefined) {
    throw new Error(`${key} is required when constructing a ${kind} element`)
  }
}

// ---------------------------------------------------------------------------
// Slot value typing (apply_data)
// ---------------------------------------------------------------------------

/**
 * Validates that a slot binding value matches the slot element's kind.
 * text → any string; image/video → media src; rect/ellipse/line/group → color.
 */
export function validateSlotValue(slotName: string, elementKind: SceneElementKind, value: string): void {
  switch (elementKind) {
    case 'text':
      // Any string is valid for a text slot.
      return
    case 'image':
    case 'video':
      try {
        assertSceneMediaSrc(value, `slot "${slotName}" value`)
      } catch (e) {
        throw new Error(
          `slot "${slotName}" is bound to a ${elementKind} element — value must be an http(s) URL or a rooted /api/ path (got "${value}")`,
        )
      }
      return
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'group':
      try {
        assertColor(value, `slot "${slotName}" value`)
      } catch {
        throw new Error(
          `slot "${slotName}" is bound to a ${elementKind} element — value must be a color (hex/rgb(a)/transparent) for fill/stroke recolor (got "${value}")`,
        )
      }
      return
  }
}

// ---------------------------------------------------------------------------
// Document-wide uniqueness
// ---------------------------------------------------------------------------

function assertUniqueIdDocumentWide(document: SceneDocument, id: string): void {
  for (const page of document.pages) {
    if (page.id === id) throw new Error(`id "${id}" is already used by a page`)
    const stack = [...page.elements]
    while (stack.length > 0) {
      const el = stack.pop()!
      if (el.id === id) throw new Error(`id "${id}" is already used by element on page "${page.id}"`)
      if (el.kind === 'group') stack.push(...el.children)
    }
  }
}

// ---------------------------------------------------------------------------
// Internal guards
// ---------------------------------------------------------------------------

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`)
  }
}
