/**
 * The lineage gate: an evidence quote must occur in the document it names.
 *
 * The fixtures are not invented. `W2_TEXT` and `ORGANIZER_TEXT` are excerpts
 * of two source documents from tax session
 * `bed5083d-b21b-4bfc-a909-969f21c398e6`, and every string in
 * `FABRICATED_PRODUCTION_QUOTES` is a `locator.quote` that work-product row
 * `a68b1943-130d-4bf8-90ee-044202463482` shipped to production — 38 of 38 of
 * which occur in none of the six cited documents. The values in them are
 * correct; the quotes were composed rather than copied. Verifying against the
 * real bytes is the point: a synthetic "quote that obviously does not match"
 * would not prove the gate catches the near-misses that actually shipped.
 */

import { describe, expect, it } from 'vitest'

import { dispatchAppTool, type AppToolContext, type AppToolHandlers, type AppToolTaxonomy } from '../src/tools/index'
import {
  buildWorkProductTools,
  createInMemoryWorkProductStore,
  normalizeQuoteText,
  sourceContainsQuote,
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

/** Verbatim `locator.quote` values from the production row. */
const FABRICATED_PRODUCTION_QUOTES = [
  // Reformatted: a colon and a `$` the document does not have, dot leaders dropped.
  'Box 1 Wages, tips, other compensation: $128,450.00',
  'Box 2 Federal income tax withheld: $17,908.00',
  // Reworded — the document says "$2,150 cash to St. Bartholomew Parish".
  'Cash contributions to charity: $2,150',
  // A proposition the organizer never states: "no alimony" is invented and
  // "529" is dropped.
  'No HSA, no IRA contributions, no alimony; sole proprietorship tutoring activity present.',
  // Propositions no cited document contains at all — the agent's own reasoning
  // attributed to the client's note.
  'Standard deduction MFJ applied; no QBI deduction.',
  '2025 MFJ rate schedule applied to taxable income.',
  'Pensions/annuities: none',
  'Social Security benefits received: none',
  'Retirement distributions (1099-R): none',
]

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
  return { store, dispatch }
}

const SCOPE = 'return:whitfield:2025'

describe('sourceContainsQuote — verbatim, tolerant only of representation', () => {
  it('accepts an exact substring', () => {
    expect(sourceContainsQuote(W2_TEXT, 'Box 1   Wages, tips, other compensation ......... 128,450.00')).toBe(true)
  })

  it('accepts a quote whose only difference is whitespace runs', () => {
    expect(sourceContainsQuote(W2_TEXT, 'Box 1 Wages, tips, other compensation ......... 128,450.00')).toBe(true)
  })

  it('accepts curly quotes, non-breaking hyphens and NBSP against their ASCII source', () => {
    const source = 'the year-end acknowledgment letter from the church, "as filed"'
    expect(sourceContainsQuote(source, 'the year‑end acknowledgment letter from the church, “as filed”')).toBe(true)
  })

  it('rejects an empty or whitespace-only quote instead of matching every document', () => {
    expect(sourceContainsQuote(W2_TEXT, '')).toBe(false)
    expect(sourceContainsQuote(W2_TEXT, '   \n\t ')).toBe(false)
  })

  it('rejects a case change — a citation that cannot reproduce capitalization did not read the source', () => {
    expect(sourceContainsQuote(W2_TEXT, 'box 1   wages, tips, other compensation ......... 128,450.00')).toBe(false)
  })

  it('rejects a right-value wrong-wording quote — the whole defect class', () => {
    expect(W2_TEXT).toContain('128,450.00')
    expect(sourceContainsQuote(W2_TEXT, 'Box 1 Wages, tips, other compensation: $128,450.00')).toBe(false)
  })

  it('rejects every quote the production row shipped', () => {
    const corpus = `${W2_TEXT}\n\n${ORGANIZER_TEXT}`
    const matched = FABRICATED_PRODUCTION_QUOTES.filter((quote) => sourceContainsQuote(corpus, quote))
    expect(matched).toEqual([])
  })

  it('normalizeQuoteText folds representation without folding case', () => {
    expect(normalizeQuoteText('  Box 1  Wages — "x"  ')).toBe('Box 1 Wages - "x"')
    expect(normalizeQuoteText('Box 1')).not.toBe(normalizeQuoteText('box 1'))
  })
})

