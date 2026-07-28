/**
 * The slot → widget registry: the one place a form filler can be wrong
 * invisibly, and the one place a language model is never allowed to write.
 *
 * WHY THE MODEL NEVER NAMES A WIDGET
 *
 * An agency PDF's widget names carry no meaning a reader can check —
 * `topmostSubform[0].Page2[0].f2_06[0]` on an IRS form, `registered2` on a
 * Texas SOS form. A model asked for one produces a plausible string, and the
 * natural audit — read the field back by the name you just wrote — PASSES
 * REGARDLESS, because it re-reads the invention rather than checking it.
 * Measured on tax-agent: three values written to model-chosen widgets landed
 * in "Combat zone" and the date boxes, and the audit reported 3 passed /
 * 0 failed.
 *
 * So the model supplies SEMANTIC SLOTS — a form line, a named box — and the
 * platform owns the slot → widget mapping. A misplaced figure stops being an
 * invention that survives review and becomes something that cannot be
 * expressed at all.
 *
 * WHY A SLOT CARRIES A LABEL, AND WHY THE LABEL DECLARES ITS BASIS
 *
 * A registry is still just a table, and a hand-typed table drifts (tax-agent's
 * form catalog carried wrong page counts for 7 of 17 forms). So every slot
 * states the label it believes it is aiming at, and states where that belief
 * came from:
 *
 *  - `labelBasis: 'widget'` — the label must match the widget's OWN `/TU`
 *    accessibility text inside the PDF. `checkRegistryAgainstBlank` re-checks
 *    it against the bytes, so a mis-aimed slot fails a test rather than
 *    quietly printing in the wrong box. Every one of Texas Form 205's 64
 *    widgets carries `/TU`, so its whole registry can be checked this way.
 *  - `labelBasis: 'derived'` — the label came from somewhere else (an XFA
 *    template, a published instruction sheet, a human reading the form) and
 *    CANNOT be re-checked against the widget. It is evidence for a reviewer,
 *    never proof. Measured on IRS f1040: 0 of 199 widgets carry `/TU` or
 *    `/Alt`, so its labels can only ever be derived.
 *
 * Declaring the basis is the point. A guess presented as truth is how a second
 * self-confirming artifact gets built on top of the first one.
 */

import type { PDFDocument, PDFForm } from 'pdf-lib'

/** What kind of widget a slot writes to. */
export type FormSlotKind = 'text' | 'checkbox'

/** How a slot's text value is rendered into the box. */
export type FormSlotFormat = 'text' | 'currency'

/** Where a slot's `label` came from, and therefore what it can prove. */
export type FormLabelBasis = 'widget' | 'derived'

/** One semantic slot: what a caller supplies, and where the platform puts it. */
export interface FormSlot {
  /** The name a caller (and a model) uses: `15`, `entity_name`, `agent_is_org`. */
  slot: string
  /**
   * The AcroForm widget path(s) this slot writes.
   *
   * A LIST because one semantic value legitimately occupies several boxes: IRS
   * Form 1040 states adjusted gross income twice, at the foot of page 1 and
   * the head of page 2, so page 2's arithmetic stands alone. Writing only one
   * of them leaves "subtract line 14 from line 11b" pointing at an empty box.
   */
  fields: readonly string[]
  kind: FormSlotKind
  /** How the value is rendered. Ignored for `checkbox`. Default `'text'`. */
  format?: FormSlotFormat
  /** What this slot is, in the form's own words. */
  label: string
  /** Whether `label` is checkable against the PDF, or merely recorded. */
  labelBasis: FormLabelBasis
}

/** A form's complete slot table, pinned to the revision it was derived from. */
export interface FormRegistry {
  /** Stable id for the form: `us-irs-1040`, `us-tx-sos-205`. */
  form: string
  /** The agency's own revision marker: `2025`, `Rev. 12-21`. */
  revision: string
  slots: readonly FormSlot[]
}

/** Why a registry does not match the blank it claims to describe. */
export type RegistryProblemCode =
  | 'no_slots'
  | 'no_fields'
  | 'missing_field'
  | 'wrong_kind'
  | 'label_mismatch'
  | 'duplicate_field'
  | 'duplicate_slot'

export interface RegistryProblem {
  slot: string
  field?: string
  code: RegistryProblemCode
  detail: string
}

export interface RegistryCheckResult {
  ok: boolean
  /** Widgets actually compared against the PDF. Zero means nothing was proven. */
  checked: number
  /** Slots whose label was compared against the widget's own `/TU`. */
  labelsChecked: number
  problems: RegistryProblem[]
}

