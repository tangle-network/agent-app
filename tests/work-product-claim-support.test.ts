/**
 * Claim support: a citation that does not support its claim cannot be persisted.
 *
 * The two gates that came before this one both pass on the production defect.
 * `work-product-quote-verification.test.ts` proves a fabricated quote is
 * refused; `work-product-span-citation.test.ts` proves the platform writes the
 * quote so it cannot be fabricated at all. Both are about where the TEXT came
 * from. Row `7256ef49` shipped four citations that satisfy both and support
 * nothing — real slices of the right documents, landing on the payer line ~200
 * characters above the figure claimed.
 *
 * `PROD_*` below are those three documents, reconstructed so that the spans
 * production actually stored slice to the bytes production actually stored.
 * `production row 7256ef49 — the fixture is the real row` asserts that
 * character-for-character, so this suite cannot drift into measuring a
 * convenient invention: if the fixture stops matching the production evidence,
 * the fixture test fails first.
 *
 * The value lines came from the same session's `document_citations` rows, which
 * `submit_tax_citation` wrote by SEARCHING each document — 37 valid, and all 4
 * of these valid at 20:40–20:43Z, the same turn that produced the misaligned
 * spans.
 */

import { describe, expect, it } from 'vitest'

import { ToolInputError } from '../src/tools/errors'
import { dispatchAppTool, type AppToolContext, type AppToolHandlers, type AppToolTaxonomy } from '../src/tools/index'
import {
  buildWorkProductTools,
  canonicalizeValue,
  claimValues,
  createInMemoryWorkProductStore,
  valuesInText,
  verifyClaimSupport,
  type WorkProductRecord,
  type WorkProductToolConfig,
} from '../src/work-product/index'

const CTX: AppToolContext = { userId: 'u1', workspaceId: 'ws', threadId: 'thread-1' }
const NO_HANDLERS = {} as AppToolHandlers
const NO_TAXONOMY: AppToolTaxonomy = { proposalTypes: [], regulatedTypes: [] }

// ── the three production source documents ───────────────────────────────────

const PROD_W2 = [
  'Form W-2  Wage and Tax Statement - Tax Year 2025',
  '----------------',
  'Employer: Meridian Robotics LLC   EIN 84-2213907',
  'Employee: Dana R. Whitfield   SSN ***-**-4417',
  '------------------------------------------------------------',
  'Box 1   Wages, tips, other compensation ......... 128,450.00',
  'Box 2   Federal income tax withheld .............  18,900.00',
  'Box 3   Social security wages ................... 128,450.00',
  'Box 12a D  Elective deferrals to 401(k) .........  12,000.00',
  '',
].join('\n')

const PROD_1099INT = [
  'Form 1099-INT  Interest Income - Tax Year 2025',
  '------------------',
  'Payer: Harbor Point Savings Bank   TIN 22-5510983',
  'Recipient: Dana R. Whitfield',
  '------------------------------------------------------------',
  'Box 1   Interest income .........................     812.44',
  '',
].join('\n')

const PROD_1099DIV = [
  'Form 1099-DIV  Dividends and Distributions - TY2025',
  '----------',
  'Payer: Northbridge Index Fund Trust   TIN 47-3320115',
  'Recipient: Dana R. Whitfield',
  '------------------------------------------------------------',
  'Box 1a  Total ordinary dividends ................   2,204.18',
  'Box 1b  Qualified dividends .....................   1,955.02',
  '',
].join('\n')

const W2_REF = '077af74e-5af4-4357-9764-15b48481eec8'
const INT_REF = '2833812f-8fc0-42ce-9dbc-fef9c2a8f3bd'
const DIV_REF = '1b2e31a2-a091-471e-943b-dbcdcb394a9c'

/** The four evidence entries persisted on production row `7256ef49`, verbatim
 *  from the row's `evidence` JSON. */
