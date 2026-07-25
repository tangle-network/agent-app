import { describe, expect, it } from 'vitest'

import { dispatchAppTool, type AppToolContext, type AppToolHandlers, type AppToolTaxonomy } from '../src/tools/index'
import {
  buildWorkProductTools,
  createInMemoryWorkProductStore,
  type WorkProductRecord,
  type WorkProductToolConfig,
} from '../src/work-product/index'

const CTX: AppToolContext = { userId: 'u1', workspaceId: 'ws', threadId: 'thread-1' }

// The tools must ride the REAL registry dispatch path — never a private one.
const NO_HANDLERS = {} as AppToolHandlers
const NO_TAXONOMY: AppToolTaxonomy = { proposalTypes: [], regulatedTypes: [] }

function harness(overrides: Partial<WorkProductToolConfig> = {}) {
  const store = createInMemoryWorkProductStore()
  const sources = new Set(['vault/w2.pdf', 'vault/1099.pdf'])
  const ready: WorkProductRecord[] = []
  let id = 0
  const tools = buildWorkProductTools({
    store,
    artifactKinds: ['return_package'],
    exceptionKinds: ['missing_document', 'inconsistent_source'],
    resolveSourceRef: async (ref) => sources.has(ref),
    materialTargets: (artifact) => Object.keys(artifact.fields ?? {}),
    provenance: () => ({ profileHash: 'hash-a', runId: 'run-1', sessionId: 'sess-1' }),
    onReady: (record) => {
      ready.push(record)
    },
    now: () => 1_000,
    generateId: () => `wp-${++id}`,
    ...overrides,
  })
  const dispatch = (name: string, args: Record<string, unknown>) =>
    dispatchAppTool(name, args, CTX, { handlers: NO_HANDLERS, taxonomy: NO_TAXONOMY, customTools: tools })
  return { store, tools, dispatch, sources, ready }
}

const EVIDENCE = (id: string, target: string, sourceRef = 'vault/w2.pdf') => ({
  id,
  sourceRef,
  locator: { page: 1, range: 'B1' },
  target,
  claim: '$85,000',
})

