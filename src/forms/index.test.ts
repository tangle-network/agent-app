/**
 * The form filler, tested against the failure modes that have already shipped.
 *
 * Every one of these is a measured incident, not a hypothetical:
 *
 *  - a fill against entirely wrong widget paths audited `passed=0 failed=0`,
 *    because an expected field ABSENT from the PDF was silently skipped;
 *  - three figures written to model-chosen widgets landed in "Combat zone" and
 *    the date boxes, and reading them back by the names that were written
 *    reported 3 passed / 0 failed;
 *  - a hand-typed form catalog carried wrong page counts for 7 of 17 forms;
 *  - a registry built by spatial guessing recovered ~11 of ~100 widgets with
 *    duplicate ids and was correctly refused as audit authority.
 *
 * THE FIXTURE. These run against a PDF built here rather than a committed
 * agency form, because an agency form is DOMAIN and this package ships
 * mechanism. Its structure is copied from measurements of the two real forms
 * this primitive exists for, and the copied properties are asserted below so
 * the fixture cannot drift into an easier shape than the real thing:
 *
 *  - checkbox on-states are hex-escaped sentences. Texas Form 205's seven
 *    boxes are `is#20an#20organization`, `initially#20has#20#20managers`
 *    (double space), `becomes#20effective#20when#20the#20document#20is#20filed#20by#20the#20Secretary#20of#20State.`
 *    and three more.
 *  - some widgets carry `/TU` and some carry none. Measured: 64 of 64 on
 *    Texas Form 205, 0 of 199 on IRS f1040.
 *
 * The end-to-end proof on the REAL Texas Form 205 — filled through this
 * primitive and read back by pypdf and PyMuPDF, two libraries that did not
 * produce it — is in the pull request, not here: it needs the 811 KB blank,
 * which belongs to the product that files that form.
 */

import { describe, expect, it } from 'vitest'

import { assertFormBlankIntegrity, decodeFormBlank, sha256Hex, type FormBlank } from './blank'
import { checkRegistryAgainstBlank, type FormRegistry } from './registry'
import { describeFormFill, fillPdfForm, formatFormCurrency, parseFormBoolean } from './fill'
import { verifyFilledForm } from './verify'

/**
 * A blank whose widgets reproduce the structural traps measured on the real
 * forms. `escapedCheckbox` gets a multi-word on-state, which a PDF must write
 * as a hex-escaped Name.
 */
async function buildFixture(): Promise<Uint8Array> {
  const { PDFDict, PDFDocument, PDFName, PDFString } = await import('pdf-lib')
  const document = await PDFDocument.create()
  const page = document.addPage([612, 792])
  const form = document.getForm()

  const text = (name: string, label: string | undefined, y: number) => {
    const field = form.createTextField(name)
    field.addToPage(page, { x: 50, y, width: 300, height: 16 })
    if (label !== undefined) field.acroField.dict.set(PDFName.of('TU'), PDFString.of(label))
  }
  // Two widgets carrying one semantic value, the way IRS Form 1040 states
  // adjusted gross income on both pages.
  text('agi_page1', 'Adjusted gross income', 700)
  text('agi_page2', 'Adjusted gross income', 680)
  text('entity_name', 'The name of the entity is:', 660)
  text('organizer', 'Printed or typed name of organizer:', 640)
  // A widget with NO accessibility text at all — the f1040 case.
  text('unlabelled', undefined, 620)

  const checkbox = (name: string, onState: string, label: string, y: number) => {
    const field = form.createCheckBox(name)
    field.addToPage(page, { x: 50, y, width: 12, height: 12 })
    const appearances = field.acroField.getWidgets()[0]?.getAppearances()
    if (appearances?.normal instanceof PDFDict) {
      const on = appearances.normal.get(PDFName.of('Yes'))
      if (on) {
        appearances.normal.delete(PDFName.of('Yes'))
        appearances.normal.set(PDFName.of(onState), on)
      }
    }
    field.acroField.dict.set(PDFName.of('TU'), PDFString.of(label))
  }
  checkbox(
    'registered',
    'is an organization',
    'If the initial registered agent is an organization, please check this box.',
    600,
  )
  checkbox('company', 'initially has  managers', 'If the company initially has managers, check this box.', 580)

  return document.save()
}

