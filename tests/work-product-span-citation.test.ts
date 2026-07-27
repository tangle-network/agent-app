/**
 * Span citation: the lineage form that cannot be wrong.
 *
 * The verbatim gate (`work-product-quote-verification.test.ts`) proves a
 * fabricated quote is REFUSED. This file proves the other half — that a
 * correct citation is reachable without the model reproducing source text.
 * The bar is not "the gate catches fabrication"; it is "a package with real
 * lineage can actually be produced", which the measured retype rate (9 of 59
 * on the live tax surface) says the quote-only form could not deliver.
 *
 * `W2_TEXT` and `ORGANIZER_TEXT` are the same two production source excerpts
 * the verification suite uses, so the two files measure the same bytes.
 */

import { describe, expect, it } from 'vitest'

import { ToolInputError } from '../src/tools/errors'
import { dispatchAppTool, type AppToolContext, type AppToolHandlers, type AppToolTaxonomy } from '../src/tools/index'
import {
  buildWorkProductTools,
  createInMemoryWorkProductStore,
  findSourceLine,
  parseEvidenceInput,
  sliceSourceSpan,
  sourceContainsQuote,
  type WorkProductRecord,
  type WorkProductToolConfig,
} from '../src/work-product/index'

const CTX: AppToolContext = { userId: 'u1', workspaceId: 'ws', threadId: 'thread-1' }
const NO_HANDLERS = {} as AppToolHandlers
const NO_TAXONOMY: AppToolTaxonomy = { proposalTypes: [], regulatedTypes: [] }

const W2_TEXT = [
  'FORM W-2  Wage and Tax Statement          Tax Year 2025',
  '--------------------------------------------------------------------',
  'Box 1   Wages, tips, other compensation ......... 128,450.00',
  'Box 2   Federal income tax withheld .............  17,908.00',
  'Box 3   Social security wages ................... 132,900.00',
].join('\n')

const ORGANIZER_TEXT = [
  'CHARITABLE',
  '  - $2,150 cash to St. Bartholomew Parish over the year. We have the',
  '    year-end acknowledgment letter from the church.',
  'OTHER',
  '  - No HSA, no IRA contributions, no 529 contributions in 2025.',
  '  - No estimated federal payments made for 2025.',
].join('\n')

/** Locate a line the way a model reading a paged document would: it has the
 *  text and reports where in it the value sits. Nothing here is a fixture —
 *  the offsets are derived from the same strings the tool reads. */
function spanOf(text: string, needle: string): { start: number; end: number } {
  const start = text.indexOf(needle)
  if (start < 0) throw new Error(`test fixture bug: ${JSON.stringify(needle)} not in source`)
  return { start, end: start + needle.length }
}

const W2_BOX1_LINE = 'Box 1   Wages, tips, other compensation ......... 128,450.00'
const W2_BOX2_LINE = 'Box 2   Federal income tax withheld .............  17,908.00'
const ORGANIZER_CHARITY_LINE = '  - $2,150 cash to St. Bartholomew Parish over the year. We have the'

function harness(overrides: Partial<WorkProductToolConfig> = {}) {
  const store = createInMemoryWorkProductStore()
  const texts: Record<string, string | null> = {
    'vault/w2.pdf': W2_TEXT,
    'vault/organizer.txt': ORGANIZER_TEXT,
    'vault/scan.png': null,
  }
  let id = 0
  const tools = buildWorkProductTools({
    store,
    artifactKinds: ['return_package'],
    exceptionKinds: ['missing_document'],
    resolveSourceRef: async (ref) => ref in texts,
    readSourceText: async (ref) => texts[ref] ?? null,
    materialTargets: (artifact) => Object.keys(artifact.fields ?? {}),
    provenance: () => ({ profileHash: 'hash-a', runId: 'run-1', sessionId: 'sess-1' }),
    now: () => 1_000,
    generateId: () => `wp-${++id}`,
    ...overrides,
  })
  const dispatch = (name: string, args: Record<string, unknown>) =>
    dispatchAppTool(name, args, CTX, { handlers: NO_HANDLERS, taxonomy: NO_TAXONOMY, customTools: tools })
  return { store, dispatch, texts }
}