const PROD_ROW_7256EF49 = [
  {
    id: 'wages_line1',
    sourceRef: W2_REF,
    locator: { span: { start: 89, end: 129 }, quote: 'tics LLC   EIN 84-2213907\nEmployee: Dana', quoteBasis: 'span' },
    target: 'f1040.line_1',
    claim: '128450.00',
  },
  {
    id: 'interest_line2b',
    sourceRef: INT_REF,
    locator: { span: { start: 83, end: 121 }, quote: 'nt Savings Bank   TIN 22-5510983\nRecip', quoteBasis: 'span' },
    target: 'f1040.line_2b',
    claim: '812.44',
  },
  {
    id: 'ordinary_dividends_line3b',
    sourceRef: DIV_REF,
    locator: { span: { start: 83, end: 119 }, quote: 'ndex Fund Trust   TIN 47-3320115\nRec', quoteBasis: 'span' },
    target: 'f1040.line_3b',
    claim: '2204.18',
  },
  {
    id: 'qualified_dividends_line3a',
    sourceRef: DIV_REF,
    locator: { span: { start: 120, end: 157 }, quote: 'pient: Dana R. Whitfield\n------------', quoteBasis: 'span' },
    target: 'f1040.line_3a',
    claim: '1955.02',
  },
] as const

/** The value each entry SHOULD have cited, as it appears in the document —
 *  taken from the valid `document_citations` rows of the same session. */
const PROD_CORRECT_FIND: Record<string, string> = {
  wages_line1: '128,450.00',
  interest_line2b: '812.44',
  ordinary_dividends_line3b: '2,204.18',
  qualified_dividends_line3a: '1,955.02',
}

const PROD_TEXTS: Record<string, string> = {
  [W2_REF]: PROD_W2,
  [INT_REF]: PROD_1099INT,
  [DIV_REF]: PROD_1099DIV,
}