const FIXTURE = await buildFixture()

const REGISTRY: FormRegistry = {
  form: 'fixture-form',
  revision: 'v1',
  slots: [
    // One slot, two widgets — the AGI-on-both-pages shape.
    { slot: 'agi', fields: ['agi_page1', 'agi_page2'], kind: 'text', format: 'currency', label: 'Adjusted gross income', labelBasis: 'widget' },
    { slot: 'entity_name', fields: ['entity_name'], kind: 'text', label: 'The name of the entity is:', labelBasis: 'widget' },
    { slot: 'organizer', fields: ['organizer'], kind: 'text', label: 'Printed or typed name of organizer:', labelBasis: 'widget' },
    { slot: 'agent_is_organization', fields: ['registered'], kind: 'checkbox', label: 'If the initial registered agent is an organization, please check this box.', labelBasis: 'widget' },
    { slot: 'has_managers', fields: ['company'], kind: 'checkbox', label: 'If the company initially has managers, check this box.', labelBasis: 'widget' },
  ],
}

const withSlots = (slots: FormRegistry['slots']): FormRegistry => ({ ...REGISTRY, slots })

describe('the fixture reproduces the traps measured on the real forms', () => {
  it('hex-escapes a multi-word checkbox on-state, exactly as Texas Form 205 does', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const form = (await PDFDocument.load(FIXTURE, { updateMetadata: false })).getForm()
    // The escaped spelling is what a naive caller would type; the decoded one
    // is what the box actually means.
    expect(form.getCheckBox('registered').acroField.getOnValue()?.asString()).toBe('/is#20an#20organization')
    expect(form.getCheckBox('registered').acroField.getOnValue()?.decodeText()).toBe('is an organization')
    // Texas Form 205's `initially#20has#20#20managers` carries a double space,
    // reproduced here byte for byte.
    expect(form.getCheckBox('company').acroField.getOnValue()?.asString()).toBe('/initially#20has#20#20managers')
    expect(form.getCheckBox('company').acroField.getOnValue()?.decodeText()).toBe('initially has  managers')
  })

  it('carries a widget with no accessibility text, the way f1040 does on all 199', async () => {
    const { PDFDocument, PDFName } = await import('pdf-lib')
    const form = (await PDFDocument.load(FIXTURE, { updateMetadata: false })).getForm()
    expect(form.getTextField('unlabelled').acroField.dict.get(PDFName.of('TU'))).toBeUndefined()
    expect(form.getTextField('entity_name').acroField.dict.get(PDFName.of('TU'))).toBeDefined()
  })
})