const SCOPE = 'return:whitfield:2025'

async function onlyRecord(store: ReturnType<typeof createInMemoryWorkProductStore>): Promise<WorkProductRecord> {
  const rows = await store.listByWorkspace('ws')
  expect(rows).toHaveLength(1)
  return rows[0]!
}

describe('sliceSourceSpan — the platform produces the quote', () => {
  it('returns exactly the characters in [start, end)', () => {
    const span = spanOf(W2_TEXT, W2_BOX1_LINE)
    const result = sliceSourceSpan(W2_TEXT, span)
    expect(result).toEqual({ ok: true, quote: W2_BOX1_LINE })
  })

  it('every span it accepts also satisfies the verbatim gate — by construction', () => {
    // The invariant that makes rejection redundant for span citations: walk a
    // grid of ranges over both documents and assert the produced quote passes
    // the SAME check a model-typed quote must pass.
    let checked = 0
    for (const text of [W2_TEXT, ORGANIZER_TEXT]) {
      for (let start = 0; start < text.length; start += 7) {
        for (const width of [1, 12, 40, 120]) {
          const result = sliceSourceSpan(text, { start, end: Math.min(text.length, start + width) })
          if (!result.ok) continue
          expect(sourceContainsQuote(text, result.quote)).toBe(true)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(100)
  })

  it('refuses a whitespace-only range — a real slice, but not a click target', () => {
    const start = W2_TEXT.indexOf('  Wage and Tax')
    expect(sliceSourceSpan(W2_TEXT, { start, end: start + 2 })).toEqual({
      ok: false,
      failure: { reason: 'blank' },
    })
  })

  it('refuses an inverted, negative, fractional or past-the-end range', () => {
    expect(sliceSourceSpan(W2_TEXT, { start: 40, end: 40 })).toEqual({ ok: false, failure: { reason: 'inverted' } })
    expect(sliceSourceSpan(W2_TEXT, { start: 40, end: 10 })).toEqual({ ok: false, failure: { reason: 'inverted' } })
    expect(sliceSourceSpan(W2_TEXT, { start: -1, end: 10 })).toEqual({
      ok: false,
      failure: { reason: 'negative', field: 'start' },
    })
    expect(sliceSourceSpan(W2_TEXT, { start: 1.5, end: 10 })).toEqual({
      ok: false,
      failure: { reason: 'not_integer', field: 'start' },
    })
    expect(sliceSourceSpan(W2_TEXT, { start: 0, end: W2_TEXT.length + 1 })).toEqual({
      ok: false,
      failure: { reason: 'out_of_range', totalChars: W2_TEXT.length },
    })
  })
})

describe('upsert_evidence — span citation', () => {
  it('slices the quote from the document and stamps it platform-sourced', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_box1',
          sourceRef: 'vault/w2.pdf',
          locator: { span: spanOf(W2_TEXT, W2_BOX1_LINE) },
          target: 'line_1a',
          claim: 'Wages 128450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence[0]!.locator.quote).toBe(W2_BOX1_LINE)
    expect(record.evidence[0]!.locator.quoteBasis).toBe('span')
  })

  it('returns the sliced text to the model so it can see what its offsets selected', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_box2',
          sourceRef: 'vault/w2.pdf',
          locator: { span: spanOf(W2_TEXT, W2_BOX2_LINE) },
          target: 'line_25a',
          claim: 'Withholding 17908.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    expect((outcome as { result: { entries: unknown[] } }).result.entries).toEqual([
      { id: 'ev_w2_box2', target: 'line_25a', quote: W2_BOX2_LINE, quoteBasis: 'span' },
    ])
  })

  it('lets the document overrule a quote the model retyped wrong alongside a correct span', async () => {
    // The measured failure mode: right value, wrong wording. With a span the
    // model's transcription is not the citation — refusing here would recreate
    // the 85% rejection rate for no reviewer benefit.
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_box1',
          sourceRef: 'vault/w2.pdf',
          locator: {
            span: spanOf(W2_TEXT, W2_BOX1_LINE),
            quote: 'Box 1 Wages, tips, other compensation: $128,450.00',
          },
          target: 'line_1a',
          claim: 'Wages 128450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence[0]!.locator.quote).toBe(W2_BOX1_LINE)
    expect(sourceContainsQuote(W2_TEXT, record.evidence[0]!.locator.quote!)).toBe(true)
  })

  it('refuses a span past the end of the document, naming the real length', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_bad',
          sourceRef: 'vault/w2.pdf',
          locator: { span: { start: 0, end: W2_TEXT.length + 500 } },
          target: 'line_1a',
          claim: 'Wages',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('invalid_span')
    expect((outcome as { message: string }).message).toContain(`${W2_TEXT.length} characters`)
  })

  it('refuses a span into a source with no readable text — fail-closed, like a quote', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_scan',
          sourceRef: 'vault/scan.png',
          locator: { span: { start: 0, end: 10 } },
          target: 'line_1a',
          claim: 'Wages',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('unverifiable_quote')
  })

  it('rejects a malformed span at the codec, before any document is read', async () => {
    const { dispatch } = harness({
      readSourceText: async () => {
        throw new Error('must not read the document for a structurally invalid span')
      },
    })
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_bad',
          sourceRef: 'vault/w2.pdf',
          locator: { span: { start: 10, end: 4 } },
          target: 'line_1a',
          claim: 'Wages',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('invalid_evidence')
  })

  it('refuses a span when the product wired no way to read sources — never a silent drop', async () => {
    const { dispatch } = harness({ readSourceText: undefined })
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_span',
          sourceRef: 'vault/w2.pdf',
          locator: { span: { start: 0, end: 10 } },
          target: 'line_1a',
          claim: 'Wages',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('span_unsupported')
  })

  it('discards a model-supplied quoteBasis — a model may not label its own quote verified', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_liar',
          sourceRef: 'vault/organizer.txt',
          locator: { quoteBasis: 'span', range: '¶1' },
          target: 'line_12',
          claim: 'no anchor at all',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence[0]!.locator.quoteBasis).toBeUndefined()
  })

  it('the codec drops quoteBasis on its own, without help from the tool layer', () => {
    const parsed = parseEvidenceInput({
      id: 'ev',
      sourceRef: 'vault/w2.pdf',
      target: 'line_1a',
      claim: 'x',
      locator: { quote: W2_BOX1_LINE, quoteBasis: 'span' },
    })
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.locator.quoteBasis).toBeUndefined()
  })

  it('leaves an unverified quote unlabelled when the product wired no source reader', async () => {
    // The hole a single guard leaves: with no `readSourceText` the shell proves
    // nothing, so a model-claimed basis must not survive into the row a
    // reviewer reads as "platform-sliced".
    const { dispatch, store } = harness({ readSourceText: undefined })
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_unchecked',
          sourceRef: 'vault/w2.pdf',
          locator: { quote: 'Box 1 Wages, tips, other compensation: $128,450.00', quoteBasis: 'span' },
          target: 'line_1a',
          claim: '128450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence[0]!.locator.quote).toBe('Box 1 Wages, tips, other compensation: $128,450.00')
    expect(record.evidence[0]!.locator.quoteBasis).toBeUndefined()
  })
})