function harness(overrides: Partial<WorkProductToolConfig> = {}) {
  const store = createInMemoryWorkProductStore()
  let id = 0
  const tools = buildWorkProductTools({
    store,
    artifactKinds: ['return_package'],
    exceptionKinds: ['missing_document'],
    resolveSourceRef: async (ref) => ref in PROD_TEXTS,
    readSourceText: async (ref) => PROD_TEXTS[ref] ?? null,
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

async function onlyRecord(store: ReturnType<typeof createInMemoryWorkProductStore>): Promise<WorkProductRecord> {
  const rows = await store.listByWorkspace('ws')
  expect(rows).toHaveLength(1)
  return rows[0]!
}

// ── the fixture is the real row ─────────────────────────────────────────────

describe('production row 7256ef49 — the fixture is the real row', () => {
  it('every span production stored slices to the text production stored', () => {
    for (const entry of PROD_ROW_7256EF49) {
      const text = PROD_TEXTS[entry.sourceRef]!
      expect(text.slice(entry.locator.span.start, entry.locator.span.end)).toBe(entry.locator.quote)
    }
  })

  it('every value line the session cited validly is present in the document', () => {
    expect(PROD_W2).toContain('Box 1   Wages, tips, other compensation ......... 128,450.00')
    expect(PROD_1099INT).toContain('Box 1   Interest income .........................     812.44')
    expect(PROD_1099DIV).toContain('Box 1a  Total ordinary dividends ................   2,204.18')
    expect(PROD_1099DIV).toContain('Box 1b  Qualified dividends .....................   1,955.02')
  })
})

// ── the check itself ────────────────────────────────────────────────────────

describe('canonicalizeValue — comparison is by value, not by characters', () => {
  it('folds currency, grouping and trailing cents to one form', () => {
    for (const token of ['128450.00', '128,450.00', '$128,450.00', '$ 128450', '128450']) {
      expect(canonicalizeValue(token)).toBe('128450')
    }
    expect(canonicalizeValue('1,955.02')).toBe('1955.02')
    expect(canonicalizeValue('22%')).toBe('22')
  })

  it('reads an accounting negative and a signed negative as the same magnitude', () => {
    expect(canonicalizeValue('(1,234.00)')).toBe('1234')
    expect(canonicalizeValue('-1,234.00')).toBe('1234')
    expect(canonicalizeValue('1234')).toBe('1234')
  })

  it('refuses anything that is not a plain number', () => {
    for (const token of ['84-2213907', '2025-04-15', 'Box 1', '', '  ', 'MFJ']) {
      expect(canonicalizeValue(token)).toBeNull()
    }
  })
})

describe('valuesInText — a form line yields the figure on it', () => {
  it('reads a grouped number as ONE value, not two', () => {
    expect(valuesInText('Box 1   Wages, tips, other compensation ......... 128,450.00')).toEqual(['1', '128450'])
  })

  it('does not let dot leaders join a number', () => {
    expect(valuesInText('Box 1   Interest income .........................     812.44')).toEqual(['1', '812.44'])
  })
})

describe('claimValues — strict on figures, silent on everything else', () => {
  it('takes a bare value claim as the value to prove', () => {
    expect(claimValues('128450.00')).toEqual(['128450'])
    expect(claimValues('$30,000')).toEqual(['30000'])
    expect(claimValues('3')).toEqual(['3'])
  })

  it('finds currency-shaped figures inside prose', () => {
    expect(claimValues('indemnity capped at $5,000,000 per occurrence')).toEqual(['5000000'])
    expect(claimValues('interest of 812.44 reported on Box 1')).toEqual(['812.44'])
  })

  it('asserts NOTHING for a claim that carries no figure — the gate must stay satisfiable', () => {
    // A gate an honest answer cannot satisfy does not stop a bad submit, it
    // selects for one. Each of these is a legitimate non-numeric citation.
    for (const claim of [
      'Married Filing Jointly',
      'Dana R. Whitfield',
      'filed on 2025-04-15',
      'EIN 84-2213907',
      'reported on Form 1040 line 13 for tax year 2025',
    ]) {
      expect(claimValues(claim)).toEqual([])
    }
  })
})

describe('verifyClaimSupport', () => {
  it('accepts a line that carries the claimed figure', () => {
    const support = verifyClaimSupport('Box 1   Wages, tips, other compensation ......... 128,450.00', '128450.00')
    expect(support).toEqual({ status: 'supported', matched: '128450' })
  })

  it('REFUSES a tail-of-a-real-number match that a substring test would pass', () => {
    // `text.includes('450.00')` is true here. Values are compared as values,
    // so a claim citing the wrong figure does not survive on shared digits.
    const line = 'Box 1   Wages, tips, other compensation ......... 128,450.00'
    expect(line.includes('450.00')).toBe(true)
    expect(verifyClaimSupport(line, '450.00')).toEqual({
      status: 'unsupported',
      claimed: ['450'],
      present: ['1', '128450'],
    })
  })

  it('is not applicable when there is no figure, and when there is no text', () => {
    expect(verifyClaimSupport('Filing status: Married Filing Jointly', 'Married Filing Jointly')).toEqual({
      status: 'not_applicable',
    })
    expect(verifyClaimSupport('', '128450.00')).toEqual({ status: 'not_applicable' })
  })
})

// ── the production defect, end to end through the tool ──────────────────────

describe('row 7256ef49 replayed through upsert_evidence', () => {
  it('BEFORE: all four span citations resolve, and all four are now refused', async () => {
    const { dispatch, store } = harness()
    const refusals: Record<string, string> = {}
    for (const entry of PROD_ROW_7256EF49) {
      const result = await dispatch('upsert_evidence', {
        scopeKey: SCOPE,
        entries: [{ id: entry.id, sourceRef: entry.sourceRef, locator: { span: entry.locator.span }, target: entry.target, claim: entry.claim }],
      })
      expect(result.ok).toBe(false)
      expect((result as { code?: string }).code).toBe('claim_not_supported')
      refusals[entry.id] = (result as { message: string }).message
    }
    expect(Object.keys(refusals)).toHaveLength(4)
    // The refusal names the figure, the text that was cited, and both exits.
    expect(refusals.wages_line1).toContain('does not contain 128450')
    expect(refusals.wages_line1).toContain('tics LLC EIN 84-2213907 Employee: Dana')
    expect(refusals.wages_line1).toContain('locator.find')
    expect(refusals.wages_line1).toContain('COMPUTED')
    // Nothing persisted: a refused batch leaves no half-written row.
    expect(await store.listByWorkspace('ws')).toHaveLength(0)
  })

  it('AFTER: the same four claims anchored by value are all supported', async () => {
    const { dispatch, store } = harness()
    const result = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: PROD_ROW_7256EF49.map((entry) => ({
        id: entry.id,
        sourceRef: entry.sourceRef,
        locator: { find: PROD_CORRECT_FIND[entry.id] },
        target: entry.target,
        claim: entry.claim,
      })),
    })
    expect(result.ok).toBe(true)

    const record = await onlyRecord(store)
    expect(record.evidence).toHaveLength(4)
    for (const entry of record.evidence) {
      expect(entry.locator.quoteBasis).toBe('span')
      const support = verifyClaimSupport(entry.locator.quote!, entry.claim)
      expect(support.status).toBe('supported')
    }
    // The stored quote is the whole VALUE line — a click target a reviewer can
    // judge — and it is sliced from the document, not typed by the model.
    expect(record.evidence.map((entry) => entry.locator.quote)).toEqual([
      'Box 1   Wages, tips, other compensation ......... 128,450.00',
      'Box 1   Interest income .........................     812.44',
      'Box 1a  Total ordinary dividends ................   2,204.18',
      'Box 1b  Qualified dividends .....................   1,955.02',
    ])
  })

  it('a find that names a value the document does not contain is refused, not silently mis-anchored', async () => {
    const { dispatch } = harness()
    const result = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [{ id: 'e1', sourceRef: W2_REF, locator: { find: '999,999.00' }, target: 'f1040.line_1', claim: '999999.00' }],
    })
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('value_not_found')
  })
})

