import { describe, expect, it } from 'vitest'

import {
  createInMemoryWorkProductStore,
  createWorkProductRoutes,
  createWorkProductService,
  stampProvenance,
  validateWorkProductVerdictBody,
  type WorkProductPersistedPart,
  type WorkProductRecord,
} from '../src/work-product/index'

const PROVENANCE = { profileHash: 'hash-a', runId: 'run-1' }

async function readyHarness() {
  const store = createInMemoryWorkProductStore()
  const service = createWorkProductService({ store, now: () => 1_000, generateId: () => 'wp-1' })
  const record = await service.create({
    workspaceId: 'ws',
    threadId: 'thread-1',
    scopeKey: 'return:acme:2025',
    provenance: stampProvenance(PROVENANCE, () => 1_000),
  })
  await service.upsertEvidence(record.id, [
    { id: 'e1', sourceRef: 'vault/w2.pdf', locator: { page: 1 }, target: '1040.line_1', claim: '$85,000' },
  ])
  await service.submit(record.id, {
    artifact: { kind: 'return_package', title: '2025 Return', path: 'out/return.md', content: 'body' },
    checks: [{ id: 'c1', name: 'evidence_coverage', passed: true, source: 'platform' }],
    provenance: stampProvenance(PROVENANCE, () => 1_000),
  })

  const verdicts: Array<{ verdict: string; note?: string; reviewedBy: string }> = []
  const anchors: WorkProductPersistedPart[] = []
  const exported: WorkProductRecord[] = []
  const routes = createWorkProductRoutes({
    store,
    authorize: async ({ request }) => {
      if (request.headers.get('authorization') !== 'Bearer good') {
        return { ok: false, response: Response.json({ error: 'unauthorized' }, { status: 401 }) }
      }
      return { ok: true, workspaceId: 'ws', reviewedBy: 'drew' }
    },
    onVerdict: ({ verdict, note, reviewedBy }) => {
      verdicts.push({ verdict, ...(note === undefined ? {} : { note }), reviewedBy })
    },
    persistAnchorPart: (part) => {
      anchors.push(part)
    },
    onExport: (record) => {
      exported.push(record)
    },
    logger: { warn() {}, error() {} },
  })
  return { store, routes, verdicts, anchors, exported, id: record.id }
}

const post = (body: unknown, auth = 'Bearer good') =>
  new Request('https://app.example/work-products/verdict', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  })

describe('validateWorkProductVerdictBody', () => {
  it('requires id and a known verdict', () => {
    expect(validateWorkProductVerdictBody({})).toMatchObject({ ok: false })
    expect(validateWorkProductVerdictBody({ id: 'x', verdict: 'ship_it' })).toMatchObject({ ok: false })
  })

  it('request_changes REQUIRES a non-empty note (it becomes the correction turn)', () => {
    expect(validateWorkProductVerdictBody({ id: 'x', verdict: 'request_changes' })).toMatchObject({ ok: false })
    expect(validateWorkProductVerdictBody({ id: 'x', verdict: 'request_changes', note: '  ' })).toMatchObject({ ok: false })
    expect(validateWorkProductVerdictBody({ id: 'x', verdict: 'request_changes', note: 'fix line 9' })).toEqual({
      ok: true,
      id: 'x',
      verdict: 'request_changes',
      note: 'fix line 9',
    })
  })

  it('approve accepts an optional note', () => {
    expect(validateWorkProductVerdictBody({ id: 'x', verdict: 'approve' })).toEqual({ ok: true, id: 'x', verdict: 'approve' })
  })
})

