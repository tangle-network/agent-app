import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  createIdentityBoundWorkspaceKeyManager,
  type DurableWorkspaceKeyConditionalWrites,
  type DurableWorkspaceKeyManager,
  type DurableWorkspaceKeyProvisioner,
  type DurableWorkspaceKeyRecord,
  type DurableWorkspaceKeyStore,
  type WorkspaceKeyIdentity,
  type DurableWorkspaceKeyProvisioningRecord,
} from '../src/billing/index'
import {
  createDelegatedKeyProvisioner,
  createPlatformDelegatedKeyClient,
  type DelegatedKeyCode,
  DelegatedKeyRefusalError,
} from '../src/platform/delegated-keys'

type RemoteKey = {
  id: string
  key: string
  name: string
  product: string
  sourceKeyId: string | null
  platformUserId?: string
  /** Platform refuses the key for now (a funding or eligibility lapse), as verify-by-id reports it. */
  lapse?: boolean
  budgetUsd: number
  budgetSpent: number
  expiresAt: string
  revoked: boolean
}

type Harness = ReturnType<typeof makeHarness>

const START = Date.parse('2026-09-02T00:00:00.000Z')

function missingRemoteKey(): Error & { status: number; code: string } {
  return Object.assign(new Error('missing remote key'), { status: 404, code: 'not_found' })
}

function platformRefusal(status: number, code: DelegatedKeyCode, platformCode?: string): DelegatedKeyRefusalError {
  return new DelegatedKeyRefusalError({ status, code, message: `Platform declined (${platformCode ?? code}).`, ...(platformCode ? { platformCode } : {}) })
}