/** The `/TU` accessibility text a widget carries, if any. */
export async function widgetLabel(form: PDFForm, field: string): Promise<string | undefined> {
  const { PDFName, PDFHexString, PDFString } = await import('pdf-lib')
  const target = form.getFieldMaybe(field)
  if (!target) return undefined
  const tooltip = target.acroField.dict.get(PDFName.of('TU'))
  if (tooltip instanceof PDFString || tooltip instanceof PDFHexString) return tooltip.decodeText()
  return undefined
}

/** Normalize whitespace so a label comparison survives the agency's own typing. */
function normalizeLabel(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Check a registry against the blank it claims to describe.
 *
 * This is the placement check. It runs in a test or in CI, never on the fill
 * path, and it is the ONLY thing that can catch a slot aimed at the wrong box
 * — reading a value back after writing it cannot, because it re-reads the same
 * name it wrote.
 *
 * It fails on ABSENCE, deliberately. tax-agent shipped an audit that silently
 * skipped an expected field the PDF did not expose, so a fill against entirely
 * wrong paths reported `passed=0 failed=0`. Here an empty registry, a slot
 * with no fields, and a field the PDF does not expose are each a problem with
 * a name, and `checked` is reported so a caller can see how much was actually
 * proven rather than trusting a bare `ok: true`.
 */
export async function checkRegistryAgainstBlank(args: {
  /** The blank's bytes. Decode a `FormBlank` with `decodeFormBlank` first. */
  pdf: Uint8Array
  registry: FormRegistry
}): Promise<RegistryCheckResult> {
  const { PDFDocument } = await import('pdf-lib')
  const document: PDFDocument = await PDFDocument.load(args.pdf, { updateMetadata: false })
  const form = document.getForm()

  // The PDF's OWN field list, enumerated independently of anything the
  // registry claims. Every lookup below resolves against this, so a registry
  // naming a field that does not exist cannot pass by being skipped.
  const exposed = new Map<string, string>()
  for (const field of form.getFields()) exposed.set(field.getName(), field.constructor.name)

  const problems: RegistryProblem[] = []
  const claimedBy = new Map<string, string>()
  const seenSlots = new Set<string>()
  let checked = 0
  let labelsChecked = 0

  if (args.registry.slots.length === 0) {
    problems.push({
      slot: '(registry)',
      code: 'no_slots',
      detail: `registry ${args.registry.form} declares no slots — it can prove nothing and fill nothing`,
    })
  }

  for (const slot of args.registry.slots) {
    if (seenSlots.has(slot.slot)) {
      problems.push({
        slot: slot.slot,
        code: 'duplicate_slot',
        detail: `slot ${slot.slot} is declared twice; the later entry silently wins at fill time`,
      })
    }
    seenSlots.add(slot.slot)

    if (slot.fields.length === 0) {
      problems.push({
        slot: slot.slot,
        code: 'no_fields',
        detail: `slot ${slot.slot} names no widget, so a value supplied for it goes nowhere`,
      })
      continue
    }

    for (const field of slot.fields) {
      const previous = claimedBy.get(field)
      if (previous !== undefined && previous !== slot.slot) {
        problems.push({
          slot: slot.slot,
          field,
          code: 'duplicate_field',
          detail: `${field} is claimed by both slot ${previous} and slot ${slot.slot}`,
        })
      }
      claimedBy.set(field, slot.slot)

      const actualKind = exposed.get(field)
      if (actualKind === undefined) {
        problems.push({
          slot: slot.slot,
          field,
          code: 'missing_field',
          detail: `${args.registry.form} has no widget named ${field}`,
        })
        continue
      }
      checked += 1

      const expectedKind = slot.kind === 'checkbox' ? 'PDFCheckBox' : 'PDFTextField'
      if (actualKind !== expectedKind) {
        problems.push({
          slot: slot.slot,
          field,
          code: 'wrong_kind',
          detail: `${field} is a ${actualKind}, but slot ${slot.slot} declares ${slot.kind}`,
        })
        continue
      }

      if (slot.labelBasis !== 'widget') continue
      const onWidget = await widgetLabel(form, field)
      if (onWidget === undefined) {
        problems.push({
          slot: slot.slot,
          field,
          code: 'label_mismatch',
          detail: `slot ${slot.slot} claims labelBasis 'widget' but ${field} carries no /TU text to check it against — the label is derived, not checked`,
        })
        continue
      }
      labelsChecked += 1
      if (normalizeLabel(onWidget) !== normalizeLabel(slot.label)) {
        problems.push({
          slot: slot.slot,
          field,
          code: 'label_mismatch',
          detail: `${field} is labelled ${JSON.stringify(onWidget)} but slot ${slot.slot} claims ${JSON.stringify(slot.label)}`,
        })
      }
    }
  }

  return { ok: problems.length === 0, checked, labelsChecked, problems }
}