// ── satisfiability: the honest citation must stay expressible ───────────────

describe('the gate stays satisfiable', () => {
  it('a non-numeric claim anchored to a real line is accepted', async () => {
    const { dispatch, store } = harness()
    const result = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        { id: 'name', sourceRef: W2_REF, locator: { find: 'Dana R. Whitfield' }, target: 'f1040.taxpayer_name', claim: 'Dana R. Whitfield' },
      ],
    })
    expect(result.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence[0]!.locator.quote).toBe('Employee: Dana R. Whitfield   SSN ***-**-4417')
  })

  it('a COMPUTED value with no locator is accepted — computed lines cite their computation', async () => {
    const { dispatch } = harness()
    const result = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [{ id: 'agi', sourceRef: W2_REF, target: 'f1040.line_11', claim: '131466.62' }],
    })
    expect(result.ok).toBe(true)
  })

  it('a hand-computed span is still accepted WHEN it independently verifies', async () => {
    // Spans stay for a caller whose offsets came from a tool that computed
    // them. What changed is that they must land on the value.
    const start = PROD_W2.indexOf('Box 1   Wages')
    const { dispatch, store } = harness()
    const result = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        {
          id: 'wages',
          sourceRef: W2_REF,
          locator: { span: { start, end: start + 'Box 1   Wages, tips, other compensation ......... 128,450.00'.length } },
          target: 'f1040.line_1',
          claim: '128450.00',
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect((await onlyRecord(store)).evidence[0]!.locator.quoteBasis).toBe('span')
  })

  it('verifyClaimSupport:false restores the previous behaviour byte for byte', async () => {
    const { dispatch, store } = harness({ verifyClaimSupport: false })
    const result = await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [{ id: 'wages_line1', sourceRef: W2_REF, locator: { span: { start: 89, end: 129 } }, target: 'f1040.line_1', claim: '128450.00' }],
    })
    expect(result.ok).toBe(true)
    expect((await onlyRecord(store)).evidence[0]!.locator.quote).toBe('tics LLC   EIN 84-2213907\nEmployee: Dana')
  })
})

// ── submit: evidence written before the gate cannot reach a reviewer ────────

describe('submit_work_product re-checks claim support', () => {
  async function draftWithProductionEvidence() {
    // Write the bad row the way it got written: with the gate off, exactly as
    // production did before this change existed.
    const { dispatch, store } = harness({ verifyClaimSupport: false })
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: PROD_ROW_7256EF49.map((entry) => ({
        id: entry.id,
        sourceRef: entry.sourceRef,
        locator: { span: entry.locator.span },
        target: entry.target,
        claim: entry.claim,
      })),
    })
    return { store, record: await onlyRecord(store) }
  }

  it('refuses the submit and records the failing check on the row', async () => {
    const { store, record } = await draftWithProductionEvidence()
    // A second tool set over the SAME store, with the gate on — the shape of a
    // package whose evidence predates the gate.
    let id = 100
    const tools = buildWorkProductTools({
      store,
      artifactKinds: ['return_package'],
      exceptionKinds: ['missing_document'],
      resolveSourceRef: async (ref) => ref in PROD_TEXTS,
      readSourceText: async (ref) => PROD_TEXTS[ref] ?? null,
      provenance: () => ({ profileHash: 'hash-a', runId: 'run-1', sessionId: 'sess-1' }),
      now: () => 2_000,
      generateId: () => `wp-${++id}`,
    })
    const result = await dispatchAppTool(
      'submit_work_product',
      {
        scopeKey: SCOPE,
        artifact: { kind: 'return_package', title: '2025 federal return', body: 'x', fields: { 'f1040.line_1': '128450.00' } },
      },
      CTX,
      { handlers: NO_HANDLERS, taxonomy: NO_TAXONOMY, customTools: tools },
    )
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('claim_not_supported')
    expect((result as { message?: string }).message).toContain('wages_line1')

    const after = await store.load(record.id)
    expect(after?.status).toBe('draft')
    const check = after?.checks.find((entry) => entry.id === 'claim_support')
    expect(check?.passed).toBe(false)
    expect(check?.detail).toContain('does not contain the claimed figure')
  })

  it('passes and records 4/4 once the same four are anchored by value', async () => {
    const { dispatch, store } = harness()
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: PROD_ROW_7256EF49.map((entry) => ({
        id: entry.id,
        sourceRef: entry.sourceRef,
        locator: { find: PROD_CORRECT_FIND[entry.id] },
        target: entry.target,
        claim: entry.claim,
      })),
    })
    const result = await dispatch('submit_work_product', {
      scopeKey: SCOPE,
      artifact: { kind: 'return_package', title: '2025 federal return', body: 'x', fields: { 'f1040.line_1': '128450.00' } },
    })
    expect(result.ok).toBe(true)
    const check = (await onlyRecord(store)).checks.find((entry) => entry.id === 'claim_support')
    expect(check?.passed).toBe(true)
    expect(check?.detail).toBe('4/4 value-bearing citations anchor to text containing the claimed figure')
  })
})

