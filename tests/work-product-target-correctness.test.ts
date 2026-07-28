/**
 * Target correctness: a citation must point at the RIGHT line, and the evidence
 * must agree with the artifact it decorates.
 *
 * Four citation gates shipped before this one, each closing the last one's
 * remaining freedom — verbatim quote, platform-sliced span, anchor-by-value,
 * distinctive needle. Production row `95105c8a` records
 * `evidence_coverage 6/6`, `claim_support 19/19`, `quote_verification 19/19`
 * and still ships two citations attached to the wrong form line:
 *
 *     f1040.line_3b  claim 1955.02  ->  "Box 1b  Qualified dividends ..... 1,955.02"
 *     f1040.line_3a  claim 2204.18  ->  "Box 1a  Total ordinary dividends . 2,204.18"
 *
 * Form 1040 line 3a is QUALIFIED dividends and line 3b is ORDINARY. Every gate
 * above reads the pair as perfect: the quote is real, it is from the named
 * document, and it carries the figure claimed. Only the attachment is wrong, so
 * an auditor clicking line 3a lands on the ordinary-dividends line. The
 * artifact's own `fields` are right on that row, which makes the evidence
 * contradict the package it belongs to.
 *
 * `PROD_ROW_95105C8A` below is that row's `evidence` JSON — all 21 entries, in
 * emission order, with the ids, targets and claims production stored.
 * `PROD_*` are the three session documents, reconstructed from the quotes the
 * row stored; `the fixture is the real row` asserts every stored quote occurs
 * in them verbatim, so this suite cannot drift into measuring a convenient
 * invention. (The stored SPANS are not reproduced here — anchoring is
 * `work-product-span-citation.test.ts`' subject. These gates read the target
 * and the resolved line, not the offsets.)
 */

import { describe, expect, it } from 'vitest'

import { dispatchAppTool, type AppToolContext, type AppToolHandlers, type AppToolTaxonomy } from '../src/tools/index'
import {
  buildWorkProductTools,
  createInMemoryWorkProductStore,
  indexArtifactValues,
  verifyArtifactAgreement,
  verifyTargetLabel,
  type ConfusableTargetGroup,
  type WorkProductRecord,
  type WorkProductToolConfig,
} from '../src/work-product/index'

const CTX: AppToolContext = { userId: 'u1', workspaceId: 'ws', threadId: 'thread-1' }
const NO_HANDLERS = {} as AppToolHandlers
const NO_TAXONOMY: AppToolTaxonomy = { proposalTypes: [], regulatedTypes: [] }
const SCOPE = 'return:6fbaa9ba:2025'

// ── the three production source documents ───────────────────────────────────

const PROD_W2 = [
  'Form W-2  Wage and Tax Statement - Tax Year 2025',
  '----------------',
  'Employer: Meridian Robotics LLC   EIN 84-2213907',
  'Employee: Dana R. Whitfield   SSN ***-**-4417',
  '------------------------------------------------------------',
  'Box 1   Wages, tips, other compensation ......... 128,450.00',
  'Box 2   Federal income tax withheld .............  17,908.00',
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
  'Box 2a  Total capital gain distributions ........     318.77',
  '',
].join('\n')

const W2_REF = '92d30d0f-950c-47db-96ba-e758e05e1c71'
const INT_REF = '7138b8f7-418c-49ed-bade-7a0f1a8586ed'
const DIV_REF = '677109e6-e7d7-4167-8ae6-418ad0f8c4be'

const PROD_TEXTS: Record<string, string> = {
  [W2_REF]: PROD_W2,
  [INT_REF]: PROD_1099INT,
  [DIV_REF]: PROD_1099DIV,
}

/** Row `95105c8a`'s artifact `fields`, verbatim. Note 3a and 3b: the artifact
 *  is CORRECT, which is what makes the two crossed evidence entries a
 *  contradiction inside one work product rather than a consistent error. */
