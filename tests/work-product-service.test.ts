import { describe, expect, it } from 'vitest'

import {
  canTransitionWorkProduct,
  createInMemoryWorkProductStore,
  createWorkProductService,
  isWorkProductTerminal,
  stampProvenance,
  type WorkProductRecord,
  type WorkProductStatus,
} from '../src/work-product/index'

const PROVENANCE = { profileHash: 'hash-a', runId: 'run-1' }

function harness(now = () => 1_000) {
  const store = createInMemoryWorkProductStore()
  let id = 0
  const service = createWorkProductService({ store, now, generateId: () => `wp-${++id}` })
  return { store, service }
}

async function makeDraft(harnessValue = harness()) {
  const { store, service } = harnessValue
  const record = await service.create({
    workspaceId: 'ws',
    threadId: 'thread-1',
    scopeKey: 'return:acme:2025',
    provenance: stampProvenance(PROVENANCE, () => 1_000),
  })
  return { store, service, record }
}

describe('work-product status machine', () => {
  it('encodes exactly the designed edges', () => {
    const edges: Array<[WorkProductStatus, WorkProductStatus, boolean]> = [
      ['draft', 'blocked', true],
      ['draft', 'ready', true],
      ['draft', 'approved', false],
      ['blocked', 'draft', true],
      ['blocked', 'ready', false],
      ['ready', 'changes_requested', true],
      ['ready', 'approved', true],
      ['ready', 'superseded', true],
      ['ready', 'draft', false],
      ['changes_requested', 'draft', true],
      ['changes_requested', 'superseded', true],
      ['changes_requested', 'approved', false],
      ['approved', 'superseded', true],
      ['approved', 'draft', false],
      ['superseded', 'draft', false],
    ]
    for (const [from, to, legal] of edges) {
      expect(canTransitionWorkProduct(from, to), `${from} -> ${to}`).toBe(legal)
    }
    expect(isWorkProductTerminal('superseded')).toBe(true)
    expect(isWorkProductTerminal('approved')).toBe(false)
  })

  it('creates a draft with empty accumulators and an audit event', async () => {
    const { store, record } = await makeDraft()
    expect(record.status).toBe('draft')
    expect(record.version).toBe(1)
    expect(record.artifact).toBeNull()
    expect(record.evidence).toEqual([])
    expect(store.events().map((event) => event.step)).toEqual(['wp.created'])
  })

  it('upserts evidence by id: same id replaces, new ids append', async () => {
    const { service, record } = await makeDraft()
    const base = { sourceRef: 'vault/w2.pdf', locator: {}, target: '1040.line_1', claim: '$85,000' }
    await service.upsertEvidence(record.id, [{ id: 'e1', ...base }])
    const outcome = await service.upsertEvidence(record.id, [
      { id: 'e1', ...base, claim: '$86,000' },
      { id: 'e2', ...base, target: '1040.line_9' },
    ])
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.evidence.map((entry) => [entry.id, entry.claim])).toEqual([
      ['e1', '$86,000'],
      ['e2', '$85,000'],
    ])
  })

  it('parks draft -> blocked on an unresolved blocking exception and releases on resolution', async () => {
    const { service, record } = await makeDraft()
    const blocked = await service.upsertExceptions(record.id, [
      { id: 'x1', severity: 'blocking', kind: 'missing_document', message: 'No W-2', resolved: false },
    ])
    expect(blocked.succeeded && blocked.value.status).toBe('blocked')

    const released = await service.upsertExceptions(record.id, [
      { id: 'x1', severity: 'blocking', kind: 'missing_document', message: 'No W-2', resolved: true, resolvedBy: 'agent' },
    ])
    expect(released.succeeded && released.value.status).toBe('draft')
  })

  it('a material exception never parks the draft', async () => {
    const { service, record } = await makeDraft()
    const outcome = await service.upsertExceptions(record.id, [
      { id: 'x1', severity: 'material', kind: 'inconsistent_source', message: 'Totals differ', resolved: false },
    ])
    expect(outcome.succeeded && outcome.value.status).toBe('draft')
  })

  it('submit refuses from blocked status AND from a desynced draft carrying an unresolved blocking exception', async () => {
    const { service, store, record } = await makeDraft()
    await service.upsertExceptions(record.id, [
      { id: 'x1', severity: 'blocking', kind: 'missing_document', message: 'No W-2', resolved: false },
    ])
    const submitInput = {
      artifact: { kind: 'return_package', title: '2025 Return', content: '{}' },
      checks: [],
      provenance: stampProvenance(PROVENANCE),
    }
    // Normal path: the row is blocked, so the status guard refuses.
    const whileBlocked = await service.submit(record.id, submitInput)
    expect(whileBlocked.succeeded).toBe(false)
    if (whileBlocked.succeeded) return
    expect(whileBlocked.conflict).toBe(false)
    expect(whileBlocked.error).toContain('blocked')

    // Belt-and-braces: a product wrote status draft directly while the
    // blocking exception is still unresolved — submit still refuses, naming it.
    const desynced = (await store.load(record.id)) as WorkProductRecord
    store.put({ ...desynced, status: 'draft' })
    const fromDesyncedDraft = await service.submit(record.id, submitInput)
    expect(fromDesyncedDraft.succeeded).toBe(false)
    if (fromDesyncedDraft.succeeded) return
    expect(fromDesyncedDraft.error).toContain('x1')
  })

  it('submit transitions draft -> ready, persists artifact/checks/provenance, appends history', async () => {
    const { service, record } = await makeDraft()
    const provenance = stampProvenance(PROVENANCE, () => 2_000)
    const outcome = await service.submit(record.id, {
      artifact: { kind: 'return_package', title: '2025 Return', path: 'out/return.md' },
      checks: [{ id: 'c1', name: 'totals_reconcile', passed: true, source: 'agent' }],
      provenance,
    })
    expect(outcome.succeeded).toBe(true)
    if (!outcome.succeeded) return
    expect(outcome.value.status).toBe('ready')
    expect(outcome.value.artifact?.title).toBe('2025 Return')
    expect(outcome.value.history).toHaveLength(1)
    expect(outcome.value.history[0]).toMatchObject({ version: 1, status: 'ready', artifactPath: 'out/return.md' })
  })

  it('verdict approve supersedes the scope prior approved version (exactly one current)', async () => {
    const h = harness()
    const { service, store } = h
    // v1 approved.
    const v1 = await makeDraft(h)
    await service.submit(v1.record.id, {
      artifact: { kind: 'return_package', title: 'v1', content: 'a' },
      checks: [],
      provenance: stampProvenance(PROVENANCE),
    })
    await service.applyVerdict(v1.record.id, { verdict: 'approve', reviewedBy: 'drew' })
    // v2 draft -> ready -> approved.
    const v2 = await service.create({
      workspaceId: 'ws',
      threadId: 'thread-1',
      scopeKey: 'return:acme:2025',
      version: await service.nextVersion('ws', 'return:acme:2025'),
      provenance: stampProvenance(PROVENANCE),
    })
    expect(v2.version).toBe(2)
    await service.submit(v2.id, {
      artifact: { kind: 'return_package', title: 'v2', content: 'b' },
      checks: [],
      provenance: stampProvenance(PROVENANCE),
    })
    const approved = await service.applyVerdict(v2.id, { verdict: 'approve', reviewedBy: 'drew' })
    expect(approved.succeeded).toBe(true)

    const v1After = await store.load(v1.record.id)
    expect(v1After?.status).toBe('superseded')
    const v2After = await store.load(v2.id)
    expect(v2After?.status).toBe('approved')
  })

  it('verdict request_changes appends the reviewer note; reopen bumps the version', async () => {
    const { service, record } = await makeDraft()
    await service.submit(record.id, {
      artifact: { kind: 'return_package', title: 'v1', content: 'a' },
      checks: [],
      provenance: stampProvenance(PROVENANCE),
    })
    const verdict = await service.applyVerdict(record.id, {
      verdict: 'request_changes',
      reviewedBy: 'drew',
      note: 'Line 9 lacks the 1099 amount',
    })
    expect(verdict.succeeded && verdict.value.status).toBe('changes_requested')
    if (!verdict.succeeded) return
    expect(verdict.value.history.at(-1)).toMatchObject({
      status: 'changes_requested',
      reviewedBy: 'drew',
      reviewNote: 'Line 9 lacks the 1099 amount',
    })

    const reopened = await service.reopen(record.id)
    expect(reopened.succeeded && reopened.value.status).toBe('draft')
    expect(reopened.succeeded && reopened.value.version).toBe(2)
  })

  it('rejects a verdict on a non-ready record (deterministic, not a conflict)', async () => {
    const { service, record } = await makeDraft()
    const outcome = await service.applyVerdict(record.id, { verdict: 'approve', reviewedBy: 'drew' })
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) return
    expect(outcome.conflict).toBe(false)
    expect(outcome.error).toContain('draft')
  })

  it('surfaces a concurrent write as a typed conflict, never a clobber', async () => {
    const { service, store, record } = await makeDraft()
    await service.upsertExceptions(record.id, [
      { id: 'x1', severity: 'blocking', kind: 'k', message: 'm', resolved: false },
    ])
    const blocked = (await store.load(record.id)) as WorkProductRecord
    expect(blocked.status).toBe('blocked')
    // A concurrent owner releases the row after our read; the stale CAS
    // (guarded on the blocked status we read) must miss and return null.
    store.put({ ...blocked, status: 'draft' })
    const stale = await store.update(
      record.id,
      { status: 'blocked', version: blocked.version },
      { status: 'draft' },
    )
    expect(stale).toBeNull()
  })
})
