/** Real Sandbox SDK -> authenticated loopback API -> recovery manager -> real
 * SQLite compare-and-set. No SDK/fetch/clock/manager implementation is replaced.
 * This boundary makes no model or external service calls. */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { Sandbox } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceSandboxRecoveryManager, isWorkspaceSandboxRecoveryState,
  preferredWorkspaceSandboxRecoveryBoxKey, shouldRestoreWorkspaceSandboxRecovery,
  WORKSPACE_SANDBOX_MISSING, type WorkspaceSandboxRecoveryState,
} from '../src/sandbox/recovery'

const workspaceId = 'workspace-a'
const originalId = 'sandbox-original'
const originalKey = 'app:workspace:workspace-a:old-epoch'
const replacementKey = 'app:workspace:workspace-a:new-epoch:replacement'
const now = Date.parse('2026-10-24T03:00:00Z')
const stop = '2026-10-24T01:21:45Z'
const finalTime = '2026-10-24T01:22:24Z'

function pending(detectedAt = '2026-10-24T01:34:28Z'): WorkspaceSandboxRecoveryState {
  return {
    code: WORKSPACE_SANDBOX_MISSING, sandboxId: originalId, detectedAt,
    snapshot: { availability: 'stale', freshness: 'stale', snapshot: {
      fromSandboxId: originalId, createdAt: '2026-10-23T10:17:05Z', snapshotId: 'older-snapshot',
    } },
    action: 'missing_replacement_started', replacementBoxKey: replacementKey,
  }
}