const PROD_ARTIFACT_FIELDS = {
  'f1040.line_1a': 128450,
  'f1040.line_2b': 812.44,
  'f1040.line_3a': 1955.02,
  'f1040.line_3b': 2204.18,
  'f1040.line_7': 318.77,
  'f1040.line_9': 131785.39,
  'f1040.line_11': 131785.39,
  'f1040.line_12': 15750,
  'f1040.line_13': 0,
  'f1040.line_14': 15750,
  'f1040.line_15': 116035.39,
  'f1040.line_16': 20520,
  'f1040.line_25a': 17908,
} as const

/** All 21 evidence entries of production row `95105c8a`, in stored order:
 *  seven facts emitted three times over one turn under three different id
 *  schemes and two target spellings, plus the crossed dividend pair. */
const PROD_ROW_95105C8A: readonly { id: string; sourceRef: string; target: string; claim: string; find?: string }[] = [
  { id: 'wages-line1a', sourceRef: W2_REF, target: 'line_1a', claim: '128450.00', find: '128,450.00' },
  { id: 'fed-wht-line25a', sourceRef: W2_REF, target: 'line_25a', claim: '17908.00', find: '17,908.00' },
  { id: 'interest-line2b', sourceRef: INT_REF, target: 'line_2b', claim: '812.44', find: '812.44' },
  { id: 'dividends-ordinary-line3b', sourceRef: DIV_REF, target: 'line_3b', claim: '2204.18', find: '2,204.18' },
  { id: 'dividends-qualified-line3a', sourceRef: DIV_REF, target: 'line_3a', claim: '1955.02', find: '1,955.02' },
  { id: 'capital-gains-line7', sourceRef: DIV_REF, target: 'line_7', claim: '318.77', find: '318.77' },
  { id: 'fed-wht-line25a-corrected', sourceRef: W2_REF, target: 'line_25a', claim: '17908.00', find: '17,908.00' },
  { id: 'w2-wages', sourceRef: W2_REF, target: 'f1040.line_1a', claim: '128,450.00', find: '128,450.00' },
  { id: 'w2-fed-withholding', sourceRef: W2_REF, target: 'f1040.line_25a', claim: '17908.00', find: '17,908.00' },
  { id: 'int-interest', sourceRef: INT_REF, target: 'f1040.line_2b', claim: '812.44', find: '812.44' },
  // ── the crossed pair ──────────────────────────────────────────────────────
  { id: 'qualified-dividends', sourceRef: DIV_REF, target: 'f1040.line_3b', claim: '1955.02', find: '1,955.02' },
  { id: 'ordinary-dividends', sourceRef: DIV_REF, target: 'f1040.line_3a', claim: '2204.18', find: '2,204.18' },
  // ──────────────────────────────────────────────────────────────────────────
  { id: 'capital-gain-distributions', sourceRef: DIV_REF, target: 'f1040.line_7', claim: '318.77', find: '318.77' },
  { id: 'zero-line-8', sourceRef: W2_REF, target: 'f1040.line_8', claim: '0' },
  { id: 'zero-line-8-unanchored', sourceRef: W2_REF, target: 'f1040.line_8', claim: 'No additional income reported in source documents' },
  { id: 'wages', sourceRef: W2_REF, target: 'f1040.line_1a', claim: '128450.00', find: '128,450.00' },
  { id: 'fed_withholding', sourceRef: W2_REF, target: 'f1040.line_25a', claim: '17908.00', find: '17,908.00' },
  { id: 'interest_income', sourceRef: INT_REF, target: 'f1040.line_2b', claim: '812.44', find: '812.44' },
  { id: 'ordinary_dividends', sourceRef: DIV_REF, target: 'f1040.line_3b', claim: '2204.18', find: '2,204.18' },
  { id: 'qualified_dividends', sourceRef: DIV_REF, target: 'f1040.line_3a', claim: '1955.02', find: '1,955.02' },
  { id: 'capital_gain_distributions', sourceRef: DIV_REF, target: 'f1040.line_7', claim: '318.77', find: '318.77' },
]