describe('createWorkProductRoutes', () => {
  it('authorize short-circuits every endpoint', async () => {
    const { routes, id } = await readyHarness()
    expect((await routes.list(new Request('https://app.example/wp'))).status).toBe(401)
    expect((await routes.detail(new Request('https://app.example/wp'), id)).status).toBe(401)
    expect((await routes.verdict(post({ id, verdict: 'approve' }, 'Bearer bad'))).status).toBe(401)
  })

  it('list returns workspace records with an optional status filter', async () => {
    const { routes } = await readyHarness()
    const all = await routes.list(new Request('https://app.example/wp', { headers: { authorization: 'Bearer good' } }))
    expect(all.status).toBe(200)
    const { workProducts } = (await all.json()) as { workProducts: WorkProductRecord[] }
    expect(workProducts).toHaveLength(1)
    expect(workProducts[0]?.status).toBe('ready')

    const none = await routes.list(
      new Request('https://app.example/wp?status=approved', { headers: { authorization: 'Bearer good' } }),
    )
    expect(((await none.json()) as { workProducts: unknown[] }).workProducts).toHaveLength(0)
  })

  it('detail 404s outside the workspace and on unknown ids', async () => {
    const { routes } = await readyHarness()
    const missing = await routes.detail(
      new Request('https://app.example/wp', { headers: { authorization: 'Bearer good' } }),
      'nope',
    )
    expect(missing.status).toBe(404)
  })

  it('request_changes: CAS transition + history + onVerdict note + anchor update', async () => {
    const { routes, verdicts, anchors, exported, store, id } = await readyHarness()
    const response = await routes.verdict(post({ id, verdict: 'request_changes', note: 'Line 9 lacks the 1099' }))
    expect(response.status).toBe(200)

    const record = await store.load(id)
    expect(record?.status).toBe('changes_requested')
    expect(record?.history.at(-1)).toMatchObject({ reviewedBy: 'drew', reviewNote: 'Line 9 lacks the 1099' })
    expect(verdicts).toEqual([{ verdict: 'request_changes', note: 'Line 9 lacks the 1099', reviewedBy: 'drew' }])
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({ type: 'work_product', status: 'changes_requested', ref: { id, version: 1 } })
    expect(exported).toHaveLength(0) // export fires only on approval
  })

  it('approve: transition + onExport seam', async () => {
    const { routes, exported, store, id } = await readyHarness()
    const response = await routes.verdict(post({ id, verdict: 'approve' }))
    expect(response.status).toBe(200)
    expect((await store.load(id))?.status).toBe('approved')
    expect(exported).toHaveLength(1)
    expect(exported[0]?.id).toBe(id)
  })

  it('a second verdict on the same version conflicts with 409 — no double-apply', async () => {
    const { routes, id } = await readyHarness()
    expect((await routes.verdict(post({ id, verdict: 'approve' }))).status).toBe(200)
    const again = await routes.verdict(post({ id, verdict: 'request_changes', note: 'too late' }))
    expect(again.status).toBe(409)
    const body = (await again.json()) as { code: string }
    expect(body.code).toBe('VERDICT_CONFLICT')
  })

  it('rejects malformed bodies before touching auth-independent state', async () => {
    const { routes } = await readyHarness()
    expect((await routes.verdict(post({ verdict: 'approve' }))).status).toBe(400)
    expect((await routes.verdict(post({ id: 'x', verdict: 'request_changes' }))).status).toBe(400)
  })

  it('a seam throw is logged, never unwinds the committed verdict', async () => {
    const store = createInMemoryWorkProductStore()
    const service = createWorkProductService({ store, now: () => 1_000, generateId: () => 'wp-1' })
    const record = await service.create({
      workspaceId: 'ws',
      threadId: null,
      scopeKey: 's',
      provenance: stampProvenance(PROVENANCE),
    })
    await service.submit(record.id, {
      artifact: { kind: 'k', title: 'T', content: 'x' },
      checks: [],
      provenance: stampProvenance(PROVENANCE),
    })
    const routes = createWorkProductRoutes({
      store,
      authorize: async () => ({ ok: true, workspaceId: 'ws', reviewedBy: 'drew' }),
      onVerdict: () => {
        throw new Error('chat post failed')
      },
      logger: { warn() {}, error() {} },
    })
    const response = await routes.verdict(post({ id: record.id, verdict: 'approve' }))
    expect(response.status).toBe(200)
    expect((await store.load(record.id))?.status).toBe('approved')
  })
})
