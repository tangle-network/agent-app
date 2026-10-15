import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxySecretBinding } from '@tangle-network/agent-interface'
import type { SandboxInstance } from '@tangle-network/sandbox'

const { list, create, get, capabilities } = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), get: vi.fn(), capabilities: vi.fn() }))
vi.mock('@tangle-network/sandbox/core', () => ({ Sandbox: class {
  list = list
  create = create
  get = get
  capabilities = capabilities
} }))

import {
  ensureWorkspaceSandbox,
  resetClientCache,
  streamSandboxPrompt,
  driveSandboxTurn,
  resolveSandboxPromptBackend,
  type SandboxRuntimeConfig,
  type StreamSandboxPromptOptions,
} from './index'

const binding: ProxySecretBinding = {
  envName: 'APP_TOKEN',
  secretRef: { kind: 'secret-ref', key: 'app-capability' },
  hosts: ['tools.example.com'],
  presentation: { type: 'bearer' },
}
const scope = { workspaceId: 'workspace', userId: 'user', harness: 'opencode' as const }

function shell(overrides: Partial<SandboxRuntimeConfig> = {}): SandboxRuntimeConfig {
  return {
    credentials: () => ({ apiKey: 'test-sdk-key', baseUrl: 'https://sandbox.example.com' }),
    name: () => 'box-workspace', metadata: () => ({ harness: 'opencode' }),
    connectedIntegrationIds: async () => [], env: async () => ({}), files: async () => [],
    secrets: async () => [], profile: () => ({ name: 'test-profile' }),
    proxySecrets: async () => [binding],
    ...overrides,
  }
}
function box() {
  return {
    id: 'sandbox-test', name: 'box-workspace', status: 'running',
    metadata: { harness: 'opencode' }, filesystemIncarnationReadiness: 'ready',
    connection: { runtimeUrl: 'https://runtime.example.com', authToken: 'test-runtime-token',
      authTokenExpiresAt: '2999-01-01T00:00:00.000Z' },
    refresh: vi.fn(), waitFor: vi.fn(), exec: vi.fn().mockResolvedValue({ exitCode: 0 }),
    setRuntimeEnv: vi.fn(), resume: vi.fn(), stop: vi.fn(), delete: vi.fn(),
    streamPrompt: vi.fn(), driveTurn: vi.fn(),
    egress: { get: vi.fn().mockRejectedValue(new Error('proxy secret support unavailable')), update: vi.fn() },
  }
}

beforeEach(() => {
  resetClientCache(); list.mockReset(); create.mockReset(); get.mockReset()
  capabilities.mockReset().mockResolvedValue({ proxySecrets: {
    protocolVersion: 1, presentations: ['bearer'], placeholderFormats: ['opaque'],
    enforcement: 'exact', transports: ['https:443'], lifecycle: true,
    supportedDrivers: ['docker'], placementReceiptRequired: true,
  } })
})

function placedReceipt(generation: number, bindings = [binding]) {
  return {
    protocolVersion: 1, sandboxId: 'sandbox-test', generation,
    status: bindings.length ? 'installed' : 'revoked',
    proxyAcknowledged: true, materializationAcknowledged: true,
    bindings: bindings.map((entry) => ({ envName: entry.envName, secretRef: entry.secretRef, grant: {
      protocolVersion: 1, grantId: `grant-${entry.envName}`, sandboxId: 'sandbox-test', epoch: 'epoch-test',
      identity: { tenantId: 'tenant', issuerId: 'issuer', secretId: 'secret', revision: '1' },
      scope: { hosts: entry.hosts, methods: entry.methods, paths: entry.paths },
      presentation: entry.presentation, placeholderFormat: 'opaque',
      issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z',
    } })),
  }
}
function withPlacement(retained: ReturnType<typeof box>) {
  let receipt = placedReceipt(0)
  retained.egress.get.mockReset().mockImplementation(async () => ({ proxySecretReceipt: receipt }))
  retained.egress.update.mockImplementation(async ({ proxySecrets }) => {
    receipt = placedReceipt(receipt.generation + 1, proxySecrets)
    return { proxySecretReceipt: receipt }
  })
  return retained
}