const CROSSED_IDS = new Set(['qualified-dividends', 'ordinary-dividends'])

// ── the tax product's domain parameters (the shell learns no tax vocabulary) ─

/** A 1040 form-line target folded to one canonical spelling: `line_3a`,
 *  `1040.line_3a` and `f1040.line_3a` are one line of one return. */
function normalizeTarget(target: string): string {
  const trimmed = target.trim()
  const lowered = trimmed.toLowerCase()
  const dot = lowered.indexOf('.')
  const form = dot > 0 ? lowered.slice(0, dot).replace(/[^a-z0-9]/gu, '') : undefined
  const rest = dot > 0 ? lowered.slice(dot + 1) : lowered
  const line = rest.replace(/^line[_\s-]*/u, '').replace(/[^a-z0-9]/gu, '')
  if (!/^\d+[a-z]?$/u.test(line)) return trimmed
  if (form === undefined || form === '1040' || form === 'f1040' || form === 'form1040') return `f1040.line_${line}`
  return `${trimmed.slice(0, dot)}.line_${line}`
}

const TAX_CONFUSABLE: ConfusableTargetGroup[] = [
  {
    note: 'Form 1099-DIV: box 1a is total ordinary dividends, box 1b is the qualified subset, box 2a is capital gain distributions',
    labels: {
      'f1040.line_2a': ['tax-exempt interest'],
      'f1040.line_2b': ['interest income', 'taxable interest'],
      'f1040.line_3a': ['qualified dividend'],
      'f1040.line_3b': ['ordinary dividend'],
      'f1040.line_6b': ['taxable social security'],
      'f1040.line_7': ['capital gain distribution'],
    },
  },
  {
    note: 'Form W-2: box 1 is wages, box 2 is federal income tax withheld',
    labels: {
      'f1040.line_1a': ['wages, tips'],
      'f1040.line_25a': ['federal income tax withheld'],
    },
  },
]

function harness(overrides: Partial<WorkProductToolConfig> = {}) {
  const store = createInMemoryWorkProductStore()
  let id = 0
  const tools = buildWorkProductTools({
    store,
    artifactKinds: ['return_package'],
    exceptionKinds: ['missing_document'],
    resolveSourceRef: async (ref) => ref in PROD_TEXTS,
    readSourceText: async (ref) => PROD_TEXTS[ref] ?? null,
    normalizeTarget,
    confusableTargets: TAX_CONFUSABLE,
    provenance: () => ({ profileHash: 'hash-a', runId: 'run-1', sessionId: 'sess-1' }),
    now: () => 1_000,
    generateId: () => `wp-${++id}`,
    ...overrides,
  })
  const dispatch = (name: string, args: Record<string, unknown>) =>
    dispatchAppTool(name, args, CTX, { handlers: NO_HANDLERS, taxonomy: NO_TAXONOMY, customTools: tools })
  return { store, dispatch }
}

async function onlyRecord(store: ReturnType<typeof createInMemoryWorkProductStore>): Promise<WorkProductRecord> {
  const rows = await store.listByWorkspace('ws')
  expect(rows).toHaveLength(1)
  return rows[0]!
}

function entryArgs(entry: (typeof PROD_ROW_95105C8A)[number]) {
  return {
    id: entry.id,
    sourceRef: entry.sourceRef,
    target: entry.target,
    claim: entry.claim,
    ...(entry.find === undefined ? {} : { locator: { find: entry.find } }),
  }
}

// ── the fixture is the real row ─────────────────────────────────────────────

