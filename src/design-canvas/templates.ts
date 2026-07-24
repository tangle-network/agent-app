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

import {
  SCENE_SCHEMA_VERSION,
  type SceneDocument,
  type SceneElement,
  type ScenePage,
  type SceneElementKind,
  collectSlots,
} from './model'

// ---------------------------------------------------------------------------
// Slot surface
// ---------------------------------------------------------------------------

/** Define allowed string literals representing different slot fill kinds */
export type SlotFillKind = 'text' | 'src' | 'color'

/** Define a slot template specifying its name, page, element, and fill characteristics */
export interface TemplateSlot {
  name: string
  pageId: string
  elementId: string
  elementKind: SceneElementKind
  fillKind: SlotFillKind
}

/**
 * Wraps `collectSlots` with kind-aware fill typing so callers know WHAT to
 * put in each slot without inspecting the element tree themselves.
 * Throws when duplicate slot names exist (propagated from collectSlots).
 */
export function listTemplateSlots(document: SceneDocument): TemplateSlot[] {
  const raw = collectSlots(document)
  const slots: TemplateSlot[] = []
  for (const [name, { pageId, elementId, kind }] of raw) {
    slots.push({ name, pageId, elementId, elementKind: kind, fillKind: fillKindForElementKind(kind) })
  }
  return slots
}

function fillKindForElementKind(kind: SceneElementKind): SlotFillKind {
  switch (kind) {
    case 'text': return 'text'
    case 'image':
    case 'video': return 'src'
    case 'rect':
    case 'ellipse': return 'color'
    case 'line':
    case 'group':
      throw new Error(
        `slot on "${kind}" element has no defined fill kind — bind_slot should not target line or group elements`,
      )
  }
}

// ---------------------------------------------------------------------------
// Binding validation
// ---------------------------------------------------------------------------

/**
 * Preflight check: every key in `bindings` must name a slot in the document.
 * Returns a list of problems; an empty array means the bindings are clean.
 * Does NOT throw — designed to run before `instantiateTemplate` so callers
 * can surface a structured error instead of catching.
 */
