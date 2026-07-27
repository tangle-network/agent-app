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
    expect((outcome as { message: string }).message).toContain('locator.span')
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

  it('ToolInputError for a wrong quote points the model at spans, not at retyping harder', async () => {
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
    expect((outcome as { message: string }).message).toContain('locator.span')
  })
})

describe('ToolInputError shape stays correctable', () => {
  it('every span rejection is a 400-class model-correctable error, not a 500', () => {
    const error = new ToolInputError('invalid_span', 'x')
    expect(error.status).toBe(400)
  })
})