describe('production row 95105c8a — the fixture is the real row', () => {
  it('every value the row cited occurs on the line the row quoted', () => {
    expect(PROD_W2).toContain('Box 1   Wages, tips, other compensation ......... 128,450.00')
    expect(PROD_W2).toContain('Box 2   Federal income tax withheld .............  17,908.00')
    expect(PROD_1099INT).toContain('Box 1   Interest income .........................     812.44')
    expect(PROD_1099DIV).toContain('Box 1a  Total ordinary dividends ................   2,204.18')
    expect(PROD_1099DIV).toContain('Box 1b  Qualified dividends .....................   1,955.02')
    expect(PROD_1099DIV).toContain('Box 2a  Total capital gain distributions ........     318.77')
  })

  it('is 21 entries over 7 distinct form lines, in two target spellings', () => {
    expect(PROD_ROW_95105C8A).toHaveLength(21)
    expect(new Set(PROD_ROW_95105C8A.map((entry) => normalizeTarget(entry.target))).size).toBe(7)
    expect(PROD_ROW_95105C8A.some((entry) => entry.target === 'line_3a')).toBe(true)
    expect(PROD_ROW_95105C8A.some((entry) => entry.target === 'f1040.line_3a')).toBe(true)
  })

  it('the crossed pair claims the value the artifact puts on the OTHER line', () => {
    const crossed = PROD_ROW_95105C8A.filter((entry) => CROSSED_IDS.has(entry.id))
    expect(crossed.map((entry) => [entry.target, entry.claim])).toEqual([
      ['f1040.line_3b', '1955.02'],
      ['f1040.line_3a', '2204.18'],
    ])
    expect(PROD_ARTIFACT_FIELDS['f1040.line_3a']).toBe(1955.02)
    expect(PROD_ARTIFACT_FIELDS['f1040.line_3b']).toBe(2204.18)
  })
})

// ── check two, in isolation: target ↔ cited line ────────────────────────────

describe('verifyTargetLabel', () => {
  it('REFUSES the line that names a sibling target and not its own', () => {
    expect(
      verifyTargetLabel('Box 1b  Qualified dividends .....................   1,955.02', 'f1040.line_3b', TAX_CONFUSABLE),
    ).toEqual({
      status: 'crossed',
      rival: 'f1040.line_3a',
      rivalLabel: 'qualified dividend',
      expected: ['ordinary dividend'],
      note: TAX_CONFUSABLE[0]!.note,
    })
  })

  it('accepts the line that names its own target', () => {
    expect(
      verifyTargetLabel('Box 1a  Total ordinary dividends ................   2,204.18', 'f1040.line_3b', TAX_CONFUSABLE),
    ).toEqual({ status: 'identified', label: 'ordinary dividend' })
  })

  it('matches a label case- and punctuation-insensitively', () => {
    // A document is not a quotation: "QUALIFIED DIVIDENDS (BOX 1B)" is the
    // same line as "Qualified dividends". Verbatim matching stays the quote
    // gate's job, where the question is different.
    expect(verifyTargetLabel('QUALIFIED DIVIDENDS (BOX 1B) 1,955.02', 'f1040.line_3a', TAX_CONFUSABLE).status).toBe(
      'identified',
    )
  })

  // ── satisfiability: silence must always pass ──────────────────────────────

  it('passes a line labelled in a way the product did not anticipate', () => {
    // The failure this whole area exists to prevent is a gate an honest answer
    // cannot satisfy: it does not stop bad work, it selects for invented work.
    // A consolidated statement abbreviating the box name must not become a
    // refusal, so a line carrying NO label from the group is not applicable.
    for (const line of [
      '1b  Qual. div. income .......   1,955.02',
      'Dividends that are qualified: 1,955.02',
      'Box 1b ....................   1,955.02',
    ]) {
      expect(verifyTargetLabel(line, 'f1040.line_3a', TAX_CONFUSABLE)).toEqual({ status: 'not_applicable' })
    }
  })

  it('passes a line that names BOTH — a document may nest one inside the other', () => {
    // "Qualified Dividends (included in Total Ordinary Dividends)" is one real
    // line on a consolidated 1099. Own-label-present wins, for both targets.
    const line = 'Qualified Dividends (included in Total Ordinary Dividends)   1,955.02'
    expect(verifyTargetLabel(line, 'f1040.line_3a', TAX_CONFUSABLE).status).toBe('identified')
    expect(verifyTargetLabel(line, 'f1040.line_3b', TAX_CONFUSABLE).status).toBe('identified')
  })

  it('passes a target no group covers, and an entry with no text', () => {
    expect(verifyTargetLabel('Box 1a  Total ordinary dividends', 'facts.capital_gains', TAX_CONFUSABLE)).toEqual({
      status: 'not_applicable',
    })
    expect(verifyTargetLabel('', 'f1040.line_3a', TAX_CONFUSABLE)).toEqual({ status: 'not_applicable' })
    expect(verifyTargetLabel('Box 1a  Total ordinary dividends', 'f1040.line_3a', [])).toEqual({
      status: 'not_applicable',
    })
  })
})