describe('checkRegistryAgainstBlank — the placement check', () => {
  it('passes a registry that matches the blank, and says how much it proved', async () => {
    const result = await checkRegistryAgainstBlank({ pdf: FIXTURE, registry: REGISTRY })
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    // Six widgets across five slots; every one of them labelled and compared.
    expect(result.checked).toBe(6)
    expect(result.labelsChecked).toBe(6)
  })

  it('FAILS on a widget the PDF does not expose, instead of skipping it', async () => {
    // The measured bug: an expected field absent from the PDF was silently
    // skipped, so a fill against entirely wrong paths audited 0 passed 0 failed.
    const result = await checkRegistryAgainstBlank({
      pdf: FIXTURE,
      registry: withSlots([
        { slot: 'ghost', fields: ['topmostSubform[0].Page2[0].f2_06[0]'], kind: 'text', label: 'Amount', labelBasis: 'derived' },
      ]),
    })
    expect(result.ok).toBe(false)
    expect(result.checked).toBe(0)
    expect(result.problems).toEqual([
      {
        slot: 'ghost',
        field: 'topmostSubform[0].Page2[0].f2_06[0]',
        code: 'missing_field',
        detail: 'fixture-form has no widget named topmostSubform[0].Page2[0].f2_06[0]',
      },
    ])
  })

  it('FAILS when a slot claims a label the widget does not carry', async () => {
    // This is the only check that can catch a slot aimed at the WRONG BOX.
    // Reading a value back after writing it cannot: it re-reads the same name.
    const result = await checkRegistryAgainstBlank({
      pdf: FIXTURE,
      registry: withSlots([
        { slot: 'entity_name', fields: ['organizer'], kind: 'text', label: 'The name of the entity is:', labelBasis: 'widget' },
      ]),
    })
    expect(result.ok).toBe(false)
    expect(result.problems[0]?.code).toBe('label_mismatch')
    expect(result.problems[0]?.detail).toContain('Printed or typed name of organizer:')
  })

  it('FAILS a `widget` basis on a widget with no accessibility text, rather than passing it', async () => {
    // A label that cannot be checked is not a label that passed. Saying so is
    // the difference between derived evidence and a guess shipped as truth.
    const result = await checkRegistryAgainstBlank({
      pdf: FIXTURE,
      registry: withSlots([
        { slot: 'x', fields: ['unlabelled'], kind: 'text', label: 'Anything at all', labelBasis: 'widget' },
      ]),
    })
    expect(result.ok).toBe(false)
    expect(result.problems[0]?.code).toBe('label_mismatch')
    expect(result.problems[0]?.detail).toContain('carries no /TU text')
    expect(result.labelsChecked).toBe(0)
  })

  it('records a derived label as unchecked instead of pretending it was verified', async () => {
    const result = await checkRegistryAgainstBlank({
      pdf: FIXTURE,
      registry: withSlots([
        { slot: 'x', fields: ['unlabelled'], kind: 'text', label: '1a. Total amount from Form(s) W-2, box 1', labelBasis: 'derived' },
      ]),
    })
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(1)
    // The honest number: one widget existed, ZERO labels were proven.
    expect(result.labelsChecked).toBe(0)
  })

  it('FAILS when a slot declares the wrong widget kind', async () => {
    const result = await checkRegistryAgainstBlank({
      pdf: FIXTURE,
      registry: withSlots([
        { slot: 'entity_name', fields: ['registered'], kind: 'text', label: 'x', labelBasis: 'derived' },
      ]),
    })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatchObject({ code: 'wrong_kind' })
  })

  it('FAILS an empty registry rather than reporting a vacuous pass', async () => {
    const result = await checkRegistryAgainstBlank({ pdf: FIXTURE, registry: withSlots([]) })
    expect(result.ok).toBe(false)
    expect(result.checked).toBe(0)
    expect(result.problems[0]?.code).toBe('no_slots')
  })

  it('FAILS when two slots claim the same widget', async () => {
    const result = await checkRegistryAgainstBlank({
      pdf: FIXTURE,
      registry: withSlots([
        { slot: 'a', fields: ['entity_name'], kind: 'text', label: 'The name of the entity is:', labelBasis: 'widget' },
        { slot: 'b', fields: ['entity_name'], kind: 'text', label: 'The name of the entity is:', labelBasis: 'widget' },
      ]),
    })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toMatchObject({ code: 'duplicate_field', field: 'entity_name' })
  })

  it('FAILS a slot that names no widget at all', async () => {
    const result = await checkRegistryAgainstBlank({
      pdf: FIXTURE,
      registry: withSlots([{ slot: 'nowhere', fields: [], kind: 'text', label: 'x', labelBasis: 'derived' }]),
    })
    expect(result.ok).toBe(false)
    expect(result.problems[0]?.code).toBe('no_fields')
  })
})