// ── locating a figure is value-wise too, or the gate becomes unsatisfiable ──

describe('findSourceLine matches a numeric needle by VALUE, not as a substring', () => {
  // A document where a small figure is also the TAIL of a larger one — the
  // shape that made an honest citation unreachable. Substring search returns
  // the WAGE line for "450.00" because it occurs there first, the claim-support
  // gate then correctly refuses it, and the union of the two behaviours is a
  // gate no honest answer can satisfy at occurrence 1. That is the exact
  // failure this area exists to avoid, so locating has to be value-wise too.
  const DOC = [
    'Form W-2  Tax Year 2025',
    'Box 1   Wages, tips, other compensation ......... 128,450.00',
    'Box 14  Union dues .............................      450.00',
  ].join('\n')

  it('cites the line that carries the value, not the line that merely contains its digits', async () => {
    const { findSourceLine } = await import('../src/work-product/quote')
    const located = findSourceLine(DOC, '450.00')
    expect(located.ok).toBe(true)
    if (!located.ok) return
    expect(located.quote).toBe('Box 14  Union dues .............................      450.00')
    expect(located.occurrences).toBe(1)
    expect(verifyClaimSupport(located.quote, '450.00').status).toBe('supported')
  })

  it('still finds the larger figure by its own value', async () => {
    const { findSourceLine } = await import('../src/work-product/quote')
    const located = findSourceLine(DOC, '128450.00')
    expect(located.ok).toBe(true)
    if (!located.ok) return
    expect(located.quote).toBe('Box 1   Wages, tips, other compensation ......... 128,450.00')
  })

  it('a PHRASE needle still matches as text', async () => {
    const { findSourceLine } = await import('../src/work-product/quote')
    const located = findSourceLine(DOC, 'Union dues')
    expect(located.ok).toBe(true)
    if (!located.ok) return
    expect(located.quote).toContain('Union dues')
  })
})

// ── the invariant that makes this worth having ─────────────────────────────

describe('anchoring by value cannot produce an unsupported citation', () => {
  it('every value on every line of all three documents anchors to a supporting quote', async () => {
    // The property behind `locator.find`: if the model names a value the
    // document contains, the line the platform cites necessarily carries it.
    // Walk every value in all three production documents and assert it.
    let checked = 0
    for (const text of Object.values(PROD_TEXTS)) {
      for (const line of text.split('\n')) {
        for (const match of line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2}/gu)) {
          const { findSourceLine } = await import('../src/work-product/quote')
          const located = findSourceLine(text, match[0])
          expect(located.ok).toBe(true)
          if (!located.ok) continue
          expect(verifyClaimSupport(located.quote, match[0]).status).toBe('supported')
          checked += 1
        }
      }
    }
    expect(checked).toBe(7)
  })

  it('ToolInputError is the fold-back class, so the model corrects mid-turn', () => {
    expect(new ToolInputError('claim_not_supported', 'x').status).toBe(400)
  })
})