describe('proxy custody at sandbox dispatch boundaries', () => {
  it('requires advertised custody support before allocating a box', async () => {
    capabilities.mockResolvedValue({})
    list.mockResolvedValue([])
    const issuer = vi.fn(async () => [binding])
    await expect(ensureWorkspaceSandbox(shell({ proxySecrets: issuer }), scope)).rejects.toThrow('proxy')
    expect(issuer).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('forwards references at create and confirms proxy plus file custody before bootstrap', async () => {
    const retained = withPlacement(box())
    list.mockResolvedValue([])
    create.mockResolvedValue(retained)
    const bootstrap = vi.fn(async () => {
      expect(retained.egress.update).toHaveBeenCalled()
      return { succeeded: true as const, value: undefined }
    })
    await ensureWorkspaceSandbox(shell({ bootstrap }), scope)
    expect(create.mock.calls[0]![0]).toMatchObject({ proxySecrets: [binding], secrets: [], env: {} })
    expect(bootstrap).toHaveBeenCalledOnce()
  })

  it('renews a retained box before bootstrap and preserves unrelated runtime env', async () => {
    const retained = withPlacement(box())
    list.mockResolvedValue([retained])
    const bootstrap = vi.fn(async () => {
      expect(retained.egress.update).toHaveBeenCalled()
      return { succeeded: true as const, value: undefined }
    })
    await ensureWorkspaceSandbox(shell({ bootstrap, runtimeEnv: async () => ({ PUBLIC_SETTING: 'enabled' }) }), scope)
    expect(retained.setRuntimeEnv).toHaveBeenCalledWith({ PUBLIC_SETTING: 'enabled' })
    expect(retained.egress.update.mock.calls[0]![0]).toEqual({
      proxySecrets: [binding], expectedProxySecretGeneration: 0, requireInPlace: true,
    })
    expect(bootstrap).toHaveBeenCalledOnce()
  })

  it('explicit [] revokes before resuming a stopped box', async () => {
    const retained = withPlacement(box())
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([retained])
    retained.resume.mockImplementation(async () => {
      expect(retained.egress.update.mock.calls[0]![0]).toMatchObject({ proxySecrets: [] })
    })
    await ensureWorkspaceSandbox(shell({ proxySecrets: async () => [] }), scope)
    expect(retained.resume).toHaveBeenCalledOnce()
    expect(retained.egress.update.mock.calls[0]![0]).toEqual({
      proxySecrets: [], expectedProxySecretGeneration: 0, requireInPlace: true,
    })
  })

  it.each(['proxy-only', 'wrong-box', 'wrong-reference', 'wrong-format', 'expired', 'generation-race'] as const)('rejects an unconfirmed %s placement before bootstrap', async (failure) => {
    const retained = withPlacement(box())
    const receipt = placedReceipt(1)
    if (failure === 'proxy-only') { receipt.status = 'proxy-installed'; receipt.materializationAcknowledged = false }
    if (failure === 'wrong-box') receipt.sandboxId = 'other-sandbox'
    if (failure === 'wrong-reference') receipt.bindings[0]!.secretRef = { kind: 'secret-ref', key: 'different-secret' }
    if (failure === 'wrong-format') receipt.bindings[0]!.grant.placeholderFormat = 'jwt'
    if (failure === 'expired') receipt.bindings[0]!.grant.expiresAt = '2000-01-01T00:00:00.000Z'
    retained.egress.update.mockResolvedValue({ proxySecretReceipt: receipt })
    if (failure === 'generation-race') retained.egress.get.mockResolvedValueOnce({ proxySecretReceipt: placedReceipt(0) })
      .mockResolvedValue({ proxySecretReceipt: placedReceipt(2) })
    list.mockResolvedValue([retained])
    const bootstrap = vi.fn()
    await expect(ensureWorkspaceSandbox(shell({ bootstrap }), scope)).rejects.toThrow('proxy')
    expect(bootstrap).not.toHaveBeenCalled()
    expect(retained.streamPrompt).not.toHaveBeenCalled()
  })



  it('does not restore authored bindings when the complete callback selection revokes them', async () => {
    list.mockResolvedValue([])
    await expect(ensureWorkspaceSandbox(shell({
      proxySecrets: async () => [], profile: () => ({ name: 'declared', proxySecrets: [binding] }),
    }), scope)).rejects.toThrow('proxy')
    expect(create).not.toHaveBeenCalled()
  })

  it('requires confirmed revocation for an explicit empty turn profile selection', async () => {
    const retained = withPlacement(box())
    await expect(resolveSandboxPromptBackend(shell(), {
      profile: { name: 'explicit-empty', proxySecrets: [] },
    }, 'test', retained as unknown as SandboxInstance)).rejects.toThrow('proxy')
    expect(retained.egress.update).not.toHaveBeenCalled()
  })

  it('reconciles profile-only declarations before creation', async () => {
    const retained = withPlacement(box())
    list.mockResolvedValue([])
    create.mockResolvedValue(retained)
    await ensureWorkspaceSandbox(shell({ proxySecrets: undefined, profile: () => ({ name: 'profile-only', proxySecrets: [binding] }) }), scope)
    expect(create.mock.calls[0]![0].proxySecrets).toEqual([binding])
  })

  it('renews before recovery resume and again before the recovered bootstrap', async () => {
    const retained = withPlacement(box())
    retained.exec.mockResolvedValueOnce({ exitCode: 1 }).mockResolvedValue({ exitCode: 0 })
    retained.resume.mockImplementation(async () => {
      expect(retained.egress.update).toHaveBeenCalledOnce()
    })
    list.mockResolvedValue([retained])
    const bootstrap = vi.fn(async () => {
      expect(retained.egress.update).toHaveBeenCalledTimes(2)
      return { succeeded: true as const, value: undefined }
    })
    await ensureWorkspaceSandbox(shell({ livenessProbe: {}, bootstrap }), scope)
    expect(retained.resume).toHaveBeenCalledOnce()
    expect(bootstrap).toHaveBeenCalledOnce()
    expect(retained.delete).not.toHaveBeenCalled()
  })

  it('verifies a profile subset without replacing the complete workspace set', async () => {
    const retained = withPlacement(box())
    await resolveSandboxPromptBackend(shell(), { profile: { name: 'subset', proxySecrets: [binding] } }, 'test', retained as unknown as SandboxInstance)
    expect(retained.egress.update).not.toHaveBeenCalled()
  })

  it('refuses new profile authority instead of replacing installed workspace bindings', async () => {
    const retained = withPlacement(box())
    await expect(resolveSandboxPromptBackend(shell(), {
      profile: { name: 'different', proxySecrets: [{ ...binding, secretRef: { kind: 'secret-ref', key: 'foreign-secret' } }] },
    }, 'test', retained as unknown as SandboxInstance)).rejects.toThrow('proxy')
    expect(retained.egress.update).not.toHaveBeenCalled()
  })

  it('refuses installed proxy names in raw turn secrets even when the turn profile omits declarations', async () => {
    const retained = withPlacement(box())
    await expect(resolveSandboxPromptBackend(shell(), {
      profile: { name: 'no-declaration' }, runtimeSecrets: { APP_TOKEN: 'must-not-cross-boundary' },
    }, 'test', retained as unknown as SandboxInstance)).rejects.toThrow('proxy')
    expect(retained.egress.update).not.toHaveBeenCalled()
  })

  it('refuses noncanonical nested proxy custody before POST', async () => {
    list.mockResolvedValue([])
    await expect(ensureWorkspaceSandbox(shell({ profile: () => ({
      name: 'nested', subagents: { child: { proxySecrets: [binding] } as never },
    }) }), scope)).rejects.toThrow('proxy')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses a create before POST when the declaration issuer refuses', async () => {
    list.mockResolvedValue([])
    await expect(ensureWorkspaceSandbox(shell({ proxySecrets: async () => { throw new Error('issuer refused') } }), scope))
      .rejects.toThrow('proxy')
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['APP_TOKEN', 'app-capability'])('refuses readable env aliases %s before POST', async (name) => {
    list.mockResolvedValue([])
    await expect(ensureWorkspaceSandbox(shell({ env: async () => ({ [name]: 'must-not-cross-boundary' }) }), scope))
      .rejects.toThrow('proxy')
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['APP_TOKEN', 'app-capability'])('refuses readable secret selection %s before POST', async (name) => {
    list.mockResolvedValue([])
    await expect(ensureWorkspaceSandbox(shell({ secrets: async () => [name] }), scope))
      .rejects.toThrow('proxy')
    expect(create).not.toHaveBeenCalled()
  })

  it('awaits declarations before sending a retained runtime environment', async () => {
    const retained = withPlacement(box())
    list.mockResolvedValue([retained])
    const bootstrap = vi.fn()
    await expect(ensureWorkspaceSandbox(shell({
      runtimeEnv: async () => ({ APP_TOKEN: 'must-not-cross-boundary' }), bootstrap,
    }), scope)).rejects.toThrow('proxy')
    expect(retained.setRuntimeEnv).not.toHaveBeenCalled()
    expect(retained.resume).not.toHaveBeenCalled()
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('refuses an unsupported stopped peer before resume or bootstrap', async () => {
    const retained = box()
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([retained])
    const bootstrap = vi.fn()
    await expect(ensureWorkspaceSandbox(shell({ bootstrap }), scope)).rejects.toThrow('proxy')
    expect(retained.resume).not.toHaveBeenCalled()
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('does not classify a proxy issuer 404 as permission to replace a box', async () => {
    const retained = box()
    list.mockResolvedValue([retained])
    const recoverMissingSandbox = vi.fn()
    const recoverStoppedSandbox = vi.fn()
    await expect(ensureWorkspaceSandbox(shell({
      proxySecrets: async () => { throw Object.assign(new Error('issuer refused'), { status: 404 }) },
      recoverMissingSandbox, recoverStoppedSandbox, replaceUnbringableBox: true,
    }), scope)).rejects.toThrow('proxy')
    expect(recoverMissingSandbox).not.toHaveBeenCalled()
    expect(recoverStoppedSandbox).not.toHaveBeenCalled()
    expect(retained.delete).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['stream', 'drive'] as const)('a failed per-turn install blocks %s transport', async (transport) => {
    const retained = box()
    const options: StreamSandboxPromptOptions = {
      profile: { name: 'test-profile' },
      proxySecrets: {
        scope: { workspaceId: 'workspace', userId: 'user', threadId: 'thread', executionId: 'execution' },
        resolve: async () => [binding],
      },
    }
    const operation = transport === 'stream'
      ? (async () => { for await (const _ of streamSandboxPrompt(shell(), retained as unknown as SandboxInstance, 'test', options)) { /* consume */ } })()
      : driveSandboxTurn(shell(), retained as unknown as SandboxInstance, 'test', { ...options, sessionId: 'session' })
    await expect(operation).rejects.toThrow('proxy')
    expect(retained.streamPrompt).not.toHaveBeenCalled()
    expect(retained.driveTurn).not.toHaveBeenCalled()
  })

  it('refuses per-turn resolution without an actual box', async () => {
    await expect(resolveSandboxPromptBackend(shell(), {
      proxySecrets: {
        scope: { workspaceId: 'workspace', userId: 'user', threadId: 'thread', executionId: 'execution' },
        resolve: async () => [binding],
      },
    })).rejects.toThrow('proxy')
  })
})