describe('submit_work_product — what the recorded checks say', () => {
  const ARTIFACT = {
    kind: 'return_package',
    title: 'Whitfield 2025 federal return',
    fields: { line_1a: 128_450, line_25a: 17_908 },
  }

  async function evidenceFor(dispatch: ReturnType<typeof harness>['dispatch'], locators: Record<string, unknown>[]) {
    return dispatch('upsert_evidence', { scopeKey: SCOPE, entries: locators })
  }

  it('reports the anchoring breakdown, not just a covered count', async () => {
    const { dispatch, store } = harness()
    await evidenceFor(dispatch, [
      {
        id: 'ev1',
        sourceRef: 'vault/w2.pdf',
        locator: { span: spanOf(W2_TEXT, W2_BOX1_LINE) },
        target: 'line_1a',
        claim: '128450.00',
      },
      {
        id: 'ev2',
        sourceRef: 'vault/w2.pdf',
        locator: { quote: W2_BOX2_LINE },
        target: 'line_25a',
        claim: '17908.00',
      },
    ])
    const outcome = await dispatch('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    const coverage = record.checks.find((check) => check.name === 'evidence_coverage')!
    expect(coverage.passed).toBe(true)
    expect(coverage.detail).toBe('2/2 material targets evidenced (1 span-anchored, 1 quote-verified, 0 claim-only)')
    const quotes = record.checks.find((check) => check.name === 'quote_verification')!
    expect(quotes.passed).toBe(true)
    expect(quotes.detail).toContain('2/2 quoted evidence entries verified')
    expect(quotes.detail).toContain('1 platform-sliced from a source span')
  })

  it('counts a claim-only target as claim-only, and passes when anchoring is not required', async () => {
    const { dispatch, store } = harness()
    await evidenceFor(dispatch, [
      {
        id: 'ev1',
        sourceRef: 'vault/w2.pdf',
        locator: { span: spanOf(W2_TEXT, W2_BOX1_LINE) },
        target: 'line_1a',
        claim: '128450.00',
      },
      { id: 'ev2', sourceRef: 'vault/w2.pdf', locator: {}, target: 'line_25a', claim: 'computed' },
    ])
    const outcome = await dispatch('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    const coverage = record.checks.find((check) => check.name === 'evidence_coverage')!
    expect(coverage.detail).toBe('2/2 material targets evidenced (1 span-anchored, 0 quote-verified, 1 claim-only)')
  })

  it('refuses a bare assertion when the product requires source anchors', async () => {
    const { dispatch, store } = harness({ requireAnchoredEvidence: true })
    await evidenceFor(dispatch, [
      {
        id: 'ev1',
        sourceRef: 'vault/w2.pdf',
        locator: { span: spanOf(W2_TEXT, W2_BOX1_LINE) },
        target: 'line_1a',
        claim: '128450.00',
      },
      { id: 'ev2', sourceRef: 'vault/w2.pdf', locator: {}, target: 'line_25a', claim: 'trust me' },
    ])
    const outcome = await dispatch('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('evidence_not_anchored')
    expect((outcome as { message: string }).message).toContain('line_25a')
    expect((outcome as { message: string }).message).toContain('locator.find')
    const record = await onlyRecord(store)
    expect(record.status).toBe('draft')
    const coverage = record.checks.find((check) => check.name === 'evidence_coverage')!
    expect(coverage.passed).toBe(false)
    expect(coverage.detail).toBe('No source anchor for: line_25a')
  })

  it('fails a span citation whose source changed underneath it', async () => {
    // Re-slicing, not substring search: the sentence survives in the new file,
    // but the offsets no longer select it, so the reviewer's click target has
    // moved and the check must say so.
    const h = harness()
    await evidenceFor(h.dispatch, [
      {
        id: 'ev1',
        sourceRef: 'vault/w2.pdf',
        locator: { span: spanOf(W2_TEXT, W2_BOX1_LINE) },
        target: 'line_1a',
        claim: '128450.00',
      },
      {
        id: 'ev2',
        sourceRef: 'vault/w2.pdf',
        locator: { span: spanOf(W2_TEXT, W2_BOX2_LINE) },
        target: 'line_25a',
        claim: '17908.00',
      },
    ])
    h.texts['vault/w2.pdf'] = `AMENDED COPY\n${W2_TEXT}`
    const outcome = await h.dispatch('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('quote_verification_failed')
    const record = await onlyRecord(h.store)
    expect(record.status).toBe('draft')
    expect(record.checks.find((check) => check.name === 'quote_verification')!.detail).toContain('ev1, ev2')
  })
})

describe('the retyping bottleneck the span form removes', () => {
  it('the production quotes that were refused are all reachable as spans', async () => {
    // Every one of these is a value the production row cited with invented
    // wording. Cited as a span, each one lands on the real line — same values,
    // now with lineage a reviewer can click.
    const { dispatch, store } = harness()
    const targets: Array<[string, string, string, string]> = [
      ['ev_box1', 'vault/w2.pdf', W2_BOX1_LINE, 'line_1a'],
      ['ev_box2', 'vault/w2.pdf', W2_BOX2_LINE, 'line_25a'],
      ['ev_charity', 'vault/organizer.txt', ORGANIZER_CHARITY_LINE, 'line_12'],
    ]
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: targets.map(([id, ref, line, target]) => ({
        id,
        sourceRef: ref,
        locator: { span: spanOf(ref === 'vault/w2.pdf' ? W2_TEXT : ORGANIZER_TEXT, line) },
        target,
        claim: 'read from the document',
      })),
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence).toHaveLength(3)
    for (const entry of record.evidence) {
      expect(entry.locator.quoteBasis).toBe('span')
      const text = entry.sourceRef === 'vault/w2.pdf' ? W2_TEXT : ORGANIZER_TEXT
      expect(sourceContainsQuote(text, entry.locator.quote!)).toBe(true)
    }
  })

  it('ToolInputError for a wrong quote points the model at anchor-by-value, not at retyping harder', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_bad',
          sourceRef: 'vault/w2.pdf',
          locator: { quote: 'Box 1 Wages, tips, other compensation: $128,450.00' },
          target: 'line_1a',
          claim: '128450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('quote_not_found')
    expect((outcome as { message: string }).message).toContain('locator.find')
  })
})

describe('ToolInputError shape stays correctable', () => {
  it('every span rejection is a 400-class model-correctable error, not a 500', () => {
    const error = new ToolInputError('invalid_span', 'x')
    expect(error.status).toBe(400)
  })
})

/**
 * Anchor-by-value: the citation form for a model that cannot count.
 *
 * Not a hypothetical. On production tax session `135b7cc3` (gpt-4.1-mini),
 * given the document text and told exactly which line to cite, the model
 * produced spans that landed on the WRONG line 4 times out of 4 — then missed
 * again on a second attempt after being shown the text its offsets had
 * selected. Every quote was genuine document text (spans made fabrication
 * impossible, as designed) and every one cited the employer/payer line
 * instead of the value line.
 *
 * Its four `claim` values were correct to the cent. So the model names the
 * value; the platform finds it.
 */
describe('findSourceLine — the platform locates the value', () => {
  it('cites the whole line a value sits on, not the bare value', () => {
    const found = findSourceLine(W2_TEXT, '128,450.00')
    expect(found).toMatchObject({ ok: true, quote: W2_BOX1_LINE, occurrences: 1 })
    expect(found.ok && W2_TEXT.slice(found.span.start, found.span.end)).toBe(W2_BOX1_LINE)
  })

  it('lands on the value line where a hand-computed offset landed on the wrong one', () => {
    // 97-132 is the span the production model actually emitted for wages.
    expect(sliceSourceSpan(W2_TEXT, { start: 97, end: 132 })).toMatchObject({ ok: true })
    expect(W2_TEXT.slice(97, 132)).not.toContain('128,450.00')
    const found = findSourceLine(W2_TEXT, '128,450.00')
    expect(found.ok && found.quote).toContain('128,450.00')
  })

  it('refuses a value the document does not contain', () => {
    expect(findSourceLine(W2_TEXT, '999,999.00')).toEqual({ ok: false, failure: { reason: 'not_found' } })
    expect(findSourceLine(W2_TEXT, '   ')).toEqual({ ok: false, failure: { reason: 'blank_needle' } })
  })

  it('finds a value typed without its thousands separator', () => {
    const found = findSourceLine(W2_TEXT, '128450.00')
    expect(found.ok && found.quote).toBe(W2_BOX1_LINE)
  })

  it('counts repeats and honours findOccurrence', () => {
    // A needle long enough to be a citation at all — see the
    // needle-distinctiveness suite for why '42' no longer qualifies.
    const text = 'alpha 42.50 one\nbeta 42.50 two\ngamma 42.50 three'
    expect(findSourceLine(text, '42.50')).toMatchObject({ ok: true, quote: 'alpha 42.50 one', occurrences: 3 })
    expect(findSourceLine(text, '42.50', 3)).toMatchObject({ ok: true, quote: 'gamma 42.50 three' })
    expect(findSourceLine(text, '42.50', 4)).toEqual({
      ok: false,
      failure: { reason: 'occurrence_out_of_range', found: 3 },
    })
  })

  it('never returns text that is not a verbatim slice of the source', () => {
    for (const text of [W2_TEXT, ORGANIZER_TEXT, 'a\r\nb 7\r\nc']) {
      for (const needle of ['7', '128,450.00', '2,150', 'Box', 'church', 'b']) {
        const found = findSourceLine(text, needle)
        if (!found.ok) continue
        expect(text.slice(found.span.start, found.span.end)).toBe(found.quote)
        expect(sourceContainsQuote(text, found.quote)).toBe(true)
      }
    }
  })

  it('strips the CR of a CRLF line so the quote is the line a reader sees', () => {
    const found = findSourceLine('header\r\nBox 1 pay 500.00\r\nfooter', '500.00')
    expect(found.ok && found.quote).toBe('Box 1 pay 500.00')
  })
})

describe('upsert_evidence — anchor by value', () => {
  it('locates the value, stores the line, and reports the derived span', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_box1',
          sourceRef: 'vault/w2.pdf',
          locator: { find: '128,450.00' },
          target: 'line_1a',
          claim: 'Wages 128450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    const entry = record.evidence[0]!
    expect(entry.locator.quote).toBe(W2_BOX1_LINE)
    expect(entry.locator.quoteBasis).toBe('span')
    expect(W2_TEXT.slice(entry.locator.span!.start, entry.locator.span!.end)).toBe(W2_BOX1_LINE)
  })

  it('refuses a value the named document does not contain', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_bad',
          sourceRef: 'vault/w2.pdf',
          locator: { find: '999,999.00' },
          target: 'line_1a',
          claim: 'Wages 999999',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('value_not_found')
    expect((outcome as { message: string }).message).toContain('999,999.00')
    expect(await store.listByWorkspace('ws')).toEqual([])
  })

  it('overrules a hand-computed span when a value is also given', async () => {
    // The production shape exactly: a correct value and a span that misses.
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_box1',
          sourceRef: 'vault/w2.pdf',
          locator: { find: '128,450.00', span: { start: 97, end: 132 } },
          target: 'line_1a',
          claim: 'Wages 128450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence[0]!.locator.quote).toBe(W2_BOX1_LINE)
    expect(record.evidence[0]!.locator.quote).toContain('128,450.00')
  })

  it('counts as an anchored target under requireAnchoredEvidence', async () => {
    const { dispatch } = harness({ requireAnchoredEvidence: true })
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        { id: 'e1', sourceRef: 'vault/w2.pdf', locator: { find: '128,450.00' }, target: 'line_1a', claim: '128450.00' },
        { id: 'e2', sourceRef: 'vault/w2.pdf', locator: { find: '17,908.00' }, target: 'line_25a', claim: '17908.00' },
      ],
    })
    const outcome = await dispatch('submit_work_product', {
      scopeKey: SCOPE,
      artifact: { kind: 'return_package', title: 'T', fields: { line_1a: 128450, line_25a: 17908 } },
    })
    expect(outcome.ok).toBe(true)
  })

  it('is fail-closed when the source has no readable text', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        { id: 'ev', sourceRef: 'vault/scan.png', locator: { find: '1' }, target: 'line_1a', claim: 'x' },
      ],
    })
    expect(outcome).toMatchObject({ ok: false, code: 'unverifiable_quote' })
  })
})