// ── check three, in isolation: claim ↔ artifact field ───────────────────────

describe('verifyArtifactAgreement', () => {
  const values = indexArtifactValues(PROD_ARTIFACT_FIELDS, normalizeTarget)

  it('REFUSES a claim that states the figure the artifact puts on another line', () => {
    expect(verifyArtifactAgreement('f1040.line_3b', '1955.02', values)).toEqual({
      status: 'contradicts',
      claimed: '1955.02',
      expected: '2204.18',
      belongsTo: 'f1040.line_3a',
    })
  })

  it('accepts the claim that matches its own field, however it is written', () => {
    expect(verifyArtifactAgreement('f1040.line_1a', '128,450.00', values)).toEqual({ status: 'agrees', value: '128450' })
    expect(verifyArtifactAgreement('f1040.line_25a', '17908.00', values)).toEqual({ status: 'agrees', value: '17908' })
  })

  // ── satisfiability: an aggregate's components are not contradictions ──────

  it('does NOT refuse a component of an aggregated line', () => {
    // Production row a68b1943 reports line 1a as 189,750.00 and evidences it
    // with two W-2s of 128,450.00 and 61,300.00 — exactly the lineage a
    // reviewer wants. "claim must equal the field" would delete it.
    const aggregate = indexArtifactValues({ line_1a: '189750.00', line_2b: '1284.36' }, normalizeTarget)
    expect(verifyArtifactAgreement('f1040.line_1a', '128450.00', aggregate)).toEqual({ status: 'not_applicable' })
    expect(verifyArtifactAgreement('f1040.line_1a', '61300.00', aggregate)).toEqual({ status: 'not_applicable' })
  })

  it('does NOT refuse a claim narrating a computation over other lines', () => {
    // As soon as one figure in the prose is the target's own value it agrees,
    // which is what a narration of a total does by definition.
    expect(
      verifyArtifactAgreement(
        'f1040.line_9',
        'Total income $131,785.39 = wages $128,450.00 + interest $812.44 + dividends $2,204.18 + gains $318.77',
        values,
      ),
    ).toEqual({ status: 'agrees', value: '131785.39' })
  })

  it('is not applicable with no field, no figure, or a non-numeric field', () => {
    expect(verifyArtifactAgreement('f1040.line_8', '0', values)).toEqual({ status: 'not_applicable' })
    expect(verifyArtifactAgreement('f1040.line_1a', 'Dana R. Whitfield', values)).toEqual({ status: 'not_applicable' })
    expect(indexArtifactValues({ 'f1040.filing_status': 'Single' }).size).toBe(0)
  })
})

// ── the production defect, end to end through the tools ─────────────────────