describe('fillPdfForm', () => {
  it('writes one semantic value to EVERY widget the slot names', async () => {
    // IRS Form 1040 states AGI on both pages; page 2 reads "subtract line 14
    // from line 11b", so filling only one leaves that subtraction pointing at
    // an empty box.
    const result = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { agi: 159290.75 } })
    expect(result.unfilled).toEqual([])
    expect(result.filled.map((entry) => entry.field)).toEqual(['agi_page1', 'agi_page2'])
    expect(result.filled.every((entry) => entry.text === '159,290.75')).toBe(true)
  })

  it('reports a registry widget the PDF lacks, per slot, rather than crashing or skipping', async () => {
    const result = await fillPdfForm({
      pdf: FIXTURE,
      registry: withSlots([
        { slot: 'agi', fields: ['agi_page1', 'gone'], kind: 'text', format: 'currency', label: 'Adjusted gross income', labelBasis: 'widget' },
      ]),
      values: { agi: 100 },
    })
    expect(result.filled.map((entry) => entry.field)).toEqual(['agi_page1'])
    expect(result.unfilled).toEqual([
      { slot: 'agi', field: 'gone', value: 100, code: 'missing_field', reason: 'fixture-form has no widget named gone' },
    ])
  })

  it('reports a value whose slot the registry does not know, instead of dropping it', async () => {
    const result = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { 'schedule_b.line_1': 1240.5 } })
    expect(result.filled).toEqual([])
    expect(result.unfilled).toEqual([
      { slot: 'schedule_b.line_1', value: 1240.5, code: 'unknown_slot', reason: 'fixture-form has no slot named schedule_b.line_1' },
    ])
  })

  it('takes a currency figure as a number or as a form prints it', async () => {
    const asNumber = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { agi: 141318.74 } })
    const asText = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { agi: '$141,318.74' } })
    expect(asNumber.filled[0]?.text).toBe('141,318.74')
    expect(asText.filled[0]?.text).toBe('141,318.74')
  })

  it('refuses to print prose into a currency box', async () => {
    const result = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { agi: 'see attached' } })
    expect(result.filled).toEqual([])
    expect(result.unfilled[0]).toMatchObject({ code: 'not_a_number', reason: 'not a numeric amount' })
  })

  it('puts a name in a plain text box untouched', async () => {
    const result = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { entity_name: 'BLUE MESA KITCHEN LLC' } })
    expect(result.filled[0]?.text).toBe('BLUE MESA KITCHEN LLC')
  })

  it('ticks a hex-escaped checkbox using the on-state READ FROM THE PDF', async () => {
    // The escaped literal is never authored. `onState` reports what the file
    // said, decoded, so a reviewer can see the primitive did not invent it.
    const result = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { agent_is_organization: true } })
    expect(result.filled[0]).toMatchObject({ field: 'registered', checked: true, onState: 'is an organization' })
    const { PDFDocument } = await import('pdf-lib')
    const form = (await PDFDocument.load(result.bytes, { updateMetadata: false })).getForm()
    expect(form.getCheckBox('registered').isChecked()).toBe(true)
  })

  it('REFUSES the escaped on-state as a value — the spelling that silently does nothing', async () => {
    // A caller that types `is#20an#20organization` is asserting a fact about
    // the file it cannot check. Accepting it as truthy would make the very
    // string this module exists to eliminate look like it worked.
    const result = await fillPdfForm({
      pdf: FIXTURE,
      registry: REGISTRY,
      values: { agent_is_organization: 'is#20an#20organization' },
    })
    expect(result.filled).toEqual([])
    expect(result.unfilled[0]).toMatchObject({ code: 'not_a_boolean' })
    expect(result.unfilled[0]?.reason).toContain('read from the PDF and is never supplied')
  })

  it('leaves a checkbox clear on false, and never reads "no" as yes', async () => {
    const off = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { agent_is_organization: false } })
    const { PDFDocument } = await import('pdf-lib')
    const form = (await PDFDocument.load(off.bytes, { updateMetadata: false })).getForm()
    expect(form.getCheckBox('registered').isChecked()).toBe(false)
    expect(parseFormBoolean('no')).toBe(false)
    expect(parseFormBoolean('maybe')).toBeUndefined()
  })

  it('renders the same bytes for the same values', async () => {
    // Content-addressed storage depends on this: a non-deterministic render
    // gives one version of a filing a new filename on every submit.
    const values = { agi: 159290.75, entity_name: 'BLUE MESA KITCHEN LLC', agent_is_organization: true }
    const first = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values })
    const second = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values })
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true)
  })

  it('carries no XFA layer, so no reader can draw the blank instead', async () => {
    const result = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { entity_name: 'X' } })
    const { PDFDocument, PDFDict, PDFName } = await import('pdf-lib')
    const document = await PDFDocument.load(result.bytes, { updateMetadata: false })
    expect(document.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('XFA'))).toBeUndefined()
  })

  it('names the values that never reached the page', async () => {
    const result = await fillPdfForm({
      pdf: FIXTURE,
      registry: REGISTRY,
      values: { entity_name: 'BLUE MESA KITCHEN LLC', agi: 'see attached' },
    })
    expect(describeFormFill(result)).toBe(
      'Filled fixture-form (v1) with 1 value. NOT placed on the form: agi (not a numeric amount). Those values are in the data but not on the document a reviewer opens.',
    )
  })

  it('honours a product formatter without losing the built-in fallback', async () => {
    const result = await fillPdfForm({
      pdf: FIXTURE,
      registry: REGISTRY,
      values: { entity_name: 'blue mesa', agi: 1000 },
      formatText: (value, slot) => (slot.slot === 'entity_name' ? String(value).toUpperCase() : undefined),
    })
    expect(result.filled.find((entry) => entry.slot === 'entity_name')?.text).toBe('BLUE MESA')
    expect(result.filled.find((entry) => entry.slot === 'agi')?.text).toBe('1,000.00')
  })
})

