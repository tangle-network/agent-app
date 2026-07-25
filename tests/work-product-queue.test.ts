import { describe, expect, it } from 'vitest'

import {
  parseReviewQueueItem,
  projectReviewQueue,
  type ReviewQueueItem,
  type WorkProductRecord,
} from '../src/work-product/index'

function record(overrides: Partial<WorkProductRecord>): WorkProductRecord {
  return {
    id: 'wp-1',
    workspaceId: 'ws',
    threadId: 'thread-1',
    scopeKey: 'return:acme:2025',
    status: 'draft',
    version: 1,
    artifact: null,
    evidence: [],
    exceptions: [],
    checks: [],
    provenance: { profileHash: 'hash-a', runId: 'run-1', servingModels: ['gpt-5'], producedAt: 1 },
    history: [],
    createdAt: 1,
    updatedAt: 10,
    ...overrides,
  }
}

describe('projectReviewQueue — pure projection over existing sources', () => {
  it('derives every state from its designed source of truth', () => {
    const items = projectReviewQueue({
      workProducts: [
        record({ id: 'a', scopeKey: 'working', threadId: 't-a', status: 'draft', updatedAt: 70 }),
        record({
          id: 'b',
          scopeKey: 'asking',
          threadId: 't-b',
          status: 'draft',
          updatedAt: 60,
        }),
        record({
          id: 'c',
          scopeKey: 'blocked',
          threadId: 't-c',
          status: 'blocked',
          updatedAt: 50,
          exceptions: [{ id: 'x1', severity: 'blocking', kind: 'k', message: 'm', resolved: false }],
        }),
        record({
          id: 'd',
          scopeKey: 'ready',
          threadId: 't-d',
          status: 'ready',
          updatedAt: 40,
          artifact: { kind: 'return_package', title: 'Return', content: 'x' },
          checks: [
            { id: 'c1', name: 'evidence_coverage', passed: true, source: 'platform' },
            { id: 'c2', name: 'totals_reconcile', passed: false, source: 'agent' },
          ],
        }),
        record({ id: 'e', scopeKey: 'changes', threadId: 't-e', status: 'changes_requested', updatedAt: 30 }),
        record({ id: 'f', scopeKey: 'approved', threadId: 't-f', status: 'approved', updatedAt: 20 }),
        record({ id: 'g', scopeKey: 'superseded-only', threadId: 't-g', status: 'superseded', updatedAt: 15 }),
      ],
      threads: [{ scopeKey: 'fresh', threadId: 't-fresh', updatedAt: 5 }],
      pendingAsks: [{ threadId: 't-b', interactionId: 'ask-1', title: 'Which filing status?' }],
    })

    const byScope = Object.fromEntries(items.map((item) => [item.scopeKey, item]))
    expect(byScope['working']?.state).toBe('working')
    expect(byScope['asking']?.state).toBe('missing_info')
    expect(byScope['asking']?.pendingAsk).toEqual({ interactionId: 'ask-1', title: 'Which filing status?' })
    expect(byScope['blocked']?.state).toBe('blocked')
    expect(byScope['blocked']?.blockingExceptions).toBe(1)
    expect(byScope['ready']?.state).toBe('ready_for_review')
    expect(byScope['ready']?.failedChecks).toBe(1)
    expect(byScope['ready']?.workProduct).toMatchObject({ title: 'Return', kind: 'return_package' })
    expect(byScope['changes']?.state).toBe('changes_requested')
    expect(byScope['approved']?.state).toBe('approved')
    expect(byScope['fresh']?.state).toBe('intake')
    // Superseded rows are history — they never surface as queue items.
    expect(byScope['superseded-only']).toBeUndefined()

    // Newest updatedAt first.
    expect(items.map((item) => item.scopeKey)).toEqual([
      'working',
      'asking',
      'blocked',
      'ready',
      'changes',
      'approved',
      'fresh',
    ])
  })

  it('one item per scope: the open row wins over the approved history row', () => {
    const items = projectReviewQueue({
      workProducts: [
        record({ id: 'v1', scopeKey: 's', status: 'approved', version: 1, updatedAt: 100 }),
        record({ id: 'v2', scopeKey: 's', status: 'draft', version: 2, updatedAt: 50 }),
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ state: 'working', workProduct: { id: 'v2', version: 2 } })
  })

  it('a thread whose scope already has a record is not double-listed as intake', () => {
    const items = projectReviewQueue({
      workProducts: [record({ scopeKey: 's', threadId: 't-1' })],
      threads: [{ scopeKey: 's', threadId: 't-1', updatedAt: 99 }],
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.state).toBe('working')
  })

  it('a draft with no artifact falls back to the scopeKey as its title', () => {
    const items = projectReviewQueue({ workProducts: [record({ artifact: null })] })
    expect(items[0]?.workProduct).toMatchObject({ title: 'return:acme:2025', kind: '' })
  })

  it('provenance rides each item: profileHash + servingModels only', () => {
    const items = projectReviewQueue({ workProducts: [record({})] })
    expect(items[0]?.provenance).toEqual({ profileHash: 'hash-a', servingModels: ['gpt-5'] })
  })
})

describe('parseReviewQueueItem — JSON-boundary re-validation', () => {
  const valid: ReviewQueueItem = {
    scopeKey: 's',
    state: 'ready_for_review',
    threadId: 't-1',
    workProduct: { id: 'wp-1', version: 1, title: 'T', kind: 'return_package' },
    pendingAsk: { interactionId: 'i-1', title: 'Q' },
    blockingExceptions: 0,
    failedChecks: 1,
    provenance: { profileHash: 'h', servingModels: ['gpt-5'] },
    updatedAt: 5,
  }

  it('round-trips a valid item', () => {
    expect(parseReviewQueueItem(JSON.parse(JSON.stringify(valid)))).toEqual(valid)
  })

  it('rejects junk: bad state, missing counts, non-objects', () => {
    expect(parseReviewQueueItem(null)).toBeNull()
    expect(parseReviewQueueItem('x')).toBeNull()
    expect(parseReviewQueueItem({ ...valid, state: 'shipped' })).toBeNull()
    expect(parseReviewQueueItem({ ...valid, blockingExceptions: 'many' })).toBeNull()
    expect(parseReviewQueueItem({ ...valid, threadId: 7 })).toBeNull()
  })

  it('drops malformed optional sub-objects without dropping the item', () => {
    const item = parseReviewQueueItem({ ...valid, workProduct: { id: 'wp-1' }, provenance: { profileHash: 1 } })
    expect(item).not.toBeNull()
    expect(item?.workProduct).toBeUndefined()
    expect(item?.provenance).toBeUndefined()
  })
})