describe('row 95105c8a replayed through upsert_evidence', () => {
  it('REFUSES both crossed entries, and names the line each one actually cites', async () => {
    const { dispatch, store } = harness()
    const refusals: Record<string, string> = {}
    for (const entry of PROD_ROW_95105C8A.filter((candidate) => CROSSED_IDS.has(candidate.id))) {
      const result = await dispatch('upsert_evidence', { scopeKey: SCOPE, entries: [entryArgs(entry)] })
      expect(result.ok).toBe(false)
      expect((result as { code?: string }).code).toBe('target_crossed')
      refusals[entry.id] = (result as { message: string }).message
    }
    expect(refusals['qualified-dividends']).toContain('f1040.line_3b')
    expect(refusals['qualified-dividends']).toContain('Box 1b Qualified dividends')
    expect(refusals['qualified-dividends']).toContain('which is the line for f1040.line_3a')
    // Both exits are named, because a gate with no honest way out manufactures
    // the defect it screens for.
    expect(refusals['qualified-dividends']).toContain('or attach this citation to f1040.line_3a instead')
    expect(refusals['ordinary-dividends']).toContain('which is the line for f1040.line_3b')
    // A refused batch persists nothing.
    expect(await store.listByWorkspace('ws')).toHaveLength(0)
  })

  it('ACCEPTS every dividend citation the row got the right way round', async () => {
    const { dispatch, store } = harness()
    const honest = PROD_ROW_95105C8A.filter(
      (entry) => !CROSSED_IDS.has(entry.id) && entry.sourceRef === DIV_REF,
    )
    expect(honest).toHaveLength(7)
    const result = await dispatch('upsert_evidence', { scopeKey: SCOPE, entries: honest.map(entryArgs) })
    expect(result.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.evidence.map((entry) => [entry.target, entry.claim])).toEqual([
      ['f1040.line_3b', '2204.18'],
      ['f1040.line_3a', '1955.02'],
      ['f1040.line_7', '318.77'],
    ])
  })

  it('replays all 21 entries: 2 refused, 8 stored, 7 form lines', async () => {
    // The whole defect, end to end. Three near-duplicate emission blocks
    // collapse; the two crossed entries never land; the seven form lines each
    // keep one row — except line_8, whose two entries assert DIFFERENT things
    // ("0" and the sentence explaining why) and are therefore two rows, not a
    // duplicate. Merging those would be the shell deciding two different
    // sentences are one fact.
    const { dispatch, store } = harness()
    const refused: string[] = []
    for (const entry of PROD_ROW_95105C8A) {
      const result = await dispatch('upsert_evidence', { scopeKey: SCOPE, entries: [entryArgs(entry)] })
      if (!result.ok) refused.push(entry.id)
    }
    expect(refused).toEqual(['qualified-dividends', 'ordinary-dividends'])
    const record = await onlyRecord(store)
    expect(record.evidence).toHaveLength(8)
    expect(new Set(record.evidence.map((entry) => entry.target)).size).toBe(7)
    expect(record.evidence.filter((entry) => entry.target === 'f1040.line_3a')).toHaveLength(1)
    expect(record.evidence.filter((entry) => entry.target === 'f1040.line_8')).toHaveLength(2)
  })
})

// ── defect three: a re-stated fact is an upsert, not a new row ──────────────