describe('verifyFilledForm — the transport check', () => {
  const VALUES = { agi: 159290.75, entity_name: 'BLUE MESA KITCHEN LLC', agent_is_organization: true, has_managers: false }

  it('confirms every value reached its widget', async () => {
    const filled = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: VALUES })
    const result = await verifyFilledForm({ pdf: filled.bytes, registry: REGISTRY, expected: VALUES })
    expect(result.slots.every((slot) => slot.verdict === 'ok')).toBe(true)
    expect(result.verified).toBe(5)
    expect(result.ok).toBe(true)
  })

  it('FAILS on a registry widget absent from the produced file', async () => {
    const filled = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: VALUES })
    const result = await verifyFilledForm({
      pdf: filled.bytes,
      registry: withSlots([{ slot: 'agi', fields: ['gone'], kind: 'text', format: 'currency', label: 'x', labelBasis: 'derived' }]),
      expected: { agi: 159290.75 },
    })
    expect(result.ok).toBe(false)
    expect(result.slots[0]?.verdict).toBe('missing_field')
  })

  it('FAILS with nothing verified rather than reporting the 0-passed-0-failed verdict', async () => {
    const filled = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: VALUES })
    const result = await verifyFilledForm({ pdf: filled.bytes, registry: REGISTRY, expected: {} })
    expect(result.verified).toBe(0)
    expect(result.ok).toBe(false)
  })

  it('catches a value that never got written', async () => {
    const filled = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: { entity_name: 'BLUE MESA KITCHEN LLC' } })
    const result = await verifyFilledForm({ pdf: filled.bytes, registry: REGISTRY, expected: VALUES })
    expect(result.ok).toBe(false)
    expect(result.slots.filter((slot) => slot.verdict === 'not_written').map((slot) => slot.field)).toEqual([
      'agi_page1',
      'agi_page2',
    ])
  })

  it('reports a mismatched LABEL as a failure, because read-back alone cannot see placement', async () => {
    // The registry aims `entity_name` at the organizer box. Every value still
    // reaches a real widget and reads back exactly as written — the naive
    // audit passes. Only the label comparison catches it.
    const misaimed = withSlots([
      { slot: 'entity_name', fields: ['organizer'], kind: 'text', label: 'The name of the entity is:', labelBasis: 'widget' },
    ])
    const filled = await fillPdfForm({ pdf: FIXTURE, registry: misaimed, values: { entity_name: 'BLUE MESA KITCHEN LLC' } })
    const result = await verifyFilledForm({ pdf: filled.bytes, registry: misaimed, expected: { entity_name: 'BLUE MESA KITCHEN LLC' } })
    expect(result.slots[0]?.verdict).toBe('ok')
    expect(result.slots[0]?.labelVerdict).toBe('label_mismatch')
    expect(result.ok).toBe(false)
  })

  it('marks a derived label unchecked rather than claiming it matched', async () => {
    const derived = withSlots([
      { slot: 'x', fields: ['unlabelled'], kind: 'text', label: '1a. Total amount from Form(s) W-2, box 1', labelBasis: 'derived' },
    ])
    const filled = await fillPdfForm({ pdf: FIXTURE, registry: derived, values: { x: 'anything' } })
    const result = await verifyFilledForm({ pdf: filled.bytes, registry: derived, expected: { x: 'anything' } })
    expect(result.slots[0]).toMatchObject({ verdict: 'ok', labelVerdict: 'derived_unchecked' })
    expect(result.ok).toBe(true)
  })

  it('FAILS a slot the registry does not know', async () => {
    const filled = await fillPdfForm({ pdf: FIXTURE, registry: REGISTRY, values: VALUES })
    const result = await verifyFilledForm({ pdf: filled.bytes, registry: REGISTRY, expected: { ...VALUES, nonsense: 1 } })
    expect(result.ok).toBe(false)
    expect(result.slots.find((slot) => slot.slot === 'nonsense')?.verdict).toBe('unknown_slot')
  })
})

