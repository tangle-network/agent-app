/**
 * Read a filled form back and say, slot by slot, whether the document agrees
 * with the data it was built from.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 *
 * This proves the WRITE LANDED: the value reached a real widget, that widget
 * exists in the produced file, and it holds the text or tick the data claims.
 * It does NOT prove PLACEMENT — that the widget is the right box on the page —
 * because it resolves the same field names the fill used. Reading a value back
 * by the name you just wrote passes even when the name was invented; measured
 * on tax-agent, an audit of that shape reported 3 passed / 0 failed for three
 * figures sitting in "Combat zone" and the date boxes.
 *
 * Placement is proven by `checkRegistryAgainstBlank`, which compares each
 * slot's claimed label against the widget's own `/TU` text inside the PDF.
 * The two checks are complements, and a product that runs only this one has
 * the audit that already failed once. That is stated here rather than in a
 * commit message because a future caller will otherwise reach for the
 * convenient half.
 *
 * FAILS ON ABSENCE. A registry field the produced PDF does not expose is
 * `missing_field`, and an empty `expected` map is `ok: false` — the
 * `passed=0 failed=0` verdict is the exact shape of the bug this replaces.
 */

import type { PDFCheckBox, PDFDocument, PDFTextField } from 'pdf-lib'

import { parseFormBoolean, formatFormCurrency, parseFormAmount } from './fill'
import { widgetLabel, type FormRegistry } from './registry'

export type SlotVerdict = 'ok' | 'unknown_slot' | 'missing_field' | 'wrong_kind' | 'not_written' | 'mismatch'

/** What the slot's `label` is worth, checked against the produced file. */
export type LabelVerdict = 'matches_widget' | 'label_mismatch' | 'derived_unchecked' | 'no_widget_label'

export interface SlotVerification {
  slot: string
  field?: string
  verdict: SlotVerdict
  /** What the data says the box should hold. */
  expected?: string
  /** What the box actually holds, read out of the produced bytes. */
  actual?: string
  labelVerdict?: LabelVerdict
  label?: string
}

export interface VerifyFormResult {
  ok: boolean
  /** Widgets actually read back. Zero means nothing was proven. */
  verified: number
  slots: SlotVerification[]
}

function expectedText(value: unknown, format: string | undefined): string {
  if (format === 'currency') {
    const amount = parseFormAmount(value)
    return amount === undefined ? String(value) : formatFormCurrency(amount)
  }
  return typeof value === 'number' ? String(value) : String(value)
}

/**
 * Verify a filled form against the value map it was filled from.
 *
 * `expected` is the SAME shape passed to `fillPdfForm` — deliberately, so a
 * caller cannot verify against a convenient restatement of what it wrote.
 */
export async function verifyFilledForm(args: {
  /** The PRODUCED bytes, not the blank. */
  pdf: Uint8Array
  registry: FormRegistry
  expected: Record<string, unknown>
  /** Slots the caller knowingly left out of `expected`; anything else is checked. */
}): Promise<VerifyFormResult> {
  const { PDFCheckBox: CheckBox, PDFDocument, PDFTextField: TextField } = await import('pdf-lib')
  const document: PDFDocument = await PDFDocument.load(args.pdf, { updateMetadata: false })
  const form = document.getForm()

  // The produced file's OWN field list, enumerated before anything the
  // registry claims is consulted. A registry field absent from this set is a
  // failure, never a skip.
  const exposed = new Set(form.getFields().map((field) => field.getName()))

  const bySlot = new Map(args.registry.slots.map((slot) => [slot.slot, slot]))
  const slots: SlotVerification[] = []
  let verified = 0
  let ok = true

  for (const [name, value] of Object.entries(args.expected)) {
    const slot = bySlot.get(name)
    if (!slot) {
      slots.push({ slot: name, verdict: 'unknown_slot' })
      ok = false
      continue
    }
    for (const field of slot.fields) {
      if (!exposed.has(field)) {
        slots.push({ slot: name, field, verdict: 'missing_field' })
        ok = false
        continue
      }
      const widget = form.getField(field)
      const label = await widgetLabel(form, field)
      const labelVerdict: LabelVerdict =
        slot.labelBasis === 'derived'
          ? 'derived_unchecked'
          : label === undefined
            ? 'no_widget_label'
            : label.replace(/\s+/gu, ' ').trim().toLowerCase() ===
                slot.label.replace(/\s+/gu, ' ').trim().toLowerCase()
              ? 'matches_widget'
              : 'label_mismatch'
      if (labelVerdict === 'label_mismatch' || labelVerdict === 'no_widget_label') ok = false

      if (slot.kind === 'checkbox') {
        if (!(widget instanceof CheckBox)) {
          slots.push({ slot: name, field, verdict: 'wrong_kind', label, labelVerdict })
          ok = false
          continue
        }
        const want = parseFormBoolean(value)
        const got = (widget as PDFCheckBox).isChecked()
        const verdict: SlotVerdict = want === undefined ? 'mismatch' : got === want ? 'ok' : 'mismatch'
        if (verdict !== 'ok') ok = false
        else verified += 1
        slots.push({
          slot: name,
          field,
          verdict,
          expected: String(want),
          actual: String(got),
          label,
          labelVerdict,
        })
        continue
      }

      if (!(widget instanceof TextField)) {
        slots.push({ slot: name, field, verdict: 'wrong_kind', label, labelVerdict })
        ok = false
        continue
      }
      const want = expectedText(value, slot.format)
      const got = (widget as PDFTextField).getText() ?? ''
      const verdict: SlotVerdict = got === '' && want !== '' ? 'not_written' : got === want ? 'ok' : 'mismatch'
      if (verdict !== 'ok') ok = false
      else verified += 1
      slots.push({ slot: name, field, verdict, expected: want, actual: got, label, labelVerdict })
    }
  }

  // An audit that checked nothing must never report success. This is the
  // `passed=0 failed=0` verdict, refused by name.
  if (verified === 0) ok = false

  return { ok, verified, slots }
}