describe('upsert_evidence — the quote gate', () => {
  it('accepts an entry whose quote occurs in the named source', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_box1',
          sourceRef: 'vault/w2.pdf',
          locator: { range: 'Box 1', quote: 'Box 1   Wages, tips, other compensation ......... 128,450.00' },
          target: 'line_1a',
          claim: 'W-2 Box 1 wages $128,450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const [row] = await store.listByWorkspace('ws')
    expect(row?.evidence).toHaveLength(1)
  })

  it('REFUSES the production quote — right value, wording the document does not contain', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_daniel_wages_box1',
          sourceRef: 'vault/w2.pdf',
          locator: { range: 'Box 1', quote: 'Box 1 Wages, tips, other compensation: $128,450.00' },
          target: 'line_1a',
          claim: 'Daniel R. Whitfield Form W-2 Box 1 wages $128,450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe('quote_not_found')
    expect(outcome.message).toContain('entries[0].locator.quote')
    expect(outcome.message).toContain('vault/w2.pdf')
    // The error must teach the correction, not just deny.
    expect(outcome.message).toContain('character-for-character')
    expect(outcome.message).toContain('omit locator.quote')
    // Nothing persisted: a rejected batch leaves no half-written row.
    expect(await store.listByWorkspace('ws')).toEqual([])
  })

  it('names the offending index so a 3-entry batch is correctable precisely', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ok1',
          sourceRef: 'vault/w2.pdf',
          locator: { quote: 'Box 2   Federal income tax withheld .............  17,908.00' },
          target: 'line_25a',
          claim: '$17,908.00',
        },
        {
          id: 'ok2',
          sourceRef: 'vault/organizer.txt',
          locator: { quote: 'No estimated federal payments made for 2025.' },
          target: 'line_26',
          claim: '$0.00',
        },
        {
          id: 'bad',
          sourceRef: 'vault/organizer.txt',
          locator: { quote: 'Pensions/annuities: none' },
          target: 'line_5a',
          claim: '$0.00',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.message).toContain('entries[2].locator.quote')
  })

  it('accepts a computed value recorded WITHOUT a quote — the honest shape for a derived line', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_taxable_income',
          sourceRef: 'vault/organizer.txt',
          locator: { range: 'derived' },
          target: 'line_15',
          claim: 'line 11 AGI $203,318.90 less line 12 standard deduction $31,500 = $171,818.90',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const [row] = await store.listByWorkspace('ws')
    expect(row?.evidence[0]?.locator.quote).toBeUndefined()
  })

  it('is fail-CLOSED on a source with no readable text — unverifiable never reads as verified', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_scan',
          sourceRef: 'vault/scan.png',
          locator: { quote: 'Box 1 Wages 128,450.00' },
          target: 'line_1a',
          claim: '$128,450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe('unverifiable_quote')
  })

  it('reads each distinct source once per batch, not once per entry', async () => {
    let reads = 0
    const { dispatch } = harness({
      readSourceText: async (ref) => {
        reads += 1
        return ref === 'vault/w2.pdf' ? W2_TEXT : ORGANIZER_TEXT
      },
    })
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        { id: 'a', sourceRef: 'vault/w2.pdf', locator: { quote: 'Box 1   Wages' }, target: 't1', claim: 'x' },
        { id: 'b', sourceRef: 'vault/w2.pdf', locator: { quote: 'Box 2   Federal' }, target: 't2', claim: 'y' },
        { id: 'c', sourceRef: 'vault/w2.pdf', locator: { quote: 'Box 3   Social' }, target: 't3', claim: 'z' },
      ],
    })
    expect(outcome.ok).toBe(true)
    expect(reads).toBe(1)
  })

  it('checks nothing when readSourceText is not wired — the seam is opt-in and additive', async () => {
    const { dispatch, store } = harness({ readSourceText: undefined })
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_unchecked',
          sourceRef: 'vault/w2.pdf',
          locator: { quote: 'Box 1 Wages, tips, other compensation: $128,450.00' },
          target: 'line_1a',
          claim: '$128,450.00',
        },
      ],
    })
    expect(outcome.ok).toBe(true)
    const [row] = await store.listByWorkspace('ws')
    expect(row?.evidence).toHaveLength(1)
  })
})

