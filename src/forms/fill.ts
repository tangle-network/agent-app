/**
 * Fill a real agency PDF from a slot → value map.
 *
 * Mechanically this is `pdf-lib` writing an AcroForm: TypeScript, no
 * container, no Python, no network. That matters because it is the only shape
 * that runs everywhere these products run — a Cloudflare Worker (where 100% of
 * tax-agent's production work products were produced, with no sandbox at all)
 * and a sandbox container whose egress proxy refuses the agency's own host.
 *
 * The invariant it enforces is in `registry.ts`: the caller supplies SEMANTIC
 * SLOTS and never a widget name. Two consequences show up here.
 *
 * NOTHING IS SILENT. Every slot ends in `filled` or in `unfilled` with a code
 * and a reason. A value the caller supplied that never reached the page means
 * the document and the data disagree, which is the one thing a reviewer must
 * not have to discover by eye. That includes a registry naming a widget the
 * PDF does not expose: it is reported per-slot rather than crashing the render
 * or — worse — being skipped, which is how tax-agent once audited a fill
 * against entirely wrong paths as `passed=0 failed=0`.
 *
 * NO ON-STATE IS EVER AUTHORED. A checkbox's "on" name is a property of the
 * PDF and frequently a hex-escaped sentence: Texas Form 205's seven boxes are
 * `is#20an#20organization`, `initially#20has#20#20managers` (note the double
 * space), and four more like them. A caller that types one of those strings is
 * authoring something it cannot check, so a checkbox slot takes a BOOLEAN and
 * the widget's own on-value is read out of the file. The escaped spelling is
 * not handled — it is unrepresentable.
 */

import type { PDFCheckBox, PDFDocument, PDFTextField } from 'pdf-lib'

import type { FormRegistry, FormSlot } from './registry'

/** One widget the fill actually wrote. */
export interface FilledWidget {
  slot: string
  field: string
  kind: FormSlot['kind']
  /** The value as the caller supplied it, before formatting. */
  value: unknown
  /** Exactly the text placed in the box. Absent for a checkbox. */
  text?: string
  /** Whether a checkbox was ticked. Absent for a text field. */
  checked?: boolean
  /** The widget's OWN on-state, decoded — read from the PDF, never authored. */
  onState?: string
}

/** Why a supplied value did not reach the page. */
export type UnfilledCode =
  | 'unknown_slot'
  | 'missing_field'
  | 'wrong_kind'
  | 'not_a_number'
  | 'not_a_boolean'
  | 'unformattable'

export interface UnfilledSlot {
  slot: string
  field?: string
  value: unknown
  code: UnfilledCode
  reason: string
}

export interface FillFormResult {
  bytes: Uint8Array
  filled: FilledWidget[]
  unfilled: UnfilledSlot[]
  form: string
  revision: string
}

export interface FillFormOptions {
  /** The blank's bytes. Decode a `FormBlank` with `decodeFormBlank` first. */
  pdf: Uint8Array
  registry: FormRegistry
  /** slot name → value. Keys the registry does not know are reported, not dropped. */
  values: Record<string, unknown>
  /**
   * Override how a text value becomes box text. Return `undefined` to fall
   * through to the built-in formatting for the slot's `format`.
   */
  formatText?: (value: unknown, slot: FormSlot) => string | undefined
}

/**
 * Format a figure the way a US agency form prints it: grouped thousands, two
 * decimals, negatives in parentheses.
 *
 * Two decimals rather than whole dollars because the caller's data carries
 * cents and a reviewer compares the document against that data — rounding here
 * would manufacture a disagreement between the two on every line with cents.
 */
export function formatFormCurrency(value: number): string {
  const magnitude = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return value < 0 ? `(${magnitude})` : magnitude
}

/** A number, or a number written the way a form prints one (`$141,318.74`). */
export function parseFormAmount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[$,\s]/gu, '')
  if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * A checkbox takes a boolean and nothing else.
 *
 * Strict on purpose. Accepting a truthy string would accept the widget's own
 * escaped on-state (`'is#20an#20organization'`) as "true", which is exactly
 * the authored-on-state this module refuses — and it would accept `'no'` as
 * true, silently ticking a box the caller meant to leave clear.
 */
export function parseFormBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === 'yes') return true
  if (normalized === 'false' || normalized === 'no') return false
  return undefined
}

function textFor(
  value: unknown,
  slot: FormSlot,
  override: FillFormOptions['formatText'],
): { text: string } | { code: UnfilledCode; reason: string } {
  const custom = override?.(value, slot)
  if (custom !== undefined) return { text: custom }
  if ((slot.format ?? 'text') === 'currency') {
    const amount = parseFormAmount(value)
    if (amount === undefined) return { code: 'not_a_number', reason: 'not a numeric amount' }
    return { text: formatFormCurrency(amount) }
  }
  if (typeof value === 'string') return { text: value }
  if (typeof value === 'number' && Number.isFinite(value)) return { text: String(value) }
  return { code: 'unformattable', reason: `cannot render a ${typeof value} into a text box` }
}