describe('work-product tools — the three-registry side channel', () => {
  it('advertises exactly upsert_evidence / flag_exception / submit_work_product', () => {
    const { tools } = harness()
    expect(tools.map((tool) => tool.name)).toEqual(['upsert_evidence', 'flag_exception', 'submit_work_product'])
  })

  it('upsert_evidence creates the draft on first call and upserts by entry id', async () => {
    const { dispatch, store } = harness()
    const first = await dispatch('upsert_evidence', {
      scopeKey: 'return:acme:2025',
      entries: [EVIDENCE('e1', '1040.line_1')],
    })
    expect(first).toMatchObject({ ok: true, result: { workProductId: 'wp-1', version: 1, evidenceCount: 1 } })

    const second = await dispatch('upsert_evidence', {
      scopeKey: 'return:acme:2025',
      entries: [EVIDENCE('e1', '1040.line_1'), EVIDENCE('e2', '1040.line_9', 'vault/1099.pdf')],
    })
    expect(second).toMatchObject({ ok: true, result: { workProductId: 'wp-1', evidenceCount: 2 } })

    const record = await store.load('wp-1')
    expect(record?.provenance).toMatchObject({ profileHash: 'hash-a', runId: 'run-1', servingModels: [] })
    expect(record?.threadId).toBe('thread-1')
  })

  it('a validation failure names the exact entry index and field', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: 'return:acme:2025',
      entries: [EVIDENCE('e1', '1040.line_1'), { id: 'e2', sourceRef: 'vault/w2.pdf', target: '', claim: 'x' }],
    })
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_evidence' })
    if (outcome.ok) return
    expect(outcome.message).toContain('entries[1].target')
  })

  it('a dangling sourceRef fails loud with the entry index — lineage never points at nothing', async () => {
    const { dispatch, store } = harness()
    const outcome = await dispatch('upsert_evidence', {
      scopeKey: 'return:acme:2025',
      entries: [EVIDENCE('e1', '1040.line_1', 'vault/does-not-exist.pdf')],
    })
    expect(outcome).toMatchObject({ ok: false, code: 'unknown_source_ref' })
    if (outcome.ok) return
    expect(outcome.message).toContain('entries[0].sourceRef')
    // Fails BEFORE creating anything: no orphan draft.
    expect(await store.findDraft('ws', 'return:acme:2025')).toBeNull()
  })

  it('flag_exception validates kind membership against the product vocabulary', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('flag_exception', {
      scopeKey: 'return:acme:2025',
      exceptions: [{ id: 'x1', severity: 'blocking', kind: 'not_a_kind', message: 'm' }],
    })
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_exception' })
    if (outcome.ok) return
    expect(outcome.message).toContain('missing_document, inconsistent_source')
  })

  it('an unresolved blocking exception parks the draft; resolving it releases and submit succeeds', async () => {
    const { dispatch } = harness()
    await dispatch('upsert_evidence', { scopeKey: 's', entries: [EVIDENCE('e1', 'f1')] })
    const parked = await dispatch('flag_exception', {
      scopeKey: 's',
      exceptions: [{ id: 'x1', severity: 'blocking', kind: 'missing_document', message: 'No W-2' }],
    })
    expect(parked).toMatchObject({ ok: true, result: { status: 'blocked', unresolvedBlocking: 1 } })

    const refused = await dispatch('submit_work_product', {
      scopeKey: 's',
      artifact: { kind: 'return_package', title: 'T', fields: { f1: 1 } },
    })
    expect(refused).toMatchObject({ ok: false, code: 'blocking_exceptions_unresolved', status: 409 })
    if (refused.ok) return
    expect(refused.message).toContain('x1')

    const released = await dispatch('flag_exception', {
      scopeKey: 's',
      exceptions: [{ id: 'x1', severity: 'blocking', kind: 'missing_document', message: 'No W-2', resolved: true }],
    })
    expect(released).toMatchObject({ ok: true, result: { status: 'draft', unresolvedBlocking: 0 } })

    const submitted = await dispatch('submit_work_product', {
      scopeKey: 's',
      artifact: { kind: 'return_package', title: 'T', fields: { f1: 1 } },
    })
    expect(submitted).toMatchObject({ ok: true, result: { status: 'ready' } })
  })

  it('submit refuses an artifact kind outside the vocabulary', async () => {
    const { dispatch } = harness()
    const outcome = await dispatch('submit_work_product', {
      scopeKey: 's',
      artifact: { kind: 'blog_post', title: 'T', content: 'x' },
    })
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_artifact' })
    if (outcome.ok) return
    expect(outcome.message).toContain('return_package')
  })

  it('evidence_coverage: a missing material target is recorded as a failed platform check AND rejected', async () => {
    const { dispatch, store } = harness()
    await dispatch('upsert_evidence', { scopeKey: 's', entries: [EVIDENCE('e1', '1040.line_1')] })
    const outcome = await dispatch('submit_work_product', {
      scopeKey: 's',
      artifact: { kind: 'return_package', title: 'T', fields: { '1040.line_1': 85_000, '1040.line_9': 1_200 } },
    })
    expect(outcome).toMatchObject({ ok: false, code: 'evidence_coverage_failed' })
    if (outcome.ok) return
    expect(outcome.message).toContain('1040.line_9')

    // The failed check is durable on the still-draft row — visible to the queue.
    const record = await store.findDraft('ws', 's')
    expect(record?.status).toBe('draft')
    expect(record?.checks).toContainEqual(
      expect.objectContaining({ name: 'evidence_coverage', passed: false, source: 'platform' }),
    )
  })

  it('the full happy path: coverage passes, provenance is stamped server-side, onReady fires', async () => {
    const { dispatch, store, ready } = harness()
    await dispatch('upsert_evidence', {
      scopeKey: 's',
      entries: [EVIDENCE('e1', '1040.line_1'), EVIDENCE('e2', '1040.line_9', 'vault/1099.pdf')],
    })
    const outcome = await dispatch('submit_work_product', {
      scopeKey: 's',
      artifact: { kind: 'return_package', title: '2025 Return', fields: { '1040.line_1': 1, '1040.line_9': 2 } },
      checks: [{ id: 'c1', name: 'totals_reconcile', passed: true }],
    })
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toMatchObject({ status: 'ready', version: 1 })
    expect((outcome.result as { checks: unknown[] }).checks).toEqual([
      { name: 'evidence_coverage', passed: true, source: 'platform' },
      { name: 'totals_reconcile', passed: true, source: 'agent' },
    ])
    expect(ready).toHaveLength(1)
    expect(ready[0]?.status).toBe('ready')

    const record = await store.load(ready[0]!.id)
    // Provenance is the route's closure, never model args: servingModels
    // honestly empty until the completion back-fill.
    expect(record?.provenance).toMatchObject({ profileHash: 'hash-a', runId: 'run-1', servingModels: [] })
  })

  it('emission into a scope awaiting review is refused until a verdict lands', async () => {
    const { dispatch } = harness()
    await dispatch('upsert_evidence', { scopeKey: 's', entries: [EVIDENCE('e1', 'f1')] })
    await dispatch('submit_work_product', {
      scopeKey: 's',
      artifact: { kind: 'return_package', title: 'T', fields: { f1: 1 } },
    })
    const outcome = await dispatch('upsert_evidence', { scopeKey: 's', entries: [EVIDENCE('e2', 'f2')] })
    expect(outcome).toMatchObject({ ok: false, code: 'awaiting_review', status: 409 })
  })

  it('batch limits: empty and oversized entry arrays are correctable errors', async () => {
    const { dispatch } = harness()
    expect(await dispatch('upsert_evidence', { scopeKey: 's', entries: [] })).toMatchObject({
      ok: false,
      code: 'missing_entries',
    })
    const oversized = Array.from({ length: 51 }, (_, index) => EVIDENCE(`e${index}`, `f${index}`))
    expect(await dispatch('upsert_evidence', { scopeKey: 's', entries: oversized })).toMatchObject({
      ok: false,
      code: 'batch_too_large',
    })
  })

  it('the model cannot supply ids or identity: rows are minted server-side under ctx workspace', async () => {
    const { dispatch, store } = harness()
    await dispatch('upsert_evidence', {
      scopeKey: 's',
      // Hostile extras: a model-invented row id and workspace are ignored.
      workProductId: 'attacker-chosen',
      workspaceId: 'other-workspace',
      entries: [EVIDENCE('e1', 'f1')],
    })
    expect(await store.load('attacker-chosen')).toBeNull()
    const record = await store.findDraft('ws', 's')
    expect(record?.id).toBe('wp-1')
    expect(record?.workspaceId).toBe('ws')
  })
})