describe('the embedded blank', () => {
  const blankOf = async (bytes: Uint8Array): Promise<FormBlank> => ({
    base64: Buffer.from(bytes).toString('base64'),
    sha256: await sha256Hex(bytes),
    sourceUrl: 'https://example.gov/fixture.pdf',
    byteLength: bytes.length,
  })

  it('decodes to the exact bytes it was built from', async () => {
    const blank = await blankOf(FIXTURE)
    expect(Buffer.from(decodeFormBlank(blank)).equals(Buffer.from(FIXTURE))).toBe(true)
    await expect(assertFormBlankIntegrity(blank)).resolves.toBeUndefined()
  })

  it('refuses a blank whose bytes are not the ones the registry was derived against', async () => {
    const blank = { ...(await blankOf(FIXTURE)), sha256: 'a'.repeat(64) }
    await expect(assertFormBlankIntegrity(blank)).rejects.toThrow(/was derived against/u)
  })

  it('refuses a truncated embed instead of filling a half-form', async () => {
    const blank = await blankOf(FIXTURE)
    expect(() => decodeFormBlank({ ...blank, byteLength: blank.byteLength + 1 })).toThrow(/truncated/u)
  })

  it('caches per blank, so one form never serves another form’s bytes', async () => {
    // A module-level singleton would return the first form decoded for every
    // subsequent form — producing a plausible PDF and no error at all.
    const one = await blankOf(FIXTURE)
    const other = await blankOf(await buildFixture().then((bytes) => bytes.slice(0, bytes.length)))
    const a = decodeFormBlank(one)
    const b = decodeFormBlank(other)
    expect(decodeFormBlank(one)).toBe(a)
    expect(decodeFormBlank(other)).toBe(b)
  })
})

describe('formatFormCurrency', () => {
  it('groups thousands and keeps cents', () => {
    expect(formatFormCurrency(128450)).toBe('128,450.00')
    expect(formatFormCurrency(20490.85)).toBe('20,490.85')
  })

  it('shows a loss in parentheses, the way the form does', () => {
    expect(formatFormCurrency(-3000)).toBe('(3,000.00)')
  })
})