/**
 * Write a value map onto a blank, returning the bytes plus the exact
 * widget-by-widget account of what was and was not placed.
 */
export async function fillPdfForm(options: FillFormOptions): Promise<FillFormResult> {
  const { PDFCheckBox: CheckBox, PDFDocument, PDFName, PDFTextField: TextField } = await import('pdf-lib')

  // `updateMetadata: false` keeps the render deterministic — pdf-lib otherwise
  // stamps a ModDate, which would give the same values a different checksum on
  // every call and defeat content-addressed storage. It also keeps our
  // timestamps off the agency's document.
  const document: PDFDocument = await PDFDocument.load(options.pdf, { updateMetadata: false })
  const form = document.getForm()

  // Agency forms ship as AcroForm/XFA hybrids, and a reader that prefers the
  // XFA layer would draw the ORIGINAL empty form and show none of these
  // values. `getForm()` drops the XFA packet (pdf-lib does not support it), so
  // this asserts the property rather than trusting it to stay incidental.
  if (document.catalog.getOrCreateAcroForm().dict.has(PDFName.of('XFA'))) {
    throw new Error('filled form still carries an XFA layer — a viewer would draw the blank instead')
  }

  const bySlot = new Map(options.registry.slots.map((slot) => [slot.slot, slot]))
  const filled: FilledWidget[] = []
  const unfilled: UnfilledSlot[] = []

  for (const [name, value] of Object.entries(options.values)) {
    const slot = bySlot.get(name)
    if (!slot) {
      unfilled.push({
        slot: name,
        value,
        code: 'unknown_slot',
        reason: `${options.registry.form} has no slot named ${name}`,
      })
      continue
    }

    if (slot.kind === 'checkbox') {
      const checked = parseFormBoolean(value)
      if (checked === undefined) {
        unfilled.push({
          slot: name,
          value,
          code: 'not_a_boolean',
          reason: 'a checkbox takes true or false; a checkbox on-state is read from the PDF and is never supplied',
        })
        continue
      }
      for (const field of slot.fields) {
        const widget = form.getFieldMaybe(field)
        if (!widget) {
          unfilled.push({ slot: name, field, value, code: 'missing_field', reason: `${options.registry.form} has no widget named ${field}` })
          continue
        }
        if (!(widget instanceof CheckBox)) {
          unfilled.push({ slot: name, field, value, code: 'wrong_kind', reason: `${field} is a ${widget.constructor.name}, not a checkbox` })
          continue
        }
        const box = widget as PDFCheckBox
        // The widget's OWN on-state. Read, never authored: Texas Form 205's
        // are hex-escaped sentences, and a caller that typed one would be
        // asserting a fact about the file it cannot check.
        const onState = box.acroField.getOnValue()?.decodeText()
        if (checked) box.check()
        else box.uncheck()
        filled.push({ slot: name, field, kind: 'checkbox', value, checked, onState })
      }
      continue
    }

    const rendered = textFor(value, slot, options.formatText)
    if ('code' in rendered) {
      unfilled.push({ slot: name, value, code: rendered.code, reason: rendered.reason })
      continue
    }
    for (const field of slot.fields) {
      const widget = form.getFieldMaybe(field)
      if (!widget) {
        unfilled.push({ slot: name, field, value, code: 'missing_field', reason: `${options.registry.form} has no widget named ${field}` })
        continue
      }
      if (!(widget instanceof TextField)) {
        unfilled.push({ slot: name, field, value, code: 'wrong_kind', reason: `${field} is a ${widget.constructor.name}, not a text field` })
        continue
      }
      ;(widget as PDFTextField).setText(rendered.text)
      filled.push({ slot: name, field, kind: 'text', value, text: rendered.text })
    }
  }

  return {
    bytes: await document.save(),
    filled,
    unfilled,
    form: options.registry.form,
    revision: options.registry.revision,
  }
}

/**
 * What to tell the agent after a fill.
 *
 * Names the values that did NOT reach the page. Those are exactly the cases
 * where the document and the data disagree, and the agent is the only party
 * that can resolve it — returning a bare "done" hands a reviewer a form
 * missing values the data claims are on it.
 */
export function describeFormFill(result: FillFormResult): string {
  const count = result.filled.length
  const base = `Filled ${result.form} (${result.revision}) with ${count} ${count === 1 ? 'value' : 'values'}.`
  if (result.unfilled.length === 0) return base
  const detail = result.unfilled.map((entry) => `${entry.slot} (${entry.reason})`).join('; ')
  return `${base} NOT placed on the form: ${detail}. Those values are in the data but not on the document a reviewer opens.`
}