describe('scopeKey upserts are idempotent', () => {
  const FACT = {
    id: 'wages-line1a',
    sourceRef: W2_REF,
    target: 'line_1a',
    claim: '128450.00',
    locator: { find: '128,450.00' },
  }

  it('re-emitting one fact under three ids and two spellings leaves ONE row', async () => {
    const { dispatch, store } = harness()
    for (const variant of [
      FACT,
      { ...FACT, id: 'w2-wages', target: 'f1040.line_1a', claim: '128,450.00' },
      { ...FACT, id: 'wages', target: 'f1040.line_1a' },
    ]) {
      expect((await dispatch('upsert_evidence', { scopeKey: SCOPE, entries: [variant] })).ok).toBe(true)
    }
    const record = await onlyRecord(store)
    expect(record.evidence).toHaveLength(1)
    expect(record.evidence[0]!.id).toBe('wages')
    expect(record.evidence[0]!.target).toBe('f1040.line_1a')
  })

  it('collapses a batch that re-states the same fact twice', async () => {
    const { dispatch, store } = harness()
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [FACT, { ...FACT, id: 'wages-again', target: 'f1040.line_1a' }],
    })
    expect((await onlyRecord(store)).evidence).toHaveLength(1)
  })

  it('KEEPS two rows for one target when they assert different values', async () => {
    // Form 1040 line 2b legitimately aggregates box 1 and box 3 of one
    // 1099-INT. A merge rule keyed on target+source alone would silently
    // delete the second citation — worse than the duplication it fixes.
    const { dispatch, store } = harness({
      readSourceText: async () =>
        [
          'Box 1   Interest income .........................     812.44',
          'Box 3   Interest on U.S. Savings Bonds .........     140.00',
        ].join('\n'),
    })
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [
        { id: 'int-box1', sourceRef: INT_REF, target: 'line_2b', claim: '812.44', locator: { find: '812.44' } },
        { id: 'int-box3', sourceRef: INT_REF, target: 'line_2b', claim: '140.00', locator: { find: '140.00' } },
      ],
    })
    expect((await onlyRecord(store)).evidence).toHaveLength(2)
  })
})

// ── submit: the whole row is re-checked against the artifact ────────────────