function makeHarness() {
  const rows = new Map<string, DurableWorkspaceKeyRecord>()
  const remote = new Map<string, RemoteKey>()
  const leases = new Map<string, { operationId: string; expiresAt: number }>()
  let nowMs = START
  let rowNumber = 0
  let keyNumber = 0
  let currentSourceKeyId: string | null = 'source-1'
  let currentPlatformUserId = 'platform-1'
  const endedSources = new Set<string>()
  let refuseRevokeSlot = false
  let verdictReads = 0
  const slotRevocations: Array<{ keyId: string; name: string | null; sourceKeyId: string | null; platformUserId: string }> = []
  let createDelayMs = 0
  let createFailure: Error | null = null
  let returnMissingId = false
  let failNextRevocationFor: string | null = null
  let revocationFailure = new Error('temporary revoke failure')
  let renewalCount = 0
  let renewalDelayMs = 0
  let failRenewal = false
  let failMarkPending = false
  let createStartedResolve: (() => void) | null = null
  const createInputs: Array<{ name: string; product: string; budgetUsd: number; expiresAt: string; idempotencyKey: string }> = []

  const markProvisioningRemote = async (input: { id: string; keyId: string }): Promise<boolean> => {
    const row = rows.get(input.id)
    if (!row) throw new Error(`unknown row ${input.id}`)
    if (row.status !== 'provisioning') return false
    row.keyId = input.keyId
    return true
  }
  const markActive = async (input: {
    id: string
    keyId: string
    keyEncrypted: string
    expiresAt: Date
    budgetUsd: number
  }): Promise<boolean> => {
    const row = rows.get(input.id)
    if (!row) throw new Error(`unknown row ${input.id}`)
    if (row.status !== 'provisioning') return false
    row.keyId = input.keyId
    row.keyEncrypted = input.keyEncrypted
    row.expiresAt = input.expiresAt
    row.budgetUsd = input.budgetUsd
    row.status = 'active'
    return true
  }
  const conditionalWrites: DurableWorkspaceKeyConditionalWrites = {
    markProvisioningRemote,
    markActive,
  }

  const store: DurableWorkspaceKeyStore = {
    async getActive(scope) {
      return [...rows.values()]
        .reverse()
        .find((row) => row.status === 'active'
          && row.workspaceId === scope.workspaceId
          && row.ownerUserId === scope.ownerUserId
          && row.product === scope.product) ?? null
    },
    async listProvisioning(scope) {
      return [...rows.values()]
        .filter((row): row is DurableWorkspaceKeyProvisioningRecord => row.status === 'provisioning'
          && row.workspaceId === scope.workspaceId
          && row.ownerUserId === scope.ownerUserId
          && row.product === scope.product)
    },
    async insertProvisioning(record) {
      rows.set(record.id, { ...record })
    },
    async markProvisioningRemote(input) {
      await markProvisioningRemote(input)
    },
    async markActive(input) {
      await markActive(input)
    },
    conditionalWrites,
    async markRevocationPending(input) {
      if (failMarkPending) throw new Error('state store unavailable')
      const row = rows.get(input.id)
      if (!row) throw new Error(`unknown row ${input.id}`)
      if (row.status === 'revoked' || row.status === 'orphaned') return
      row.status = 'revocation_pending'
      row.nextRevocationAt = input.nextAttemptAt
      row.lastRevocationError = input.error ?? null
      if (input.incrementAttempts) row.revocationAttempts += 1
    },
    async markRevoked(id) {
      const row = rows.get(id)
      if (!row) throw new Error(`unknown row ${id}`)
      row.status = 'revoked'
      row.nextRevocationAt = null
    },
    async markOrphaned(id, error) {
      const row = rows.get(id)
      if (!row) throw new Error(`unknown row ${id}`)
      row.status = 'orphaned'
      row.lastRevocationError = error
      row.nextRevocationAt = null
    },
    async listPendingRevocations(input) {
      return [...rows.values()]
        .filter((row) => row.status === 'revocation_pending'
          && row.product === input.product
          && (input.workspaceId === undefined || row.workspaceId === input.workspaceId)
          && (input.ownerUserId === undefined || row.ownerUserId === input.ownerUserId)
          && (input.includeFuture || !row.nextRevocationAt || row.nextRevocationAt <= input.now))
        .slice(0, input.limit)
    },
    async acquireLease(scope, operationId, now, leaseMs) {
      const existing = leases.get(scope)
      if (existing && existing.expiresAt > now.getTime() && existing.operationId !== operationId) return false
      leases.set(scope, { operationId, expiresAt: now.getTime() + leaseMs })
      return true
    },
    async renewLease(scope, operationId, now, leaseMs) {
      renewalCount += 1
      if (renewalDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, renewalDelayMs))
      if (failRenewal) return false
      const existing = leases.get(scope)
      if (!existing || existing.operationId !== operationId || existing.expiresAt <= now.getTime()) return false
      existing.expiresAt = now.getTime() + leaseMs
      return true
    },
    async releaseLease(scope, operationId) {
      if (leases.get(scope)?.operationId === operationId) leases.delete(scope)
    },
  }

  const createdByIdentity = new Map<string, RemoteKey>()
  // Platform's rules for agent-app's provisioner, bound to the current source: `getKey` is verify-by-id under the
  // service authority (any child; an ended source ends its children); a DELETE with the source reaches only that
  // source's own children (else 403); revoke-slot under the service authority retires only the child's own slot
  // (another user's is a 409; the same user's slot naming another source revokes nothing, which the client reads as a
  // 409 refusal); listing with the source finds only that source's children.
  const provisioner: DurableWorkspaceKeyProvisioner = {
    supportsIdempotentCreate: true,
    async createKey(input) {
      createInputs.push(input)
      const previous = createdByIdentity.get(input.idempotencyKey)
      if (previous) return { id: previous.id, key: previous.key, budgetUsd: previous.budgetUsd, expiresAt: previous.expiresAt }
      createStartedResolve?.()
      createStartedResolve = null
      if (createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, createDelayMs))
      keyNumber += 1
      const id = returnMissingId ? '' : `remote-${keyNumber}`
      const remoteId = id || `orphan-${keyNumber}`
      const key = `secret-${keyNumber}`
      remote.set(remoteId, {
        id: remoteId,
        key,
        name: input.name,
        product: input.product,
        sourceKeyId: currentSourceKeyId,
        platformUserId: currentPlatformUserId,
        budgetUsd: input.budgetUsd,
        budgetSpent: 0,
        expiresAt: input.expiresAt,
        revoked: false,
      })
      createdByIdentity.set(input.idempotencyKey, remote.get(remoteId)!)
      const failure = createFailure
      createFailure = null
      returnMissingId = false
      if (failure) throw failure
      return { id, key, budgetUsd: input.budgetUsd, expiresAt: input.expiresAt }
    },
    async getKey(id) {
      verdictReads += 1
      const key = remote.get(id)
      if (!key || key.revoked || (key.sourceKeyId !== null && endedSources.has(key.sourceKeyId))) throw missingRemoteKey()
      if (key.lapse) throw platformRefusal(403, 'delegated_key.refused')
      return { budgetUsd: key.budgetUsd, budgetSpent: key.budgetSpent, expiresAt: key.expiresAt }
    },
    async revokeKey(id, slot) {
      if (id === failNextRevocationFor) {
        failNextRevocationFor = null
        throw revocationFailure
      }
      const key = remote.get(id)
      if (!key || key.revoked) throw missingRemoteKey()
      if (key.sourceKeyId !== currentSourceKeyId) {
        if (!slot) throw platformRefusal(403, 'delegated_key.refused', 'FORBIDDEN')
        slotRevocations.push({ keyId: id, ...slot })
        if (refuseRevokeSlot) throw platformRefusal(403, 'delegated_key.refused', 'FORBIDDEN')
        if (slot.platformUserId !== key.platformUserId) throw platformRefusal(409, 'delegated_key.failed', 'SLOT_OWNER_MISMATCH')
        if (slot.name !== key.name || slot.sourceKeyId !== key.sourceKeyId) throw platformRefusal(409, 'delegated_key.slot_not_revoked')
      }
      key.revoked = true
    },
    async findCreatedKeys(input) {
      return [...remote.values()]
        .filter((key) => !key.revoked && key.name === input.name && key.product === input.product
          && key.sourceKeyId === currentSourceKeyId)
        .map((key) => ({ id: key.id }))
    },
  }

  const crypto = {
    async encrypt(secret: string) { return `encrypted:${secret}` },
    async decrypt(secret: string) { return secret.slice('encrypted:'.length) },
  }

  function identity(overrides: Partial<WorkspaceKeyIdentity> = {}): WorkspaceKeyIdentity {
    return {
      workspaceId: 'workspace-1',
      ownerUserId: 'owner-1',
      platformUserId: currentPlatformUserId,
      sourceKeyId: currentSourceKeyId,
      sourceKeyFingerprint: currentSourceKeyId ? `fingerprint-${currentSourceKeyId}` : 'fingerprint-none',
      ...overrides,
    }
  }

  function manager(product: string, overrides: Partial<Parameters<typeof createIdentityBoundWorkspaceKeyManager>[0]> = {}): DurableWorkspaceKeyManager {
    return createIdentityBoundWorkspaceKeyManager({
      store,
      provisioner,
      crypto,
      product,
      defaultBudgetUsd: 25,
      now: () => new Date(nowMs),
      nameForIdentity: (current, operationId) => `${product}:${current.workspaceId}:${operationId}`,
      ...overrides,
    })
  }

  function insertProvisioning(overrides: Partial<DurableWorkspaceKeyProvisioningRecord> = {}) {
    const sourceKeyId = overrides.sourceKeyId === undefined ? currentSourceKeyId : overrides.sourceKeyId
    const record: DurableWorkspaceKeyProvisioningRecord = {
      id: `row-${++rowNumber}`,
      workspaceId: 'workspace-1',
      ownerUserId: 'owner-1',
      product: 'router',
      platformUserId: 'platform-1',
      sourceKeyId,
      sourceKeyFingerprint: sourceKeyId ? `fingerprint-${sourceKeyId}` : 'fingerprint-none',
      name: `router:workspace-1:crashed-attempt`,
      idempotencyKey: `workspace-key:row-${rowNumber}`,
      keyId: 'provisioning:crashed-attempt',
      keyEncrypted: '',
      budgetUsd: 25,
      expiresAt: new Date(nowMs + 60_000),
      status: 'provisioning',
      revocationAttempts: 0,
      nextRevocationAt: null,
      lastRevocationError: null,
      createdAt: new Date(nowMs),
      ...overrides,
    }
    rows.set(record.id, record)
    return record
  }

  return {
    rows,
    remote,
    store,
    provisioner,
    manager,
    identity,
    insertProvisioning,
    setNow(value: number) { nowMs = value },
    advance(ms: number) { nowMs += ms },
    setCurrentSourceKeyId(value: string | null) { currentSourceKeyId = value },
    setCurrentPlatformUserId(value: string) { currentPlatformUserId = value },
    endSource(value: string) { endedSources.add(value) },
    setRefuseRevokeSlot(value: boolean) { refuseRevokeSlot = value },
    getSlotRevocations() { return slotRevocations },
    getVerdictReads() { return verdictReads },
    rowFor(keyId: string) { return [...rows.values()].find((row) => row.keyId === keyId) },
    setCreateDelay(value: number) { createDelayMs = value },
    setRenewalDelay(value: number) { renewalDelayMs = value },
    setFailRenewal(value: boolean) { failRenewal = value },
    setFailMarkPending(value: boolean) { failMarkPending = value },
    failCreate(error: Error) { createFailure = error },
    setReturnMissingId(value: boolean) { returnMissingId = value },
    failRevocationFor(value: string | null) { failNextRevocationFor = value },
    setRevocationFailure(value: Error) { revocationFailure = value },
    getLastCreateInput() { return createInputs.at(-1) ?? null },
    getCreateInputs() { return createInputs },
    waitForCreateStart() { return new Promise<void>((resolve) => { createStartedResolve = resolve }) },
    getRenewalCount() { return renewalCount },
  }
}

