import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxySecretBinding } from '@tangle-network/agent-interface'
import type { SandboxInstance } from '@tangle-network/sandbox'

const { list, create, get } = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), get: vi.fn() }))
vi.mock('@tangle-network/sandbox/core', () => ({ Sandbox: class {
  list = list
  create = create
  get = get
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

beforeEach(() => { resetClientCache(); list.mockReset(); create.mockReset(); get.mockReset() })

describe('proxy custody at sandbox dispatch boundaries', () => {
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
    const retained = box()
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