export function validateBindings(
  document: SceneDocument,
  bindings: Record<string, string>,
): string[] {
  const slots = collectSlots(document)
  const problems: string[] = []
  for (const key of Object.keys(bindings)) {
    if (!slots.has(key)) {
      problems.push(`binding key "${key}" does not match any slot in the document`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Template instantiation
// ---------------------------------------------------------------------------

/** Define options for instantiating a document with title, optional bindings, and custom id minting */
export interface InstantiateOptions {
  /** Human-readable title for the new document. */
  title: string
  /** Slot bindings to apply after id re-minting. Partial application allowed. */
  bindings?: Record<string, string>
  /**
   * Caller-supplied id factory — every page/element id in the source document
   * is replaced with a fresh value from this callback. The callback receives
   * the source id so implementations can build stable deterministic ids (e.g.
   * `crypto.randomUUID()` or `nanoid()` from the host).
   */
  mintId(sourceId: string): string
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
export function instantiateTemplate(
  document: SceneDocument,
  options: InstantiateOptions,
): SceneDocument {
  const bindings = options.bindings ?? {}

  // Preflight — throw before touching the document tree
  const problems = validateBindings(document, bindings)
  if (problems.length > 0) {
    throw new Error(`template bindings are invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  }

  // Build id mapping: sourceId → mintedId. Walk all page + element ids now so
  // group children can reference their parent's minted id during deep copy.
  const idMap = new Map<string, string>()
  const allocate = (sourceId: string): string => {
    if (idMap.has(sourceId)) return idMap.get(sourceId)!
    const minted = options.mintId(sourceId)
    idMap.set(sourceId, minted)
    return minted
  }

  for (const page of document.pages) {
    allocate(page.id)
    collectElementIds(page.elements, allocate)
  }

  // Deep-copy pages with re-minted ids
  const newPages: ScenePage[] = document.pages.map((page) => ({
    ...page,
    id: idMap.get(page.id)!,
    elements: copyElements(page.elements, idMap),
  }))

  const newDocument: SceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    title: options.title,
    pages: newPages,
    settings: { ...document.settings },
    metadata: {
      ...document.metadata,
      templateSourceId: document.title,
    },
  }

  // Apply bindings against the copied document (ids are now minted, slots preserved)
  return Object.keys(bindings).length > 0 ? applyBindings(newDocument, bindings) : newDocument
}

// ---------------------------------------------------------------------------
// Binding application (shared with apply_data operation semantics)
// ---------------------------------------------------------------------------

/**
 * Applies slot bindings to a document in place (mutates a deep copy produced
 * by the caller). Unknown slot names throw — the preflight in `instantiateTemplate`
 * guarantees this is unreachable there; exported so the `apply_data` operation
 * handler can reuse it without duplicating the switch.
 */
export function applyBindingsToDocument(
  document: SceneDocument,
  bindings: Record<string, string>,
): SceneDocument {
  const problems = validateBindings(document, bindings)
  if (problems.length > 0) {
    throw new Error(`apply_data bindings are invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  }
  return applyBindings(document, bindings)
}

// Internal — called only after validateBindings passes
function applyBindings(document: SceneDocument, bindings: Record<string, string>): SceneDocument {
  const slots = collectSlots(document)
  // Build a lookup: elementId → { slot, value } so the walk is O(elements)
  const targetMap = new Map<string, { slotName: string; value: string }>()
  for (const [slotName, { elementId }] of slots) {
    const value = bindings[slotName]
    if (value !== undefined) {
      targetMap.set(elementId, { slotName, value })
    }
  }

  const newPages: ScenePage[] = document.pages.map((page) => ({
    ...page,
    elements: applyBindingsToElements(page.elements, targetMap),
  }))

  return { ...document, pages: newPages }
}

function applyBindingsToElements(
  elements: SceneElement[],
  targetMap: Map<string, { slotName: string; value: string }>,
): SceneElement[] {
  return elements.map((element) => {
    const target = targetMap.get(element.id)
    let updated = element

    if (target !== undefined) {
      updated = applyBindingToElement(element, target.value, target.slotName)
    }

    if (updated.kind === 'group') {
      return { ...updated, children: applyBindingsToElements(updated.children, targetMap) }
    }
    return updated
  })
}

function applyBindingToElement(element: SceneElement, value: string, slotName: string): SceneElement {
  switch (element.kind) {
    case 'text': return { ...element, text: value }
    case 'image': return { ...element, src: value }
    case 'video': return { ...element, src: value }
    case 'rect': return { ...element, fill: value }
    case 'ellipse': return { ...element, fill: value }
    case 'line':
    case 'group':
      throw new Error(
        `slot "${slotName}" on "${element.kind}" element cannot accept a binding — remove the slot or use a supported element kind`,
      )
  }
}

// ---------------------------------------------------------------------------
// Deep copy helpers
// ---------------------------------------------------------------------------

function collectElementIds(elements: SceneElement[], allocate: (id: string) => string): void {
  for (const element of elements) {
    allocate(element.id)
    if (element.kind === 'group') collectElementIds(element.children, allocate)
  }
}

function copyElements(elements: SceneElement[], idMap: Map<string, string>): SceneElement[] {
  return elements.map((element) => copyElement(element, idMap))
}

function copyElement(element: SceneElement, idMap: Map<string, string>): SceneElement {
  const newId = idMap.get(element.id)
  if (newId === undefined) throw new Error(`element ${element.id} was not pre-allocated in the id map — this is a bug in instantiateTemplate`)
  const base = { ...element, id: newId }
  if (base.kind === 'group') {
    return { ...base, children: copyElements(base.children, idMap) }
  }
  return base
}