type PeerKey = { id: string; userId: string; name: string; product: string; parentKeyId: string | null; budgetUsd: number
  expiresAt: string; revoked: boolean; spent: boolean }

/** A loopback Platform serving the routes agent-app's delegated-key client calls, with Platform's key access rules. */
async function loopbackPlatform() {
  const keys = new Map<string, PeerKey>()
  for (const source of ['a', 'b', 'c']) keys.set(`key_src_${source}`, { id: `key_src_${source}`, userId: 'usr_1', name: 'default',
    product: 'router', parentKeyId: null, budgetUsd: 100, expiresAt: new Date(START + 86_400_000).toISOString(), revoked: false, spent: false })
  const peer = { keys, calls: [] as string[], slotRequests: [] as unknown[], refuseRevokeSlot: false, url: '', close: async () => {} }
  let minted = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)) }
      const refuse = (status: number, code: string) => json(status, { success: false, error: { code } })
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, any>
      const path = new URL(request.url!, 'http://peer').pathname
      const byId = /^\/v1\/keys\/([A-Za-z0-9_]+)$/.exec(path)
      if (byId && (request.method === 'DELETE' || request.method === 'GET')) {
        const source = /^Bearer sk-tan-source-([abc])$/.exec(request.headers.authorization ?? '')?.[1]
        const key = keys.get(byId[1]!)
        // An API key may reach only itself and its descendants.
        const status = !source ? 401 : !key ? 404 : key.id === `key_src_${source}` || key.parentKeyId === `key_src_${source}` ? 200 : 403
        peer.calls.push(`${request.method} ${byId[1]} ${status}`)
        if (status !== 200) return refuse(status, status === 403 ? 'FORBIDDEN' : 'NOT_FOUND')
        if (request.method === 'GET') return json(200, { success: true, data: { ...key, revokedAt: key!.revoked ? new Date(START).toISOString() : null } })
        key!.revoked = true
        return json(200, { success: true })
      }
      if (request.headers.authorization !== 'Bearer svc-token' || request.headers['x-service-name'] !== 'tax-agent') return refuse(401, 'UNAUTHORIZED')
      peer.calls.push(`${request.method} ${path}`)
      if (path === '/v1/keys/delegate') {
        const parentKeyId = `key_src_${/^sk-tan-source-([abc])$/.exec(String(body.sourceKey))?.[1]}`
        if (!keys.has(parentKeyId)) return refuse(403, 'SOURCE_KEY_INVALID')
        const id = `key_child_${++minted}`
        keys.set(id, { id, userId: 'usr_1', name: body.name, product: body.product, parentKeyId, budgetUsd: body.budgetUsd,
          expiresAt: body.expiresAt, revoked: false, spent: false })
        return json(201, { success: true, data: { id, key: `sk-tan-child${minted}xxxxxxxxxxxx`, prefix: `sk-tan-child${minted}`,
          name: body.name, provisionedByService: 'tax-agent', product: body.product, scopes: null, budgetUsd: body.budgetUsd,
          attribution: { version: 1, targetService: body.product, delegatedFromKeyId: parentKeyId, payerType: 'user', payerId: 'usr_1',
            resourceType: null, resourceId: null, expiresAt: body.expiresAt } } })
      }
      if (path === '/v1/keys/verify-by-id') {
        const key = keys.get(String(body.keyId))
        const invalidReason = !key ? 'key_not_found' : key.revoked ? 'key_revoked'
          : keys.get(key.parentKeyId ?? '')?.revoked ? 'parent_key_revoked' : key.spent ? 'budget_exhausted' : undefined
        if (invalidReason) return json(200, { valid: false, invalidReason, keyId: body.keyId, budgetUsd: key?.budgetUsd })
        return json(200, { valid: true, keyId: key!.id, budgetUsd: key!.budgetUsd, budgetRemaining: key!.budgetUsd, expiresAt: key!.expiresAt })
      }
      if (path === '/v1/keys/auto-provisioned/revoke-slot') {
        peer.slotRequests.push(body)
        if (peer.refuseRevokeSlot) return refuse(403, 'FORBIDDEN')
        if (!body.sourceKeyId || !body.product) return refuse(400, 'SLOT_IDENTITY_REQUIRED')
        if (!String(body.name).startsWith('auto:')) return refuse(400, 'INVALID_NAME')
        // The exact child in its own slot; a slot naming another source of the same user matches nothing.
        const heads = [...keys.values()].filter((key) => key.id === body.childKeyId && key.userId === body.userId
          && key.name === body.name && key.product === body.product && key.parentKeyId === body.sourceKeyId && !key.revoked)
        for (const key of heads) key.revoked = true
        return json(200, { success: true, data: { revoked: heads.length } })
      }
      return refuse(404, 'NOT_FOUND')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  peer.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  peer.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return peer
}