describe('submit_work_product — the persisted-quote re-check', () => {
  const ARTIFACT = {
    kind: 'return_package',
    title: '2025 Form 1040 — Whitfield',
    content: '# Return package',
    fields: { line_1a: '128450.00' },
  }

  it('records the verification count as a platform check on a clean package', async () => {
    const { dispatch, store } = harness()
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_quoted',
          sourceRef: 'vault/w2.pdf',
          locator: { quote: 'Box 1   Wages, tips, other compensation ......... 128,450.00' },
          target: 'line_1a',
          claim: '$128,450.00',
        },
        {
          id: 'ev_derived',
          sourceRef: 'vault/organizer.txt',
          locator: { range: 'derived' },
          target: 'line_1a',
          claim: 'sum of both W-2 Box 1 amounts',
        },
      ],
    })
    const outcome = await dispatch('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT })
    expect(outcome.ok).toBe(true)
    const [row] = await store.listByWorkspace('ws')
    const check = row?.checks.find((entry) => entry.name === 'quote_verification')
    expect(check?.source).toBe('platform')
    expect(check?.passed).toBe(true)
    expect(check?.detail).toBe(
      '1/1 quoted evidence entries verified against their source; 1 recorded without a quote',
    )
  })

  it('REFUSES a package whose evidence was written before the gate existed', async () => {
    // Emit through an ungated build (the pre-fix world), then submit through
    // the gated one against the SAME store — the production situation.
    const store = createInMemoryWorkProductStore()
    const texts: Record<string, string> = { 'vault/w2.pdf': W2_TEXT }
    const base: WorkProductToolConfig = {
      store,
      artifactKinds: ['return_package'],
      exceptionKinds: ['missing_document'],
      resolveSourceRef: async (ref) => ref in texts,
      materialTargets: (artifact) => Object.keys(artifact.fields ?? {}),
      provenance: () => ({ profileHash: 'hash-a', runId: 'run-1', sessionId: 'sess-1' }),
      now: () => 1_000,
      generateId: () => 'wp-1',
    }
    const run = (config: WorkProductToolConfig) => (name: string, args: Record<string, unknown>) =>
      dispatchAppTool(name, args, CTX, {
        handlers: NO_HANDLERS,
        taxonomy: NO_TAXONOMY,
        customTools: buildWorkProductTools(config),
      })

    const ungated = await run(base)('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'ev_w2_daniel_wages_box1',
          sourceRef: 'vault/w2.pdf',
          locator: { quote: 'Box 1 Wages, tips, other compensation: $128,450.00' },
          target: 'line_1a',
          claim: '$128,450.00',
        },
      ],
    })
    expect(ungated.ok).toBe(true)

    const gated = { ...base, readSourceText: async (ref: string) => texts[ref] ?? null }
    const outcome = await run(gated)('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe('quote_verification_failed')
    expect(outcome.message).toContain('ev_w2_daniel_wages_box1')

    // The failing check is RECORDED on the row, and the row never reaches ready.
    const [row] = await store.listByWorkspace('ws')
    expect(row?.status).not.toBe('ready')
    const check = row?.checks.find((entry) => entry.name === 'quote_verification')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toContain('ev_w2_daniel_wages_box1')
  })
})
