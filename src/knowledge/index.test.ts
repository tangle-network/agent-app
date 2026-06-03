import { describe, expect, it } from 'vitest'
import {
  buildKnowledgeRequirements,
  deriveSignals,
  type KnowledgeRequirementSpec,
  type KnowledgeStateAccessor,
} from './index'

const SPECS: KnowledgeRequirementSpec[] = [
  {
    id: 'client-context',
    description: 'who the client is',
    category: 'user_specific',
    acquisitionMode: 'ask_user',
    satisfiedBy: { allOf: [{ config: 'businessName' }, { config: 'businessDescription' }] },
  },
  {
    id: 'book-of-record',
    description: 'policies on file',
    category: 'historical_context',
    acquisitionMode: 'query_connector',
    satisfiedBy: { table: 'policies', minRows: 1 },
  },
  {
    id: 'interaction-trigger',
    description: 'a reason to act',
    category: 'user_specific',
    acquisitionMode: 'ask_user',
    satisfiedBy: {
      anyOf: [
        { table: 'leads', statusIn: ['new', 'contacted', 'scheduled'], minRows: 1 },
        { table: 'swaps', statusIn: ['analyzing', 'proposed'], minRows: 1 },
      ],
    },
  },
  {
    id: 'regulatory-context',
    description: 'fresh authority',
    category: 'regulatory',
    acquisitionMode: 'search_web',
    freshness: 'daily',
    sensitivity: 'public',
    // no rule, no derive -> acquisition gate, scores 0
  },
]

function accessor(config: Record<string, unknown>, counts: Record<string, number>): KnowledgeStateAccessor {
  return {
    config: (path) => config[path],
    count: ({ table, statusIn }) => counts[statusIn ? `${table}:${statusIn.join('|')}` : table] ?? 0,
  }
}

/** Index a record under `noUncheckedIndexedAccess`, failing loud if absent. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected key to be present')
  return value
}

describe('buildKnowledgeRequirements', () => {
  it('maps specs to KnowledgeRequirement[] with defaults + folded confidence', () => {
    const reqs = buildKnowledgeRequirements(SPECS, {
      'book-of-record': { confidence: 1, evidence: 'policies:3' },
    })
    expect(reqs.map((r) => r.id)).toEqual([
      'client-context',
      'book-of-record',
      'interaction-trigger',
      'regulatory-context',
    ])
    const byId = new Map(reqs.map((r) => [r.id, r]))
    expect(must(byId.get('client-context')).importance).toBe('blocking')
    expect(must(byId.get('client-context')).freshness).toBe('static')
    expect(must(byId.get('client-context')).confidenceNeeded).toBe(1)
    expect(must(byId.get('client-context')).fallbackPolicy).toBe('ask') // ask_user
    expect(must(byId.get('book-of-record')).fallbackPolicy).toBe('block') // query_connector
    expect(must(byId.get('regulatory-context')).freshness).toBe('daily')
    expect(must(byId.get('book-of-record')).currentConfidence).toBe(1)
    expect(must(byId.get('book-of-record')).evidenceIds).toEqual(['policies:3'])
    expect(must(byId.get('client-context')).currentConfidence).toBe(0)
    expect(must(byId.get('client-context')).evidenceIds).toEqual([])
  })

  it('clamps out-of-range confidence', () => {
    const reqs = buildKnowledgeRequirements([SPECS[0]!], { 'client-context': { confidence: 5 } })
    expect(must(reqs[0]).currentConfidence).toBe(1)
  })
})

describe('deriveSignals — declarative rules', () => {
  it('allOf config: both fields present -> 1, missing one -> 0', async () => {
    const ready = await deriveSignals(SPECS, accessor({ businessName: 'Acme', businessDescription: 'x' }, {}))
    expect(must(ready['client-context']).confidence).toBe(1)
    expect(must(ready['client-context']).evidence).toBeDefined()
    const partial = await deriveSignals(SPECS, accessor({ businessName: 'Acme' }, {}))
    expect(must(partial['client-context']).confidence).toBe(0)
  })

  it('table minRows: rows present -> 1, none -> 0', async () => {
    const has = await deriveSignals([SPECS[1]!], accessor({}, { policies: 3 }))
    expect(must(has['book-of-record']).confidence).toBe(1)
    const none = await deriveSignals([SPECS[1]!], accessor({}, { policies: 0 }))
    expect(must(none['book-of-record']).confidence).toBe(0)
  })

  it('anyOf + statusIn: satisfied by either status-filtered table', async () => {
    const viaLeads = await deriveSignals([SPECS[2]!], accessor({}, { 'leads:new|contacted|scheduled': 2 }))
    expect(must(viaLeads['interaction-trigger']).confidence).toBe(1)
    const viaSwaps = await deriveSignals([SPECS[2]!], accessor({}, { 'swaps:analyzing|proposed': 1 }))
    expect(must(viaSwaps['interaction-trigger']).confidence).toBe(1)
    const neither = await deriveSignals([SPECS[2]!], accessor({}, {}))
    expect(must(neither['interaction-trigger']).confidence).toBe(0)
  })

  it('no rule + no derive -> 0 (acquisition gate)', async () => {
    const r = await deriveSignals([SPECS[3]!], accessor({}, {}))
    expect(must(r['regulatory-context']).confidence).toBe(0)
  })

  it('derive escape hatch wins over satisfiedBy and is clamped', async () => {
    const spec: KnowledgeRequirementSpec = {
      id: 'aggregate',
      description: 'sum of parties across deals',
      category: 'domain_specific',
      acquisitionMode: 'query_connector',
      satisfiedBy: { table: 'never', minRows: 1 }, // would score 0
      derive: () => 0.8,
    }
    const r = await deriveSignals([spec], accessor({}, {}))
    expect(must(r.aggregate).confidence).toBeCloseTo(0.8)
  })

  it('round-trips through buildKnowledgeRequirements end-to-end', async () => {
    const ctx = accessor({ businessName: 'Acme', businessDescription: 'x' }, { policies: 5 })
    const reqs = buildKnowledgeRequirements(SPECS, await deriveSignals(SPECS, ctx))
    const byId = new Map(reqs.map((r) => [r.id, r]))
    expect(must(byId.get('client-context')).currentConfidence).toBe(1)
    expect(must(byId.get('book-of-record')).currentConfidence).toBe(1)
    expect(must(byId.get('interaction-trigger')).currentConfidence).toBe(0)
    expect(must(byId.get('regulatory-context')).currentConfidence).toBe(0)
  })
})