describe('createIdentityBoundWorkspaceKeyManager', () => {
  it('never returns a key that expired while its secret was being decrypted', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    expect(first.refreshed).toBe(true)
    // The decrypt resolves after the key's expiry: the manager must mint again, not hand the stale key out.
    const slow = h.manager('router', { crypto: {
      async encrypt(secret: string) { return `encrypted:${secret}` },
      async decrypt(secret: string) {
        h.setNow(Date.parse(first.usage.expiresAt) + 1)
        return secret.slice('encrypted:'.length)
      },
    } })
    const second = await slow.ensureKey(h.identity())
    expect(second.refreshed).toBe(true)
    expect(second.key).not.toBe(first.key)
  })

  it('serializes concurrent issuance and partitions products', async () => {
    const h = makeHarness()
    const router = h.manager('router')
    const sandbox = h.manager('sandbox')
    const first = await Promise.all([router.ensureKey(h.identity()), router.ensureKey(h.identity())])
    const sandboxKey = await sandbox.ensureKey(h.identity())

    expect(first[0]?.key).toBe(first[1]?.key)
    expect(first[0]?.usage.keyId).not.toBe(sandboxKey.usage.keyId)
    expect(h.remote.get(first[0]!.usage.keyId)?.product).toBe('router')
    expect(h.remote.get(sandboxKey.usage.keyId)?.product).toBe('sandbox')
    expect([...h.rows.values()].filter((row) => row.status === 'active')).toHaveLength(2)
  })

  it('keeps legacy void lifecycle stores compatible', async () => {
    const h = makeHarness()
    const { conditionalWrites: _conditionalWrites, ...legacyMethods } = h.store
    const legacyStore: DurableWorkspaceKeyStore = {
      ...legacyMethods,
      async markProvisioningRemote(input) {
        await h.store.markProvisioningRemote(input)
      },
      async markActive(input) {
        await h.store.markActive(input)
      },
    }
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: legacyStore,
      provisioner: h.provisioner,
      crypto: {
        async encrypt(value) { return `encrypted:${value}` },
        async decrypt(value) { return value.slice('encrypted:'.length) },
      },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(START),
    })

    const result = await manager.ensureKey(h.identity())

    expect(result.usage.keyId).toBe('remote-1')
    expect([...h.rows.values()].find((row) => row.keyId === 'remote-1')?.status).toBe('active')
    expect(h.remote.get('remote-1')?.revoked).toBe(false)
  })

  it('uses the durable lease across manager instances', async () => {
    const h = makeHarness()
    h.setCreateDelay(25)
    const firstManager = h.manager('router', { leaseMs: 100, leaseRenewIntervalMs: 10 })
    // The lease expires on the harness clock, but the wait budget is wall time.
    // The second manager must outwait the first's whole issuance on a loaded
    // runner, so its budget is far above the 25 ms create delay.
    const secondManager = h.manager('router', { leaseMs: 100, leaseWaitMs: 5_000, leasePollMs: 1 })

    const [first, second] = await Promise.all([
      firstManager.ensureKey(h.identity()),
      secondManager.ensureKey(h.identity()),
    ])

    expect(first.usage.keyId).toBe(second.usage.keyId)
    expect([...h.remote.values()]).toHaveLength(1)
  })

  // The same member's second sign-in presented a new source credential, and the child key a running turn held was
  // revoked mid-reply. A new sign-in by the same Platform user reuses the active child.
  it('keeps the active key when the same Platform user signs in with a new source credential', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())

    h.setCurrentSourceKeyId('source-2')
    const again = await manager.ensureKey(h.identity({ sourceKeyId: 'source-2', sourceKeyFingerprint: 'fingerprint-source-2' }))
    expect(again.usage.keyId).toBe(first.usage.keyId)
    expect(again.key).toBe(first.key)
    expect([...h.rows.values()].filter((row) => row.status === 'active')).toHaveLength(1)
    expect([...h.rows.values()].find((row) => row.keyId === first.usage.keyId)?.status).toBe('active')
    expect([...h.remote.values()].filter((key) => !key.revoked)).toHaveLength(1)
  })

  // A turn holds the key it was handed until it ends. A key reused with less remaining life than one turn can expire
  // mid-turn, so reuse requires a remaining-life floor; below it a fresh key is minted and the old one is retired at its
  // own expiry, never revoked under a turn that still holds it.
  const REUSE_FLOOR_MS = 20 * 60_000

  it('mints a fresh key when the active key has less remaining life than the reuse floor, and never revokes the old one', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.setNow(Date.parse(first.usage.expiresAt) - REUSE_FLOOR_MS + 1)

    const next = await manager.ensureKey(h.identity())
    expect(next.refreshed).toBe(true)
    expect(next.usage.keyId).not.toBe(first.usage.keyId)
    const old = h.rowFor(first.usage.keyId)!
    expect(old.status).not.toBe('active')
    expect(old.nextRevocationAt?.getTime()).toBe(old.expiresAt.getTime())
    expect(h.remote.get(first.usage.keyId)?.revoked).toBe(false)
    expect([...h.rows.values()].filter((row) => row.status === 'active').map((row) => row.keyId)).toEqual([next.usage.keyId])

    // The retired key never blocks the next request, which reuses the fresh key.
    expect((await manager.ensureKey(h.identity())).usage.keyId).toBe(next.usage.keyId)

    // A turn admitted just under the floor runs a whole floor-length turn on the fresh key, past the old key's expiry.
    h.advance(REUSE_FLOOR_MS)
    const turnEnd = Date.parse(first.usage.expiresAt) + 1
    expect(Date.parse(h.remote.get(next.usage.keyId)!.expiresAt)).toBeGreaterThan(turnEnd)
    await expect(h.provisioner.getKey(next.usage.keyId)).resolves.toMatchObject({ expiresAt: next.usage.expiresAt })

    // At its own expiry the old key is retired through the ordinary cleanup.
    expect(await manager.retryPendingRevocations({ workspaceId: 'workspace-1', ownerUserId: 'owner-1' })).toBe(1)
    expect(old.status).toBe('revoked')
  })

  it('reuses the active key while its remaining life is at or above the reuse floor', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.setNow(Date.parse(first.usage.expiresAt) - REUSE_FLOOR_MS)

    const again = await manager.ensureKey(h.identity())
    expect(again.refreshed).toBe(false)
    expect(again.usage.keyId).toBe(first.usage.keyId)
    expect(h.rowFor(first.usage.keyId)?.status).toBe('active')
    expect([...h.remote.values()]).toHaveLength(1)
  })

  // A read-back that cannot answer is not evidence about the key: one bad Platform minute must not rotate every
  // workspace's key and kill every running reply.
  it('neither rotates nor revokes the active key when its read-back cannot answer', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    const outage = h.manager('router', { provisioner: { ...h.provisioner,
      async getKey() { throw Object.assign(new Error('Platform answered HTTP 503'), { status: 503 }) } } })
    await expect(outage.ensureKey(h.identity())).rejects.toThrow('503')
    expect([...h.rows.values()].find((row) => row.keyId === first.usage.keyId)?.status).toBe('active')
    expect(h.remote.get(first.usage.keyId)?.revoked).toBeFalsy()
    expect([...h.remote.values()]).toHaveLength(1)
  })

  // The reused child belongs to the earlier source; the current source may not delete it.
  it('retires a spent child of an earlier source through its own slot and mints again', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.setCurrentSourceKeyId('source-2')
    expect((await manager.ensureKey(h.identity())).usage.keyId).toBe(first.usage.keyId)
    const child = h.remote.get(first.usage.keyId)!
    child.budgetSpent = child.budgetUsd

    const next = await manager.ensureKey(h.identity())
    expect(next.usage.keyId).not.toBe(first.usage.keyId)
    expect(h.remote.get(next.usage.keyId)?.sourceKeyId).toBe('source-2')
    expect(child.revoked).toBe(true)
    expect(h.getSlotRevocations()).toEqual([{ keyId: first.usage.keyId, name: child.name, sourceKeyId: 'source-1', platformUserId: 'platform-1' }])
    expect(h.rowFor(first.usage.keyId)?.status).toBe('revoked')
  })

  it('retires a spent child at once when Platform refuses its cleanup, and issues without waiting', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.setCurrentSourceKeyId('source-2')
    await manager.ensureKey(h.identity())
    const child = h.remote.get(first.usage.keyId)!
    child.budgetSpent = child.budgetUsd
    h.setRefuseRevokeSlot(true)

    const next = await manager.ensureKey(h.identity())
    expect(next.usage.keyId).not.toBe(first.usage.keyId)
    // Platform kept the child, but it can no longer spend: nothing is left to wait for.
    expect(child.revoked).toBe(false)
    expect(h.rowFor(first.usage.keyId)?.status).toBe('revoked')
  })

  it('retires a live child whose cleanup Platform refuses at its own expiry, and issues meanwhile', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.setCurrentSourceKeyId('source-2')
    h.setCurrentPlatformUserId('platform-2')
    h.setRefuseRevokeSlot(true)

    const other = await manager.ensureKey(h.identity())
    expect(other.usage.keyId).not.toBe(first.usage.keyId)
    const old = h.rowFor(first.usage.keyId)!
    expect(old.status).toBe('revocation_pending')
    expect(old.nextRevocationAt?.getTime()).toBe(old.expiresAt.getTime())
    expect(old.lastRevocationError).toBe('cleanup refused (403 FORBIDDEN); the child is retired at its expiry')
    expect(h.remote.get(first.usage.keyId)?.revoked).toBe(false)
    expect((await manager.ensureKey(h.identity())).usage.keyId).toBe(other.usage.keyId)

    // At its expiry the child cannot authenticate: it is retired without reading its verdict.
    h.setNow(old.expiresAt.getTime())
    const reads = h.getVerdictReads()
    expect(await manager.retryPendingRevocations({ workspaceId: 'workspace-1', ownerUserId: 'owner-1' })).toBe(1)
    expect(old.status).toBe('revoked')
    expect(h.getVerdictReads()).toBe(reads)
  })

  it.each([
    [503, 'delegated_key.unavailable'],
    [429, 'delegated_key.unavailable'],
    [408, 'delegated_key.failed'],
  ] as Array<[number, DelegatedKeyCode]>)('keeps retrying and blocks issuance when a cleanup answers a typed %i', async (status, code) => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    h.setCurrentSourceKeyId('source-2')
    h.setCurrentPlatformUserId('platform-2')
    const manager = h.manager('router', { provisioner: { ...h.provisioner, async revokeKey() { throw platformRefusal(status, code) } } })

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    const old = h.rowFor(first.usage.keyId)!
    expect(old.status).toBe('revocation_pending')
    expect(old.nextRevocationAt!.getTime()).toBeLessThan(old.expiresAt.getTime())
    expect(h.getVerdictReads()).toBe(0)
  })

  it('blocks issuance on a transient cleanup failure even when its retry lands past the child expiry', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    h.setNow(Date.parse(first.usage.expiresAt) - 1_000)
    h.setCurrentSourceKeyId('source-2')
    h.setCurrentPlatformUserId('platform-2')
    const manager = h.manager('router', { provisioner: { ...h.provisioner,
      async revokeKey() { throw platformRefusal(503, 'delegated_key.unavailable') } } })

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    const old = h.rowFor(first.usage.keyId)!
    expect(old.nextRevocationAt!.getTime()).toBeGreaterThan(old.expiresAt.getTime())
    // The retry lands past the expiry, yet a second request still refuses to mint beside the live child.
    await expect(manager.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    // Once the child has expired it can no longer authenticate: the next request retires it and issues.
    h.setNow(old.nextRevocationAt!.getTime())
    expect((await manager.ensureKey(h.identity())).usage.keyId).not.toBe(first.usage.keyId)
    expect(old.status).toBe('revoked')
  })

  it('keeps retrying and blocks issuance when the verdict after a refused cleanup cannot be read', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    h.setCurrentSourceKeyId('source-2')
    h.setCurrentPlatformUserId('platform-2')
    h.setRefuseRevokeSlot(true)
    const manager = h.manager('router', { provisioner: { ...h.provisioner,
      async getKey() { throw platformRefusal(503, 'delegated_key.unavailable') } } })

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    const old = h.rowFor(first.usage.keyId)!
    expect(old.status).toBe('revocation_pending')
    expect(old.nextRevocationAt!.getTime()).toBeLessThan(old.expiresAt.getTime())
  })

  it('retires a live child at its expiry when revoke-slot revokes nothing, and never marks it revoked', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    h.setCurrentSourceKeyId('source-2')
    h.setCurrentPlatformUserId('platform-2')
    // The slot names the current source, not the minting one: Platform revokes nothing.
    const manager = h.manager('router', { provisioner: { ...h.provisioner,
      revokeKey: (id, slot) => h.provisioner.revokeKey(id, slot && { ...slot, sourceKeyId: 'source-2' }) } })

    const other = await manager.ensureKey(h.identity())
    expect(other.usage.keyId).not.toBe(first.usage.keyId)
    const old = h.rowFor(first.usage.keyId)!
    expect(old.status).toBe('revocation_pending')
    expect(old.nextRevocationAt?.getTime()).toBe(old.expiresAt.getTime())
    expect(old.lastRevocationError).toContain('409 delegated_key.slot_not_revoked')
    expect(h.remote.get(first.usage.keyId)?.revoked).toBe(false)
  })

  it('retires a live child at its expiry when its verdict after a refused cleanup is a lapse', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    h.remote.get(first.usage.keyId)!.lapse = true
    h.setCurrentSourceKeyId('source-2')
    h.setCurrentPlatformUserId('platform-2')
    h.setRefuseRevokeSlot(true)

    const other = await h.manager('router').ensureKey(h.identity())
    expect(other.usage.keyId).not.toBe(first.usage.keyId)
    const old = h.rowFor(first.usage.keyId)!
    expect(old.status).toBe('revocation_pending')
    expect(old.nextRevocationAt?.getTime()).toBe(old.expiresAt.getTime())
    expect(h.remote.get(first.usage.keyId)?.revoked).toBe(false)
  })

  it('revokes the old child at once, through its own slot, when a different Platform user takes the workspace', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.setCurrentSourceKeyId('source-2')
    h.setCurrentPlatformUserId('platform-2')

    const other = await manager.ensureKey(h.identity())
    expect(other.usage.keyId).not.toBe(first.usage.keyId)
    expect(h.remote.get(first.usage.keyId)?.revoked).toBe(true)
    expect(h.rowFor(first.usage.keyId)?.status).toBe('revoked')
    expect(h.getSlotRevocations()).toMatchObject([{ keyId: first.usage.keyId, sourceKeyId: 'source-1', platformUserId: 'platform-1' }])
  })

  it('mints again when the source that minted the active child is revoked', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.endSource('source-1')
    h.setCurrentSourceKeyId('source-2')

    const next = await manager.ensureKey(h.identity())
    expect(next.usage.keyId).not.toBe(first.usage.keyId)
    expect(h.rowFor(first.usage.keyId)?.status).toBe('revoked')
    expect(h.getSlotRevocations()).toHaveLength(0)
  })

  // agent-app's own client and provisioner, unchanged, against a loopback Platform that applies the key rules the
  // provisioner depends on: a source deletes and reads only its own children; revoke-slot (service token) retires only
  // the child's own slot and answers 200 with nothing revoked for a same-user slot that names another source.
  it('retires a reused child through its own revoke-slot over HTTP, and a refused cleanup never blocks issuance', async () => {
    const peer = await loopbackPlatform()
    try {
      const h = makeHarness()
      const client = createPlatformDelegatedKeyClient({ platformUrl: peer.url, serviceName: 'tax-agent', serviceToken: 'svc-token', now: () => START })
      const signIn = (source: 'a' | 'b' | 'c') => h.manager('router', {
        provisioner: createDelegatedKeyProvisioner({ client, sourceKey: `sk-tan-source-${source}`, product: 'router',
          expect: { payerId: 'usr_1', sourceKeyId: `key_src_${source}` }, payerId: 'usr_1' }),
      }).ensureKey(h.identity({ platformUserId: 'usr_1', sourceKeyId: `key_src_${source}`, sourceKeyFingerprint: `fingerprint-${source}` }))

      const first = await signIn('a')
      expect(first).toMatchObject({ refreshed: true, usage: { keyId: 'key_child_1' } })
      expect(await signIn('b')).toMatchObject({ refreshed: false, key: first.key, usage: { keyId: 'key_child_1' } })

      peer.keys.get('key_child_1')!.spent = true
      const second = await signIn('b')
      expect(second.usage.keyId).toBe('key_child_2')
      expect(peer.keys.get('key_child_1')?.revoked).toBe(true)
      expect(peer.keys.get('key_child_2')?.parentKeyId).toBe('key_src_b')
      expect(peer.slotRequests).toEqual([{ userId: 'usr_1', name: peer.keys.get('key_child_1')!.name, product: 'router',
        childKeyId: 'key_child_1', sourceKeyId: 'key_src_a' }])

      peer.keys.get('key_child_2')!.spent = true
      peer.refuseRevokeSlot = true
      expect((await signIn('c')).usage.keyId).toBe('key_child_3')
      expect(peer.keys.get('key_child_2')?.revoked).toBe(false)
      expect(h.rowFor('key_child_2')?.status).toBe('revoked')
      expect(peer.calls.filter((call) => call.startsWith('DELETE'))).toEqual(['DELETE key_child_1 403', 'DELETE key_child_2 403'])
    } finally {
      await peer.close()
    }
  })

  it('refuses incomplete identities and a mismatched platform owner', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    await expect(manager.ensureKey(h.identity({ sourceKeyFingerprint: '' }))).rejects.toThrow('identity is incomplete')
    await expect(manager.ensureKey(h.identity(), { budgetUsd: 0 })).rejects.toThrow('budgetUsd')

    const first = await manager.ensureKey(h.identity())
    const rebound = await manager.ensureKey(h.identity({ platformUserId: 'platform-2' }))
    expect(rebound.usage.keyId).not.toBe(first.usage.keyId)
  })

  it('reconciles a crashed provisioning row before minting a replacement', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning()
    h.remote.set('crashed-remote', {
      id: 'crashed-remote',
      key: 'crashed-secret',
      name: row.name ?? '',
      product: row.product,
      sourceKeyId: row.sourceKeyId,
      budgetUsd: 25,
      budgetSpent: 0,
      expiresAt: row.expiresAt.toISOString(),
      revoked: false,
    })

    const result = await h.manager('router').ensureKey(h.identity())
    expect(h.remote.get('crashed-remote')?.revoked).toBe(true)
    expect(result.usage.keyId).toBe('remote-1')
    expect(h.rows.get(row.id)?.status).toBe('revoked')
  })

  it('keeps an undiscovered committed child pending when creation is not idempotent', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning()
    h.remote.set('hidden-original', {
      id: 'hidden-original', key: 'original-secret', name: row.name!, product: row.product,
      sourceKeyId: row.sourceKeyId, budgetUsd: 25, budgetSpent: 0,
      expiresAt: row.expiresAt.toISOString(), revoked: false,
    })
    const manager = h.manager('router', {
      provisioner: { ...h.provisioner, supportsIdempotentCreate: undefined, findCreatedKeys: async () => [] },
    })
    await expect(manager.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    expect(h.getCreateInputs()).toHaveLength(0)
    expect(h.rows.get(row.id)?.status).toBe('revocation_pending')
    expect(h.remote.get('hidden-original')?.revoked).toBe(false)
    h.advance(60_000)
    await h.manager('router').ensureKey(h.identity())
    expect(h.remote.get('hidden-original')?.revoked).toBe(true)
  })

  it('probes an empty provisioning row with its persisted create identity', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning()

    const result = await h.manager('router').ensureKey(h.identity())
    const inputs = h.getCreateInputs()

    expect(inputs[0]).toMatchObject({
      name: row.name,
      idempotencyKey: row.idempotencyKey,
      budgetUsd: row.budgetUsd,
      expiresAt: row.expiresAt.toISOString(),
    })
    expect(inputs[1]?.idempotencyKey).not.toBe(row.idempotencyKey)
    expect(h.remote.get('remote-1')?.revoked).toBe(true)
    expect(row.status).toBe('revoked')
    expect(result.usage.keyId).toBe('remote-2')
  })

  it('replays an idempotent create to revoke the original child hidden from discovery', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning()
    const original = await h.provisioner.createKey({ name: row.name!, product: row.product,
      budgetUsd: row.budgetUsd, expiresAt: row.expiresAt.toISOString(), idempotencyKey: row.idempotencyKey! })
    const manager = h.manager('router', {
      provisioner: { ...h.provisioner, findCreatedKeys: async () => [] },
    })
    const result = await manager.ensureKey(h.identity())
    if (!original.id) throw new Error('Fixture create did not return its original id')
    expect(h.remote.get(original.id)?.revoked).toBe(true)
    expect(h.remote.size).toBe(2)
    expect(result.usage.keyId).not.toBe(original.id)
    expect(h.getCreateInputs()[1]?.idempotencyKey).toBe(row.idempotencyKey)
  })

  it('keeps a legacy empty row pending instead of inventing a new create identity', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning()
    delete row.idempotencyKey

    await expect(h.manager('router').ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    expect(h.getCreateInputs()).toHaveLength(0)
    expect(h.rows.get(row.id)?.status).toBe('revocation_pending')
  })

  it('retries an empty pending row when the caller supplies its full identity', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning()
    h.rows.set(row.id, { ...row, status: 'revocation_pending', nextRevocationAt: new Date(START) })

    expect(await h.manager('router').retryPendingRevocations({
      workspaceId: 'workspace-1',
      ownerUserId: 'owner-1',
    }, h.identity())).toBe(1)
    expect(h.rows.get(row.id)?.status).toBe('revoked')
    expect(h.remote.get('remote-1')?.revoked).toBe(true)
  })

  it('keeps a source-mismatched empty provisioning row pending instead of orphaning it', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning({ sourceKeyId: 'old-source', sourceKeyFingerprint: 'old-fingerprint' })

    await expect(h.manager('router').ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    expect(h.rows.get(row.id)?.status).toBe('revocation_pending')
    expect(h.rows.get(row.id)?.status).not.toBe('orphaned')
  })

  it('uses the recovery provisioner for historical reads and revokes after source rotation', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    const recoveryRevocations: string[] = []
    const recoveryProvisioner: DurableWorkspaceKeyProvisioner = {
      ...h.provisioner,
      async revokeKey(id) {
        recoveryRevocations.push(id)
        return h.provisioner.revokeKey(id)
      },
    }
    const sourceProvisioner: DurableWorkspaceKeyProvisioner = {
      ...h.provisioner,
      async getKey() { throw new Error('rotated source is no longer authorized') },
      async revokeKey() { throw new Error('rotated source cannot revoke historical child') },
      async findCreatedKeys() { throw new Error('rotated source cannot list historical children') },
    }
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: h.store,
      provisioner: sourceProvisioner,
      recoveryProvisioner,
      crypto: {
        async encrypt(value) { return `encrypted:${value}` },
        async decrypt(value) { return value.slice('encrypted:'.length) },
      },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(START),
    })

    expect((await manager.getUsage(h.identity()))?.keyId).toBe(first.usage.keyId)
    h.remote.get(first.usage.keyId)!.expiresAt = new Date(START - 1).toISOString()
    const replacement = await manager.ensureKey(h.identity())

    expect(recoveryRevocations).toContain(first.usage.keyId)
    expect(replacement.usage.keyId).not.toBe(first.usage.keyId)
  })

  it('requires an explicit legacy-name resolver for pre-name provisioning rows', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning({ name: null })
    h.remote.set('legacy-remote', {
      id: 'legacy-remote',
      key: 'legacy-secret',
      name: 'legacy:workspace-1',
      product: row.product,
      sourceKeyId: row.sourceKeyId,
      budgetUsd: 25,
      budgetSpent: 0,
      expiresAt: row.expiresAt.toISOString(),
      revoked: false,
    })

    await expect(h.manager('router').ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    expect(h.remote.get('legacy-remote')?.revoked).toBe(false)
    expect(h.rows.get(row.id)?.status).toBe('revocation_pending')
    expect(h.rows.get(row.id)?.lastRevocationError).toContain('legacyNameForRecord')

    const migrated = h.manager('router', { legacyNameForRecord: () => 'legacy:workspace-1' })
    const result = await migrated.ensureKey(h.identity())
    expect(result.usage.keyId).toBe('remote-1')
    expect(h.remote.get('legacy-remote')?.revoked).toBe(true)
  })

  it('cleans a remote key when create returns no id', async () => {
    const h = makeHarness()
    h.setReturnMissingId(true)

    await expect(h.manager('router').ensureKey(h.identity())).rejects.toThrow('no usable child key')
    const input = h.getLastCreateInput()
    expect(input).not.toBeNull()
    const orphan = [...h.remote.values()].find((key) => key.name === input!.name)
    expect(orphan?.revoked).toBe(true)
    expect([...h.rows.values()].every((row) => row.status !== 'active')).toBe(true)
  })

  it('discovers and cleans a remote key when create fails after remote creation', async () => {
    const h = makeHarness()
    const failure = new Error('request timed out after remote commit')
    h.failCreate(failure)

    await expect(h.manager('router').ensureKey(h.identity())).rejects.toBe(failure)
    const input = h.getLastCreateInput()
    expect(input).not.toBeNull()
    expect([...h.remote.values()].find((key) => key.name === input!.name)?.revoked).toBe(true)
  })

  it('still cleans a remote key when the first pending-state write fails', async () => {
    const h = makeHarness()
    h.setFailMarkPending(true)
    h.failCreate(new Error('request timed out after remote commit'))

    await expect(h.manager('router').ensureKey(h.identity())).rejects.toThrow('request timed out')
    const input = h.getLastCreateInput()
    expect(input).not.toBeNull()
    expect([...h.remote.values()].find((key) => key.name === input!.name)?.revoked).toBe(true)
  })

  it('keeps failed revocations durable and retries them after backoff', async () => {
    const h = makeHarness()
    const manager = h.manager('router', { revocationRetryBaseMs: 1_000 })
    const first = await manager.ensureKey(h.identity())
    const remote = h.remote.get(first.usage.keyId)
    expect(remote).toBeDefined()
    remote!.expiresAt = new Date(START - 1).toISOString()
    h.failRevocationFor(first.usage.keyId)

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    const oldRow = [...h.rows.values()].find((row) => row.keyId === first.usage.keyId)
    expect(oldRow?.status).toBe('revocation_pending')
    expect(remote?.revoked).toBe(false)
    expect(await manager.retryPendingRevocations({ workspaceId: 'workspace-1', ownerUserId: 'owner-1' })).toBe(0)
    h.advance(1_000)
    expect(await manager.retryPendingRevocations({ workspaceId: 'workspace-1', ownerUserId: 'owner-1' })).toBe(1)
    expect(remote?.revoked).toBe(true)
    const replacement = await manager.ensureKey(h.identity())
    expect(replacement.usage.keyId).not.toBe(first.usage.keyId)
  })

  it('redacts credential values from durable revocation errors', async () => {
    const h = makeHarness()
    const manager = h.manager('router', { revocationRetryBaseMs: 1_000 })
    const first = await manager.ensureKey(h.identity())
    h.remote.get(first.usage.keyId)!.expiresAt = new Date(START - 1).toISOString()
    h.setRevocationFailure(new Error('Authorization: Bearer top-secret-token'))
    h.failRevocationFor(first.usage.keyId)

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    const row = [...h.rows.values()].find((candidate) => candidate.keyId === first.usage.keyId)
    expect(row?.lastRevocationError).toBe('Authorization: Bearer [redacted]')
    expect(row?.lastRevocationError).not.toContain('top-secret-token')
  })

  it('marks a missing remote key revoked and mints a replacement', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const first = await manager.ensureKey(h.identity())
    h.remote.delete(first.usage.keyId)

    expect(await manager.getUsage(h.identity())).toBeNull()
    expect([...h.rows.values()].find((row) => row.keyId === first.usage.keyId)?.status).toBe('revoked')
    expect((await manager.ensureKey(h.identity())).usage.keyId).not.toBe(first.usage.keyId)
  })

  it('uses the persisted budget when the remote API returns a nullable budget', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    const nullableProvisioner: DurableWorkspaceKeyProvisioner = {
      ...h.provisioner,
      async getKey() {
        return { budgetUsd: null, budgetSpent: 3, expiresAt: null }
      },
    }
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: h.store,
      provisioner: nullableProvisioner,
      crypto: {
        async encrypt(value) { return `encrypted:${value}` },
        async decrypt(value) { return value.slice('encrypted:'.length) },
      },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(START),
    })

    expect(await manager.getUsage(h.identity())).toMatchObject({
      keyId: first.usage.keyId,
      budgetUsd: 25,
      budgetSpent: 3,
      budgetRemaining: 22,
    })
  })

  it('allows each provider adapter to classify its missing-key error', async () => {
    const h = makeHarness()
    const first = await h.manager('router').ensureKey(h.identity())
    const providerMissing: DurableWorkspaceKeyProvisioner = {
      ...h.provisioner,
      async getKey() {
        throw Object.assign(new Error('child key is gone'), { code: 'platform_key_not_found' })
      },
    }
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: h.store,
      provisioner: providerMissing,
      crypto: {
        async encrypt(value) { return `encrypted:${value}` },
        async decrypt(value) { return value.slice('encrypted:'.length) },
      },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(START),
      isRemoteMissing: (error) => (error as { code?: string }).code === 'platform_key_not_found',
    })

    expect(await manager.getUsage(h.identity())).toBeNull()
    expect([...h.rows.values()].find((row) => row.keyId === first.usage.keyId)?.status).toBe('revoked')
  })

  it('does not revoke a current active key while cleaning a duplicate attempt', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const active = await manager.ensureKey(h.identity())
    const row = h.insertProvisioning({
      product: 'router',
      name: 'router:workspace-1:duplicate-attempt',
    })
    h.remote.set('duplicate-remote', {
      id: 'duplicate-remote',
      key: 'duplicate-secret',
      name: row.name ?? '',
      product: row.product,
      sourceKeyId: row.sourceKeyId,
      budgetUsd: 25,
      budgetSpent: 0,
      expiresAt: row.expiresAt.toISOString(),
      revoked: false,
    })

    expect((await manager.ensureKey(h.identity())).usage.keyId).toBe(active.usage.keyId)
    expect(h.remote.get(active.usage.keyId)?.revoked).toBe(false)
    expect(h.remote.get('duplicate-remote')?.revoked).toBe(true)
  })

  it('does not revoke an active key through a stale pending row', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const active = await manager.ensureKey(h.identity())
    const stale = h.insertProvisioning({
      keyId: active.usage.keyId,
      nextRevocationAt: new Date(START),
    })
    h.rows.set(stale.id, { ...stale, status: 'revocation_pending' })

    expect(await manager.retryPendingRevocations({ workspaceId: 'workspace-1', ownerUserId: 'owner-1' })).toBe(1)
    expect(h.rows.get(stale.id)?.status).toBe('revoked')
    expect(h.remote.get(active.usage.keyId)?.revoked).toBe(false)
  })

  it('proves the durable lease stays alive during a slow remote operation', async () => {
    const h = makeHarness()
    h.setCreateDelay(25)
    const manager = h.manager('router', { leaseMs: 30, leaseRenewIntervalMs: 5 })

    await manager.ensureKey(h.identity())
    expect(h.getRenewalCount()).toBeGreaterThan(0)
  })

  it('compensates a newly active remote key when the final lease renewal loses the lease', async () => {
    const h = makeHarness()
    h.setCreateDelay(5)
    h.setRenewalDelay(25)
    h.setFailRenewal(true)
    const manager = h.manager('router', { leaseMs: 100, leaseRenewIntervalMs: 1 })

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('lease was lost')
    expect(h.getRenewalCount()).toBeGreaterThan(0)
    expect([...h.rows.values()].some((row) => row.status === 'active')).toBe(false)
    expect([...h.remote.values()][0]?.revoked).toBe(true)
  })

  it('fences a paused creator when another worker retires its provisioning row', async () => {
    const h = makeHarness()
    h.setCreateDelay(20)
    const inFlight = h.manager('router').ensureKey(h.identity())
    await h.waitForCreateStart()
    const row = [...h.rows.values()].find((candidate) => candidate.status === 'provisioning')
    expect(row).toBeDefined()
    row!.status = 'revoked'

    await expect(inFlight).rejects.toThrow('retired before the remote id was recorded')
    expect([...h.rows.values()].some((candidate) => candidate.status === 'active')).toBe(false)
    expect([...h.remote.values()][0]?.revoked).toBe(true)
  })

  it.each(['record-remote', 'activate'] as const)('retains failed cleanup after a retired creator loses %s fencing', async stage => {
    const h = makeHarness()
    h.setCreateDelay(20)
    const manager = h.manager('router')
    const inFlight = manager.ensureKey(h.identity())
    await h.waitForCreateStart()
    const row = [...h.rows.values()].find(candidate => candidate.status === 'provisioning')!
    if (stage === 'record-remote') row.status = 'revoked'
    else h.store.conditionalWrites!.markActive = async () => { row.status = 'revoked'; return false }
    h.failRevocationFor('remote-1')
    await expect(inFlight).rejects.toThrow('retired before')
    expect(h.remote.get('remote-1')?.revoked).toBe(false)
    expect([...h.rows.values()].some(candidate => candidate.status === 'revocation_pending'
      && candidate.keyId === 'remote-1')).toBe(true)
    expect(row.status).toBe('revoked')
    const restarted = h.manager('router')
    await expect(restarted.ensureKey(h.identity())).rejects.toThrow('cleanup is pending')
    expect(h.getCreateInputs()).toHaveLength(1)
    h.advance(60_000)
    expect(await restarted.retryPendingRevocations()).toBe(1)
    expect(h.remote.get('remote-1')?.revoked).toBe(true)
  })

  it('reports a failed compensation write when both durable storage and revocation are unavailable', async () => {
    const h = makeHarness()
    h.setCreateDelay(20)
    const inFlight = h.manager('router').ensureKey(h.identity())
    await h.waitForCreateStart()
    const row = [...h.rows.values()].find(candidate => candidate.status === 'provisioning')!
    row.status = 'revoked'
    h.store.insertProvisioning = async () => { throw new Error('storage unavailable') }
    h.failRevocationFor('remote-1')
    await expect(inFlight).rejects.toThrow('cleanup record could not be persisted')
    expect(h.remote.get('remote-1')?.revoked).toBe(false)
    expect([...h.rows.values()].some(candidate => candidate.status === 'revocation_pending')).toBe(false)
  })

  it('fails before remote spend when encryption is unavailable', async () => {
    const h = makeHarness()
    let creates = 0
    const provisioner: DurableWorkspaceKeyProvisioner = {
      ...h.provisioner,
      async createKey(input) {
        creates += 1
        return h.provisioner.createKey(input)
      },
    }
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: h.store,
      provisioner,
      crypto: {
        async encrypt() { throw new Error('encryption unavailable') },
        async decrypt(value) { return value },
      },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(START),
    })

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('misconfigured')
    expect(creates).toBe(0)
    expect(h.remote.size).toBe(0)
  })

  it('revokes a remote key when local encryption fails after the remote create', async () => {
    const h = makeHarness()
    let probe = true
    const manager = createIdentityBoundWorkspaceKeyManager({
      store: h.store,
      provisioner: h.provisioner,
      crypto: {
        async encrypt(secret) {
          if (probe) {
            probe = false
            return `encrypted:${secret}`
          }
          throw new Error('local encryption failed')
        },
        async decrypt(value) { return value.slice('encrypted:'.length) },
      },
      product: 'router',
      defaultBudgetUsd: 25,
      now: () => new Date(START),
    })

    await expect(manager.ensureKey(h.identity())).rejects.toThrow('local encryption failed')
    expect([...h.remote.values()][0]?.revoked).toBe(true)
    expect([...h.rows.values()][0]?.status).toBe('revoked')
  })
})