/**
 * A needle must actually identify a place.
 *
 * Production work product `b9a37e44` (session e34d9f19, gpt-4.1-mini) reached
 * `ready` with `quote_verification: 16/16 verified` and
 * `evidence_coverage: 15/15 material targets evidenced (15 span-anchored)` —
 * genuinely good on the seven lines the documents state. The other NINE were
 * lines the 1099-DIV does not mention at all, cited with the value "0", and
 * the platform faithfully located the "0" inside "Tax Year 2025" in the
 * header. Every one re-sliced byte-exactly. Every one was worthless.
 *
 * That is the third turn of the same screw: verified-but-fabricated, then
 * sliced-but-mis-addressed, now located-but-not-evidential. A citation has to
 * point somewhere a reviewer can judge.
 */
describe('findSourceLine — a needle must identify a place', () => {
  it('refuses the production needle: a bare "0" matching the year in a header', () => {
    const HEADER = 'FORM 1099-DIV  Dividends and Distributions          Tax Year 2025'
    const DIV = [HEADER, 'Box 1a  Total ordinary dividends ................   2,204.18'].join('\n')
    // The old behaviour, stated so the regression is unmistakable: "0" is in
    // the header, so a naive locate cites the header.
    expect(HEADER).toContain('0')
    expect(findSourceLine(DIV, '0')).toEqual({
      ok: false,
      failure: { reason: 'not_distinctive', needle: '0', found: 0 },
    })
  })

  it('refuses any one- or two-character needle', () => {
    for (const needle of ['0', '7', '.5', '1a']) {
      expect(findSourceLine(W2_TEXT, needle), needle).toMatchObject({
        ok: false,
        failure: { reason: 'not_distinctive' },
      })
    }
  })

  it('still accepts a real value of three characters or more', () => {
    expect(findSourceLine(W2_TEXT, '128,450.00')).toMatchObject({ ok: true, quote: W2_BOX1_LINE })
    expect(findSourceLine(ORGANIZER_TEXT, '2,150')).toMatchObject({ ok: true })
  })

  it('refuses a needle that matches all over the document', () => {
    const noisy = Array.from({ length: 12 }, (_, i) => `row ${i} value 100.00`).join('\n')
    const result = findSourceLine(noisy, '100.00')
    expect(result).toMatchObject({ ok: false, failure: { reason: 'not_distinctive', found: 12 } })
  })

  it('lets an explicit findOccurrence cite a genuinely repeated value', () => {
    const noisy = Array.from({ length: 12 }, (_, i) => `row ${i} value 100.00`).join('\n')
    expect(findSourceLine(noisy, '100.00', 3)).toMatchObject({ ok: true, quote: 'row 2 value 100.00' })
  })
})

describe('upsert_evidence — a non-distinctive needle is refused, with the way out', () => {
  it('refuses it and says what to do instead', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        { id: 'ev_zero', sourceRef: 'vault/w2.pdf', locator: { find: '0' }, target: 'line_4a', claim: '0' },
      ],
    })
    expect(outcome.ok).toBe(false)
    expect((outcome as { code: string }).code).toBe('value_not_found')
    const message = (outcome as { message: string }).message
    expect(message).toContain('too short')
    // The way out must be stated, or this becomes another unsatisfiable gate.
    expect(message).toContain('omit the locator')
    expect(await store.listByWorkspace('ws')).toEqual([])
  })

  it('leaves the honest alternative available — a claim with no locator', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_zero',
          sourceRef: 'vault/w2.pdf',
          locator: {},
          target: 'line_4a',
          claim: 'No IRA distributions — the W-2 and the organizer do not report any.',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence[0]!.locator.quoteBasis).toBeUndefined()
  })
})