describe('submit_work_product', () => {
  /** Persist the row as production wrote it — gates off — so submit faces the
   *  package a reviewer actually received. */
  async function persistLegacyRow(entries: readonly (typeof PROD_ROW_95105C8A)[number][]) {
    const ungated = harness({ confusableTargets: [], verifyArtifactAgreement: false })
    for (const entry of entries) {
      const result = await ungated.dispatch('upsert_evidence', { scopeKey: SCOPE, entries: [entryArgs(entry)] })
      expect(result.ok).toBe(true)
    }
    return ungated
  }

  const ARTIFACT = { kind: 'return_package', title: '2025 Form 1040 — Whitfield', fields: PROD_ARTIFACT_FIELDS }

  it('REFUSES the crossed pair at submit even when it was written before the gate existed', async () => {
    const legacy = await persistLegacyRow(PROD_ROW_95105C8A)
    const store = legacy.store
    // The row holds exactly what production wrote, deduplicated: 8 rows over 7
    // form lines, the crossed pair among them.
    expect((await onlyRecord(store)).evidence).toHaveLength(10)
    let id = 0
    const tools = buildWorkProductTools({
      store,
      artifactKinds: ['return_package'],
      exceptionKinds: ['missing_document'],
      resolveSourceRef: async (ref) => ref in PROD_TEXTS,
      readSourceText: async (ref) => PROD_TEXTS[ref] ?? null,
      normalizeTarget,
      confusableTargets: TAX_CONFUSABLE,
      provenance: () => ({ profileHash: 'hash-a', runId: 'run-1', sessionId: 'sess-1' }),
      now: () => 1_000,
      generateId: () => `wp-${++id}`,
    })
    const result = await dispatchAppTool('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT }, CTX, {
      handlers: NO_HANDLERS,
      taxonomy: NO_TAXONOMY,
      customTools: tools,
    })
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('target_crossed')
    expect((result as { message: string }).message).toContain('qualified-dividends')
    // Recorded on the still-draft row, so the queue shows WHY it did not ship.
    const record = await onlyRecord(store)
    expect(record.status).toBe('draft')
    const check = record.checks.find((entry) => entry.name === 'target_correctness')
    expect(check).toBeDefined()
    expect(check!.passed).toBe(false)
    expect(check!.source).toBe('platform')
    expect(check!.detail).toContain('f1040.line_3b cites the f1040.line_3a line')
  })

  it('REFUSES evidence that contradicts the artifact, with the label gate off', async () => {
    // The two gates are independent: with `confusableTargets` unset, the
    // crossed pair is still caught — by the package disagreeing with itself.
    const legacy = await persistLegacyRow(PROD_ROW_95105C8A)
    let id = 0
    const tools = buildWorkProductTools({
      store: legacy.store,
      artifactKinds: ['return_package'],
      exceptionKinds: ['missing_document'],
      resolveSourceRef: async (ref) => ref in PROD_TEXTS,
      readSourceText: async (ref) => PROD_TEXTS[ref] ?? null,
      normalizeTarget,
      provenance: () => ({ profileHash: 'hash-a', runId: 'run-1', sessionId: 'sess-1' }),
      now: () => 1_000,
      generateId: () => `wp-${++id}`,
    })
    const result = await dispatchAppTool('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT }, CTX, {
      handlers: NO_HANDLERS,
      taxonomy: NO_TAXONOMY,
      customTools: tools,
    })
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('contradicts_artifact')
    const message = (result as { message: string }).message
    expect(message).toContain('f1040.line_3b claims 1955.02')
    expect(message).toContain('the artifact reports on f1040.line_3a')
    const record = await onlyRecord(legacy.store)
    const check = record.checks.find((entry) => entry.name === 'artifact_agreement')
    expect(check?.passed).toBe(false)
  })

  it('ACCEPTS the corrected package, and records both checks passing', async () => {
    const { dispatch, store } = harness()
    for (const entry of PROD_ROW_95105C8A.filter((candidate) => !CROSSED_IDS.has(candidate.id))) {
      expect((await dispatch('upsert_evidence', { scopeKey: SCOPE, entries: [entryArgs(entry)] })).ok).toBe(true)
    }
    const result = await dispatch('submit_work_product', { scopeKey: SCOPE, artifact: ARTIFACT })
    expect(result.ok).toBe(true)
    const record = await onlyRecord(store)
    expect(record.status).toBe('ready')
    const named = Object.fromEntries(record.checks.map((check) => [check.name, check]))
    expect(named.target_correctness?.passed).toBe(true)
    expect(named.target_correctness?.detail).toContain('citations land on a line belonging to their own target')
    expect(named.artifact_agreement?.passed).toBe(true)
    expect(named.artifact_agreement?.detail).toContain('agree with the artifact field they support')
  })

  it('reports honestly when nothing was checkable, rather than a vacuous pass', async () => {
    const { dispatch, store } = harness()
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [{ id: 'name', sourceRef: W2_REF, target: 'facts.taxpayer_name', claim: 'Dana R. Whitfield' }],
    })
    const result = await dispatch('submit_work_product', {
      scopeKey: SCOPE,
      artifact: { kind: 'return_package', title: 'x', fields: { 'f1040.line_1a': 128450 } },
    })
    expect(result.ok).toBe(true)
    const named = Object.fromEntries((await onlyRecord(store)).checks.map((check) => [check.name, check]))
    expect(named.target_correctness?.detail).toContain('nothing to check')
    expect(named.artifact_agreement?.detail).toContain('nothing to check')
  })
})

// ── the namespace fix reaches the coverage gate ─────────────────────────────

describe('normalizeTarget folds the target namespace everywhere', () => {
  it('counts a `line_3a` evidence row as covering an `f1040.line_3a` material target', async () => {
    const { dispatch, store } = harness({
      materialTargets: (artifact) => Object.keys(artifact.fields ?? {}),
      requireAnchoredEvidence: true,
    })
    await dispatch('upsert_evidence', {
      scopeKey: SCOPE,
      entries: [{ id: 'div-q', sourceRef: DIV_REF, target: 'line_3a', claim: '1955.02', locator: { find: '1,955.02' } }],
    })
    const result = await dispatch('submit_work_product', {
      scopeKey: SCOPE,
      artifact: { kind: 'return_package', title: 'x', fields: { 'f1040.line_3a': 1955.02 } },
    })
    expect(result.ok).toBe(true)
    const coverage = (await onlyRecord(store)).checks.find((check) => check.name === 'evidence_coverage')
    expect(coverage?.passed).toBe(true)
    expect(coverage?.detail).toContain('1/1 material targets evidenced')
  })
})
