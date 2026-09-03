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

type RemoteKey = {
  id: string
  key: string
  name: string
  product: string
  sourceKeyId: string | null
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

function makeHarness() {
  const rows = new Map<string, DurableWorkspaceKeyRecord>()
  const remote = new Map<string, RemoteKey>()
  const leases = new Map<string, { operationId: string; expiresAt: number }>()
  let nowMs = START
  let rowNumber = 0
  let keyNumber = 0
  let currentSourceKeyId: string | null = 'source-1'
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

  const provisioner: DurableWorkspaceKeyProvisioner = {
    async createKey(input) {
      createInputs.push(input)
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
        budgetUsd: input.budgetUsd,
        budgetSpent: 0,
        expiresAt: input.expiresAt,
        revoked: false,
      })
      const failure = createFailure
      createFailure = null
      returnMissingId = false
      if (failure) throw failure
      return { id, key, budgetUsd: input.budgetUsd, expiresAt: input.expiresAt }
    },
    async getKey(id) {
      const key = remote.get(id)
      if (!key || key.revoked) throw missingRemoteKey()
      return { budgetUsd: key.budgetUsd, budgetSpent: key.budgetSpent, expiresAt: key.expiresAt }
    },
    async revokeKey(id) {
      if (id === failNextRevocationFor) {
        failNextRevocationFor = null
        throw revocationFailure
      }
      const key = remote.get(id)
      if (!key || key.revoked) throw missingRemoteKey()
      key.revoked = true
    },
    async findCreatedKeys(input) {
      return [...remote.values()]
        .filter((key) => !key.revoked && key.name === input.name && key.product === input.product)
        .filter((key) => input.sourceKeyId === undefined || input.sourceKeyId === null || key.sourceKeyId === input.sourceKeyId)
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
      platformUserId: 'platform-1',
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

describe('createIdentityBoundWorkspaceKeyManager', () => {
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
    const secondManager = h.manager('router', { leaseMs: 100, leaseWaitMs: 100, leasePollMs: 1 })

    const [first, second] = await Promise.all([
      firstManager.ensureKey(h.identity()),
      secondManager.ensureKey(h.identity()),
    ])

    expect(first.usage.keyId).toBe(second.usage.keyId)
    expect([...h.remote.values()]).toHaveLength(1)
  })

  it('refuses to reuse a row after source id or fingerprint changes', async () => {
    const h = makeHarness()
    const manager = h.manager('router')
    const firstIdentity = h.identity()
    const first = await manager.ensureKey(firstIdentity)

    h.setCurrentSourceKeyId('source-2')
    const changed = await manager.ensureKey(h.identity({ sourceKeyFingerprint: firstIdentity.sourceKeyFingerprint }))
    expect(changed.usage.keyId).not.toBe(first.usage.keyId)
    expect([...h.rows.values()].find((row) => row.keyId === first.usage.keyId)?.status).toBe('revoked')

    const fingerprintChanged = await manager.ensureKey(h.identity({ sourceKeyId: 'source-2', sourceKeyFingerprint: 'rotated-again' }))
    expect(fingerprintChanged.usage.keyId).not.toBe(changed.usage.keyId)
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

  it('recovers a legacy empty row when the probe returns no remote id', async () => {
    const h = makeHarness()
    const row = h.insertProvisioning({ idempotencyKey: null })
    h.setReturnMissingId(true)

    const result = await h.manager('router').ensureKey(h.identity())
    const inputs = h.getCreateInputs()

    expect(inputs[0]).toMatchObject({
      name: row.name,
      idempotencyKey: `workspace-key:${row.id}`,
    })
    expect(h.remote.get('orphan-1')?.revoked).toBe(true)
    expect(h.rows.get(row.id)?.status).toBe('revoked')
    expect(result.usage.keyId).toBe('remote-2')
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