async function boundary(initial = pending()) {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE recovery (workspace TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec('CREATE TABLE retained_work (sandbox_id TEXT, contents TEXT, written_at TEXT)')
  let nextReadDelivery: Promise<void> | undefined
  let deliveredRead: (() => void) | undefined
  const pauseNextRead = () => {
    let release!: () => void
    nextReadDelivery = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { deliveredRead = resolve })
    return { started, release }
  }
  const read = async (id: string) => {
    const row = db.prepare('SELECT value FROM recovery WHERE workspace = ?').get(id) as { value: string } | undefined
    // Actual SQL is already read. Delay only delivery, as a remote D1 response
    // may arrive after another request commits; no returned value is substituted.
    const delivery = nextReadDelivery
    if (delivery) {
      nextReadDelivery = undefined
      deliveredRead?.()
      await delivery
    }
    return row ? JSON.parse(row.value) as WorkspaceSandboxRecoveryState : undefined
  }
  const write = async (id: string, value: WorkspaceSandboxRecoveryState) => {
    db.prepare('INSERT INTO recovery VALUES (?, ?) ON CONFLICT(workspace) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value))
  }
  const store = {
    read, write,
    insertIfAbsent: async (id: string, value: WorkspaceSandboxRecoveryState) =>
      Number(db.prepare('INSERT INTO recovery VALUES (?, ?) ON CONFLICT(workspace) DO NOTHING')
        .run(id, JSON.stringify(value)).changes) === 1,
    compareAndSet: async (id: string, previous: WorkspaceSandboxRecoveryState, next: WorkspaceSandboxRecoveryState) =>
      Number(db.prepare('UPDATE recovery SET value = ? WHERE workspace = ? AND value = ?')
        .run(JSON.stringify(next), id, JSON.stringify(previous)).changes) === 1,
  }
  await write(workspaceId, initial)
  const manager = createWorkspaceSandboxRecoveryManager(store)
  const state = {
    original: {
      id: originalId, name: originalKey, status: 'stopped', lifecycleState: 'suspended', suspendedAt: stop,
      filesystemIncarnationId: 'original-incarnation', filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
      createdAt: '2026-10-10T09:00:00Z', metadata: { harness: 'opencode' },
    } as Record<string, unknown> | null,
    snapshots: { success: true, source: 'primary', snapshots: [{ snapshotId: 'final-snapshot', projectRef: originalId,
      createdAt: finalTime, tags: ['pre-suspend'], remoteSync: 'synced' }] } as Record<string, unknown>,
    listing: { sandboxes: [], listingComplete: true } as Record<string, unknown>,
    listingStatus: 200,
    listingBody: undefined as string | undefined,
    listingReads: 0,
    beforeSecondListing: undefined as (() => Promise<void>) | undefined,
    snapshotStatus: 200,
    rawBody: undefined as string | undefined,
    originalReads: 0,
    beforeSecondGet: undefined as (() => Promise<void>) | undefined,
  }
  const requests: string[] = []
  const server = createServer((req, res) => {
    void (async () => {
      requests.push(`${req.method} ${req.url}`)
      const json = (body: unknown, code = 200) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      if (req.headers.authorization !== 'Bearer local-recovery-owner') return json({ error: 'unauthorized' }, 401)
      if (req.method !== 'GET') return json({ error: 'No lifecycle mutation permitted' }, 409)
      if (req.url === '/v1/sandboxes') {
        if (++state.listingReads === 2) await state.beforeSecondListing?.()
        if (state.listingBody !== undefined) return res.writeHead(state.listingStatus, { 'content-type': 'application/json' }).end(state.listingBody)
        return json(state.listing, state.listingStatus)
      }
      if (req.url === `/v1/sandboxes/${originalId}`) {
        if (++state.originalReads === 2) await state.beforeSecondGet?.()
        return json(state.original ?? { error: 'Sandbox not found' }, state.original ? 200 : 404)
      }
      if (req.url === `/v1/sandboxes/${originalId}/snapshots`) {
        if (state.rawBody !== undefined) return res.writeHead(state.snapshotStatus, { 'content-type': 'application/json' }).end(state.rawBody)
        return json(state.snapshots, state.snapshotStatus)
      }
      return json({ error: 'Unexpected request' }, 404)
    })().catch(() => { res.writeHead(500).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = new Sandbox({ apiKey: 'local-recovery-owner', baseUrl, timeoutMs: 1_000 })
  const options = { workspaceId, client, now, ownsOriginalBoxKey: (identity: { workspaceId: string; boxKey: string }) =>
    identity.workspaceId === workspaceId && identity.boxKey.startsWith(`app:workspace:${workspaceId}:`) }
  // The same boundary can execute against the old source for the semantic red
  // control: no reconcile API then means the old persisted action-only choice.
  const reconcile = async () => {
    if (manager.reconcileOriginal) return manager.reconcileOriginal(options)
    // Old-source red control still crosses the real SDK/HTTP boundary: it can
    // observe the recovered original and final snapshot, but its actual old
    // manager/selector keeps choosing the persisted replacement action.
    const original = await client.get(initial.sandboxId)
    await original?.listSnapshots()
    return { status: 'unchanged', recovery: await manager.read(workspaceId) }
  }
  return {
    db, store, manager, state, requests, options, reconcile, pauseNextRead,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      db.close()
    },
  }
}

describe('recovered original selection over SDK HTTP and SQLite CAS', () => {
  it.each(['primary', 'customer'])('accepts the public %s source-bearing snapshot envelope through the authenticated SDK', async source => {
    const peer = await boundary()
    try {
      peer.state.snapshots.source = source
      const result = await peer.reconcile()
      expect(result.status).toBe('recovered')
      expect(preferredWorkspaceSandboxRecoveryBoxKey(await peer.manager.read(workspaceId))).toBe(originalKey)
      expect(peer.requests.every(request => request.startsWith('GET '))).toBe(true)
    } finally { await peer.close() }
  })

  it.each([
    { success: false }, { success: 'true' }, { source: 'primary-fallback' },
    { source: 'unknown-repository' }, { source: { name: 'primary' } }, { deleted: true },
  ])('refuses an incomplete or contradictory snapshot envelope %j', async envelope => {
    const peer = await boundary()
    try {
      Object.assign(peer.state.snapshots, envelope)
      expect(await peer.reconcile()).toMatchObject({ status: 'unverified', reason: 'final_snapshot_unverified' })
      expect(await peer.manager.read(workspaceId)).toEqual(pending())
    } finally { await peer.close() }
  })

  it('accepts the documented older envelope with optional success/source absent', async () => {
    const peer = await boundary()
    try {
      delete peer.state.snapshots.success
      delete peer.state.snapshots.source
      expect((await peer.reconcile()).status).toBe('recovered')
    } finally { await peer.close() }
  })

  it.each([
    ['before', '2026-10-24T01:34:28Z'],
    ['after', '2026-10-24T01:10:00Z'],
  ])('uses the committed original recovered %s the recorded replacement action', async (_timing, detectedAt) => {
    const peer = await boundary(pending(detectedAt))
    try {
      const result = await peer.reconcile()
      expect(preferredWorkspaceSandboxRecoveryBoxKey(result.recovery)).toBe(originalKey)
      expect(result.status).toBe('recovered')
      expect(shouldRestoreWorkspaceSandboxRecovery(result.recovery)).toBe(false)
      const persisted = await peer.manager.read(workspaceId)
      expect(isWorkspaceSandboxRecoveryState(persisted)).toBe(true)
      expect(persisted).toMatchObject({ action: 'original_recovered', replacementBoxKey: replacementKey,
        originalBoxKey: originalKey, originalRecovered: { snapshotId: 'final-snapshot', snapshotCreatedAt: finalTime.replace('Z', '.000Z') } })
      // An unobserved/in-flight create may still finish, but its captured key
      // must not authorize completion or use after the CAS invalidates it.
      expect(await peer.manager.complete({ workspaceId, replacementSandboxId: 'late-physical-box', replacementBoxKey: replacementKey })).toBeUndefined()
      expect(preferredWorkspaceSandboxRecoveryBoxKey(await peer.manager.read(workspaceId))).toBe(originalKey)
      await expect(peer.manager.record(workspaceId, pending())).rejects.toThrow('Sandbox recovery changed')
      expect(preferredWorkspaceSandboxRecoveryBoxKey(await peer.manager.read(workspaceId))).toBe(originalKey)
      expect(peer.requests).toEqual(['GET /v1/sandboxes', `GET /v1/sandboxes/${originalId}`, `GET /v1/sandboxes/${originalId}/snapshots`, `GET /v1/sandboxes/${originalId}`, 'GET /v1/sandboxes'])
    } finally { await peer.close() }
  })

  it('allows absent stopped incarnation metadata while preserving committed lifecycle proof', async () => {
    const peer = await boundary()
    try {
      delete peer.state.original!.filesystemIncarnationId
      delete peer.state.original!.filesystemIncarnationProvenance
      delete peer.state.original!.filesystemIncarnationReadiness
      expect((await peer.reconcile()).status).toBe('recovered')
    } finally { await peer.close() }
  })

  it.each(['missing-id', 'missing-provenance', 'missing-readiness', 'transitioning-without-provenance', 'null-provenance', 'invalid-provenance', 'blank-id'])(
    'refuses partial stopped incarnation metadata: %s without changing recovery', async kind => {
      const peer = await boundary()
      try {
        if (kind === 'missing-id') delete peer.state.original!.filesystemIncarnationId
        else if (kind === 'missing-provenance') delete peer.state.original!.filesystemIncarnationProvenance
        else if (kind === 'missing-readiness') delete peer.state.original!.filesystemIncarnationReadiness
        else if (kind === 'transitioning-without-provenance') {
          delete peer.state.original!.filesystemIncarnationProvenance
          peer.state.original!.filesystemIncarnationReadiness = 'transitioning'
        } else if (kind === 'null-provenance') peer.state.original!.filesystemIncarnationProvenance = null
        else if (kind === 'invalid-provenance') peer.state.original!.filesystemIncarnationProvenance = 'invalid'
        else peer.state.original!.filesystemIncarnationId = ' '
        expect((await peer.reconcile()).status).toBe('unverified')
        expect(await peer.manager.read(workspaceId)).toEqual(pending())
        expect(peer.requests.every(request => request.startsWith('GET '))).toBe(true)
      } finally { await peer.close() }
    },
  )

  it.each(['missing', 'failed', 'suspending', 'running', 'unknown-phase', 'transitioning', 'foreign-id', 'foreign-workspace', 'missing-stop'])(
    'refuses an unverified %s original without changing recovery or physical state', async kind => {
      const peer = await boundary()
      try {
        if (kind === 'missing') peer.state.original = null
        else if (kind === 'failed' || kind === 'running') peer.state.original!.status = kind
        else if (kind === 'suspending') peer.state.original!.lifecycleState = kind
        else if (kind === 'unknown-phase') delete peer.state.original!.lifecycleState
        else if (kind === 'transitioning') peer.state.original!.filesystemIncarnationReadiness = kind
        else if (kind === 'foreign-id') peer.state.original!.id = 'sandbox-other'
        else if (kind === 'foreign-workspace') peer.state.original!.name = 'app:workspace:workspace-b:old-epoch'
        else delete peer.state.original!.suspendedAt
        expect((await peer.reconcile()).status).toBe('unverified')
        expect(await peer.manager.read(workspaceId)).toEqual(pending())
        expect(peer.requests.every(request => request.startsWith('GET '))).toBe(true)
      } finally { await peer.close() }
    },
  )

  it.each(['pending-sync', 'failed-sync', 'missing-sync', 'wrong-source', 'conflicting-source', 'old-capture', 'future', 'missing-tag', 'ambiguous', 'partial', 'malformed', 'too-large', 'too-many', 'refused', 'newer-pending'])(
    'refuses %s snapshot evidence rather than selecting an older restore point', async kind => {
      const peer = await boundary()
      try {
        const snapshots = peer.state.snapshots.snapshots as Array<Record<string, unknown>>
        const snapshot = snapshots[0]!
        if (kind === 'pending-sync') snapshot.remoteSync = 'pending'
        else if (kind === 'failed-sync') snapshot.remoteSync = 'failed'
        else if (kind === 'missing-sync') delete snapshot.remoteSync
        else if (kind === 'wrong-source') snapshot.sandboxId = 'sandbox-other'
        else if (kind === 'conflicting-source') {
          snapshot.sandboxId = originalId
          snapshot.projectRef = 'sandbox-other'
        } else if (kind === 'old-capture') snapshot.createdAt = '2026-10-24T01:20:00Z'
        else if (kind === 'future') snapshot.createdAt = '2026-10-25T00:00:00Z'
        else if (kind === 'missing-tag') snapshot.tags = ['manual']
        else if (kind === 'ambiguous') snapshots.push({ ...snapshot, snapshotId: 'other-final' })
        else if (kind === 'partial') peer.state.snapshots.nextCursor = 'more'
        else if (kind === 'malformed') peer.state.rawBody = '{"snapshots":['
        else if (kind === 'too-large') peer.state.rawBody = JSON.stringify({ snapshots, padding: 'a'.repeat(256 * 1024) })
        else if (kind === 'too-many') peer.state.snapshots.snapshots = Array.from({ length: 257 }, (_, i) => ({ ...snapshot, snapshotId: `snapshot-${i}` }))
        else if (kind === 'refused') peer.state.snapshotStatus = 503
        else snapshots.push({ ...snapshot, snapshotId: 'latest-pending', createdAt: '2026-10-24T01:23:00Z', remoteSync: 'pending' })
        expect((await peer.reconcile()).status).toBe('unverified')
        expect(await peer.manager.read(workspaceId)).toEqual(pending())
        expect(peer.requests.every(request => request.startsWith('GET '))).toBe(true)
      } finally { await peer.close() }
    },
  )

  it.each(['running', 'stopped', 'pending', 'failed'])('preserves an unbound physical %s replacement even when the original snapshot is newer', async status => {
    const peer = await boundary()
    try {
      peer.db.prepare('INSERT INTO retained_work VALUES (?, ?, ?)').run('physical-unbound', 'newer retained work', '2026-10-24T02:59:00Z')
      peer.state.listing.sandboxes = [{ id: 'physical-unbound', name: replacementKey, status,
        lastActivityAt: '2026-10-24T02:59:00Z', createdAt: '2026-10-24T02:00:00Z' }]
      expect(await peer.reconcile()).toMatchObject({ status: 'conflict', reason: 'replacement_physically_present' })
      expect(await peer.manager.read(workspaceId)).toEqual(pending())
      expect(peer.requests).toEqual(['GET /v1/sandboxes'])
      expect(peer.db.prepare('SELECT contents FROM retained_work WHERE sandbox_id = ?').get('physical-unbound')).toEqual({ contents: 'newer retained work' })
    } finally { await peer.close() }
  })

  it.each(['incomplete', 'missing-completeness', 'pagination', 'wrong-total', 'malformed', 'refused', 'too-many', 'too-large'])(
    'fails closed on %s replacement inventory without inferring physical absence', async kind => {
      const peer = await boundary()
      try {
        if (kind === 'incomplete') peer.state.listing.listingComplete = false
        else if (kind === 'missing-completeness') delete peer.state.listing.listingComplete
        else if (kind === 'pagination') peer.state.listing.nextCursor = 'more'
        else if (kind === 'wrong-total') peer.state.listing.total = 1
        else if (kind === 'malformed') peer.state.listingBody = '{"sandboxes":['
        else if (kind === 'refused') peer.state.listingStatus = 503
        else if (kind === 'too-many') peer.state.listing.sandboxes = Array.from({ length: 257 }, (_, i) => ({ id: `box-${i}`, name: `other-${i}` }))
        else peer.state.listingBody = JSON.stringify({ sandboxes: [], listingComplete: true, padding: 'a'.repeat(256 * 1024) })
        expect(await peer.reconcile()).toMatchObject({ status: 'unverified', reason: 'replacement_listing_unverified' })
        expect(await peer.manager.read(workspaceId)).toEqual(pending())
        expect(peer.requests).toEqual(['GET /v1/sandboxes'])
      } finally { await peer.close() }
    },
  )

  it('preserves a replacement that appears during original proof', async () => {
    const peer = await boundary()
    try {
      peer.state.beforeSecondListing = async () => {
        peer.state.listing.sandboxes = [{ id: 'late-physical-box', name: replacementKey, status: 'running' }]
      }
      expect(await peer.reconcile()).toMatchObject({ status: 'conflict', reason: 'replacement_physically_present' })
      expect(await peer.manager.read(workspaceId)).toEqual(pending())
      expect(peer.state.listingReads).toBe(2)
    } finally { await peer.close() }
  })

  it('rechecks incomplete inventory after original proof rather than relying on its earlier absence observation', async () => {
    const peer = await boundary()
    try {
      peer.state.beforeSecondListing = async () => { peer.state.listing.listingComplete = false }
      expect(await peer.reconcile()).toMatchObject({ status: 'unverified', reason: 'replacement_listing_unverified' })
      expect(await peer.manager.read(workspaceId)).toEqual(pending())
    } finally { await peer.close() }
  })

  it('does not overwrite a pending physical binding with another ID under the same key', async () => {
    const peer = await boundary({ ...pending(), replacementSandboxId: 'physical-a' })
    try {
      expect(await peer.manager.complete({ workspaceId, replacementSandboxId: 'physical-b', replacementBoxKey: replacementKey })).toBeUndefined()
      expect(await peer.manager.read(workspaceId)).toMatchObject({ action: 'missing_replacement_started', replacementSandboxId: 'physical-a' })
      expect(await peer.manager.complete({ workspaceId, replacementSandboxId: 'physical-a', replacementBoxKey: replacementKey })).toMatchObject({ action: 'missing_replacement_completed', replacementSandboxId: 'physical-a' })
    } finally { await peer.close() }
  })

  it('lets only one of two physical IDs complete a simultaneous same-key race', async () => {
    const peer = await boundary()
    try {
      const settled = await Promise.allSettled([
        peer.manager.complete({ workspaceId, replacementSandboxId: 'physical-a', replacementBoxKey: replacementKey }),
        peer.manager.complete({ workspaceId, replacementSandboxId: 'physical-b', replacementBoxKey: replacementKey }),
      ])
      expect(settled.filter(result => result.status === 'fulfilled' && result.value !== undefined)).toHaveLength(1)
      expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1)
      const current = await peer.manager.read(workspaceId)
      expect(current?.action).toBe('missing_replacement_completed')
      expect(['physical-a', 'physical-b']).toContain(current?.replacementSandboxId)
    } finally { await peer.close() }
  })

  it('fences concurrent replacement completion without overwriting the accepted replacement', async () => {
    const peer = await boundary()
    try {
      peer.state.beforeSecondGet = async () => {
        expect(await peer.manager.complete({ workspaceId, replacementSandboxId: 'replacement-live', replacementBoxKey: replacementKey })).toMatchObject({ action: 'missing_replacement_completed' })
      }
      expect(await peer.reconcile()).toMatchObject({ status: 'conflict', reason: 'recovery_changed' })
      expect(await peer.manager.read(workspaceId)).toMatchObject({ action: 'missing_replacement_completed', replacementSandboxId: 'replacement-live' })
    } finally { await peer.close() }
  })

  it('fences a simultaneously replaced recovery record and does not merge its proof into another original', async () => {
    const peer = await boundary()
    try {
      peer.state.beforeSecondGet = () => peer.store.write(workspaceId, { ...pending(), sandboxId: 'different-original', replacementBoxKey: 'new-attempt' })
      expect((await peer.reconcile()).status).toBe('conflict')
      expect(await peer.manager.read(workspaceId)).toMatchObject({ sandboxId: 'different-original', replacementBoxKey: 'new-attempt' })
    } finally { await peer.close() }
  })

  it('allows exactly one of simultaneous reconcilers to commit', async () => {
    const peer = await boundary()
    try {
      const results = await Promise.all([peer.reconcile(), peer.reconcile()])
      expect(results.map(result => result.status).sort()).toEqual(['conflict', 'recovered'])
      expect(preferredWorkspaceSandboxRecoveryBoxKey(await peer.manager.read(workspaceId))).toBe(originalKey)
    } finally { await peer.close() }
  })

  it('refuses a bound replacement and never silently switches a completed one', async () => {
    const peer = await boundary({ ...pending(), replacementSandboxId: 'replacement-live' })
    try {
      expect((await peer.reconcile()).status).toBe('conflict')
      await peer.store.write(workspaceId, { ...pending(), action: 'missing_replacement_completed', replacementSandboxId: 'replacement-live' })
      expect((await peer.reconcile()).status).toBe('unchanged')
      expect(preferredWorkspaceSandboxRecoveryBoxKey(await peer.manager.read(workspaceId))).toBe(replacementKey)
      expect(peer.requests).toEqual([])
      await expect(peer.manager.record(workspaceId, pending())).rejects.toThrow('Sandbox recovery changed')
      await peer.store.write(workspaceId, { ...pending(), code: 'EGRESS_PROXY_RECOVERY_REQUIRED', action: 'snapshot_replacement_completed', replacementSandboxId: 'replacement-live' })
      await expect(peer.manager.record(workspaceId, pending())).rejects.toThrow('Sandbox recovery changed')
      expect(await peer.manager.read(workspaceId)).toMatchObject({ action: 'snapshot_replacement_completed', replacementSandboxId: 'replacement-live' })
    } finally { await peer.close() }
  })

  it('requires atomic storage and leaves manual egress decisions alone', async () => {
    const peer = await boundary()
    try {
      const manager = createWorkspaceSandboxRecoveryManager({ read: peer.store.read, write: peer.store.write })
      expect(await manager.reconcileOriginal(peer.options)).toMatchObject({ status: 'unverified', reason: 'atomic_transition_required' })
      await peer.store.write(workspaceId, { ...pending(), code: 'EGRESS_PROXY_RECOVERY_REQUIRED', action: 'deletion_declined' })
      expect((await peer.reconcile()).status).toBe('unchanged')
      expect(peer.requests).toEqual([])
    } finally { await peer.close() }
  })

  it('fences a delayed stale recorder after reconciliation commits', async () => {
    const peer = await boundary()
    try {
      const delivery = peer.pauseNextRead()
      const staleRecord = peer.manager.record(workspaceId, pending())
      await delivery.started
      expect((await peer.reconcile()).status).toBe('recovered')
      delivery.release()
      await expect(staleRecord).rejects.toThrow('Sandbox recovery changed')
      expect(preferredWorkspaceSandboxRecoveryBoxKey(await peer.manager.read(workspaceId))).toBe(originalKey)
    } finally { await peer.close() }
  })

  it('fences an absent-state insert whose delayed read predates recovery and reconciliation', async () => {
    const peer = await boundary()
    try {
      peer.db.prepare('DELETE FROM recovery WHERE workspace = ?').run(workspaceId)
      const delivery = peer.pauseNextRead()
      const staleInsert = peer.manager.record(workspaceId, pending())
      await delivery.started
      await peer.manager.record(workspaceId, pending())
      expect((await peer.reconcile()).status).toBe('recovered')
      delivery.release()
      await expect(staleInsert).rejects.toThrow('Sandbox recovery changed')
      expect(preferredWorkspaceSandboxRecoveryBoxKey(await peer.manager.read(workspaceId))).toBe(originalKey)
    } finally { await peer.close() }
  })

  it('rejects original incarnation changes during proof without marking a replacement completed', async () => {
    const peer = await boundary()
    try {
      peer.state.beforeSecondGet = async () => { peer.state.original!.filesystemIncarnationId = 'different-incarnation' }
      expect(await peer.reconcile()).toMatchObject({ status: 'unverified', reason: 'original_changed_during_read' })
      expect(await peer.manager.read(workspaceId)).toEqual(pending())
    } finally { await peer.close() }
  })
})
