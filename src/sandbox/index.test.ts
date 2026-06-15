import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
const listMock = vi.fn()
const sandboxCtor = vi.fn()

vi.mock('@tangle-network/sandbox', () => ({
  Sandbox: class {
    list = listMock
    create = createMock
    secrets = {
      create: vi.fn(),
      update: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    }
    constructor(opts: { apiKey: string; baseUrl: string }) {
      sandboxCtor(opts)
    }
  },
  mergeAgentProfiles: (base: unknown, overlay: unknown) => ({
    ...(base as Record<string, unknown>),
    ...(overlay as Record<string, unknown>),
  }),
}))

import {
  getClient,
  resetClientCache,
  ensureWorkspaceSandbox,
  buildAppToolMcpServers,
  streamSandboxPrompt,
  resolveModel,
  flattenHistory,
  mergeExtraMcp,
  attachReasoningEffort,
  syncSandboxMemberAdd,
  storeSecret,
  readSecret,
  deleteSecret,
  mintSandboxScopedToken,
  type SandboxRuntimeConfig,
  type SecretStore,
} from './index'
import type { AgentProfile, AgentProfileMcpServer, SandboxInstance } from '@tangle-network/sandbox'

const PROFILE: AgentProfile = { name: 'test' } as AgentProfile

function shellFor(
  creds: { apiKey: string; baseUrl: string } | null,
  over: Partial<SandboxRuntimeConfig> = {},
): SandboxRuntimeConfig {
  return {
    credentials: () => creds,
    name: (id) => `box-${id.slice(0, 16)}`,
    metadata: (harness) => ({ harness }),
    connectedIntegrationIds: async () => [],
    env: async () => ({ WORKSPACE_ID: 'w1' }),
    files: async () => [],
    secrets: async () => ['SECRET_A'],
    profile: () => PROFILE,
    permissionRole: () => 'developer',
    ...over,
  }
}

function fakeBox(over: Partial<SandboxInstance> = {}): SandboxInstance {
  return {
    name: 'box-w1',
    metadata: { harness: 'opencode' },
    connection: { runtimeUrl: 'https://rt' },
    waitFor: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    streamPrompt: vi.fn(),
    permissions: {
      add: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    ...over,
  } as unknown as SandboxInstance
}

beforeEach(() => {
  resetClientCache()
  createMock.mockReset()
  listMock.mockReset()
  sandboxCtor.mockReset()
})

describe('getClient credential-fingerprint cache', () => {
  it('reuses one client for the same apiKey+baseUrl', () => {
    const shell = shellFor({ apiKey: 'k1', baseUrl: 'https://s' })
    const a = getClient(shell)
    const b = getClient(shell)
    expect(a).toBe(b)
    expect(sandboxCtor).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the client when the apiKey changes (no stale singleton)', () => {
    getClient(shellFor({ apiKey: 'k1', baseUrl: 'https://s' }))
    getClient(shellFor({ apiKey: 'k2', baseUrl: 'https://s' }))
    expect(sandboxCtor).toHaveBeenCalledTimes(2)
    expect(sandboxCtor).toHaveBeenLastCalledWith({ apiKey: 'k2', baseUrl: 'https://s' })
  })

  it('throws fail-loud when no credentials are available', () => {
    expect(() => getClient(shellFor(null))).toThrow(/credentials are required/)
  })
})

describe('ensureWorkspaceSandbox lifecycle', () => {
  const shell = () => shellFor({ apiKey: 'k', baseUrl: 'https://s' })

  it('reuses a running box whose metadata harness matches', async () => {
    const running = fakeBox({ name: 'box-w1', metadata: { harness: 'opencode' } })
    listMock.mockResolvedValue([running])
    const box = await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })
    expect(box).toBe(running)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('deletes and recreates on harness mismatch', async () => {
    const stale = fakeBox({ name: 'box-w1', metadata: { harness: 'claude-code' } })
    listMock.mockResolvedValue([stale])
    createMock.mockResolvedValue(fakeBox())
    await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })
    expect(stale.delete).toHaveBeenCalledTimes(1)
    expect(createMock).toHaveBeenCalledTimes(1)
    const payload = createMock.mock.calls[0]![0]
    expect(payload.backend.type).toBe('opencode')
    expect(payload.metadata).toEqual({ harness: 'opencode' })
    expect(payload.secrets).toEqual(['SECRET_A'])
  })

  it('surfaces a typed error when a mismatched box cannot be deleted (no silent swallow)', async () => {
    const stale = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'claude-code' },
      delete: vi.fn().mockRejectedValue(new Error('boom')),
    })
    listMock.mockResolvedValue([stale])
    await expect(
      ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' }),
    ).rejects.toThrow(/could not be deleted/)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('creates fresh when list fails (list error does not abort provisioning)', async () => {
    listMock.mockRejectedValue(new Error('list down'))
    createMock.mockResolvedValue(fakeBox())
    await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes when the created box has no runtimeUrl', async () => {
    listMock.mockResolvedValue([])
    const created = fakeBox({ connection: undefined })
    createMock.mockResolvedValue(created)
    await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })
    expect(created.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('buildAppToolMcpServers', () => {
  it('keys one server per descriptor over the framework single-server builder', () => {
    const entries = buildAppToolMcpServers({
      tools: [
        { tool: 'submit_proposal', key: 'app-propose', description: 'd1' },
        { tool: 'add_citation', key: 'app-cite', description: 'd2' },
      ],
      baseUrl: 'https://app',
      token: 'tok',
      ctx: { userId: 'w1', workspaceId: 'w1', threadId: null },
    })
    expect(Object.keys(entries).sort()).toEqual(['app-cite', 'app-propose'])
    expect(entries['app-propose']!.transport).toBe('http')
    expect(entries['app-propose']!.url).toContain('https://app')
  })
})

describe('streamSandboxPrompt seam', () => {
  const shell = () =>
    shellFor(
      { apiKey: 'k', baseUrl: 'https://s' },
      {
        provider: {
          apiKey: 'router-key',
          providerName: 'openai-compat',
          defaultModel: 'gpt-x',
          routerBaseUrl: 'https://router',
        },
        profile: () => PROFILE,
      },
    )

  it('flattens history, resolves the model, attaches effort, and forwards to box.streamPrompt', async () => {
    async function* events() {
      yield { type: 'message.part.updated' }
    }
    const box = fakeBox({ streamPrompt: vi.fn().mockReturnValue(events()) })

    const out: unknown[] = []
    for await (const e of streamSandboxPrompt(shell(), box, 'hello', {
      harness: 'opencode',
      effort: 'high',
      history: [{ role: 'assistant', content: 'prior' }],
    })) {
      out.push(e)
    }

    expect(out).toHaveLength(1)
    const [prompt, opts] = (box.streamPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(prompt).toBe('Assistant: prior\n\nUser: hello')
    expect(opts.backend.type).toBe('opencode')
    expect(opts.backend.model).toEqual({
      model: 'gpt-x',
      provider: 'openai-compat',
      apiKey: 'router-key',
      baseUrl: 'https://router',
    })
    expect(opts.backend.profile.extensions.opencode.reasoningEffort).toBe('high')
  })

  it('omits the model when provider resolution yields nothing', async () => {
    async function* events() {
      yield { type: 'result' }
    }
    const box = fakeBox({ streamPrompt: vi.fn().mockReturnValue(events()) })
    const bare = shellFor({ apiKey: 'k', baseUrl: 'https://s' })
    for await (const _ of streamSandboxPrompt(bare, box, 'hi')) void _
    const [, opts] = (box.streamPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(opts.backend.model).toBeUndefined()
  })
})

describe('pure seam helpers', () => {
  it('flattenHistory returns the bare message when no history', () => {
    expect(flattenHistory('x')).toBe('x')
  })

  it('mergeExtraMcp throws on a collision with app-tool or base profile servers', () => {
    const appTool: Record<string, AgentProfileMcpServer> = {
      'app-propose': {} as AgentProfileMcpServer,
    }
    expect(() =>
      mergeExtraMcp(appTool, {}, { 'app-propose': {} as AgentProfileMcpServer }),
    ).toThrow(/collides/)
    expect(() =>
      mergeExtraMcp({}, { base: {} as AgentProfileMcpServer }, { base: {} as AgentProfileMcpServer }),
    ).toThrow(/collides/)
  })

  it('mergeExtraMcp merges disjoint keys', () => {
    const merged = mergeExtraMcp(
      { a: {} as AgentProfileMcpServer },
      {},
      { b: {} as AgentProfileMcpServer },
    )
    expect(Object.keys(merged).sort()).toEqual(['a', 'b'])
  })

  it('attachReasoningEffort is a no-op for auto/undefined', () => {
    expect(attachReasoningEffort(PROFILE, 'opencode', 'auto')).toBe(PROFILE)
    expect(attachReasoningEffort(PROFILE, 'opencode', undefined)).toBe(PROFILE)
  })

  it('resolveModel precedence: explicit override beats env defaults', () => {
    const m = resolveModel(
      { apiKey: 'env-key', defaultModel: 'env-model', providerName: 'openai-compat' },
      { model: 'override-model', modelApiKey: 'override-key' },
    )
    expect(m).toEqual({ model: 'override-model', provider: 'openai-compat', apiKey: 'override-key' })
  })

  it('resolveModel returns undefined when no provider/model/key resolves', () => {
    expect(resolveModel({})).toBeUndefined()
  })
})

describe('member sync typed outcomes', () => {
  it('returns succeeded:true on add', async () => {
    const box = fakeBox()
    const seam = { roleToSandboxRole: () => 'developer' as const }
    const r = await syncSandboxMemberAdd(box, seam, 'u1', 'editor')
    expect(r.succeeded).toBe(true)
    expect(box.permissions.add).toHaveBeenCalledWith({ userId: 'u1', role: 'developer' })
  })

  it('returns succeeded:false with the error when the SDK throws (no swallow)', async () => {
    const box = fakeBox({
      permissions: {
        add: vi.fn().mockRejectedValue(new Error('perm down')),
        update: vi.fn(),
        remove: vi.fn(),
      } as unknown as SandboxInstance['permissions'],
    })
    const seam = { roleToSandboxRole: () => 'developer' as const }
    const r = await syncSandboxMemberAdd(box, seam, 'u1', 'editor')
    expect(r.succeeded).toBe(false)
    if (!r.succeeded) expect(r.error.message).toBe('perm down')
  })
})

describe('secret CRUD typed outcomes', () => {
  function store(over: Partial<SecretStore> = {}): SecretStore {
    return {
      create: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue('v'),
      delete: vi.fn().mockResolvedValue(undefined),
      ...over,
    }
  }

  it('storeSecret falls back to update on create conflict', async () => {
    const s = store({ create: vi.fn().mockRejectedValue(new Error('exists')) })
    const r = await storeSecret(s, 'N', 'v')
    expect(r.succeeded).toBe(true)
    expect(s.update).toHaveBeenCalledWith('N', 'v')
  })

  it('storeSecret returns a typed failure when both create and update fail', async () => {
    const s = store({
      create: vi.fn().mockRejectedValue(new Error('c')),
      update: vi.fn().mockRejectedValue(new Error('u')),
    })
    const r = await storeSecret(s, 'N', 'v')
    expect(r.succeeded).toBe(false)
    if (!r.succeeded) expect(r.error.message).toContain('Failed to store sandbox secret N')
  })

  it('readSecret returns the value', async () => {
    const r = await readSecret(store(), 'N')
    expect(r.succeeded && r.value).toBe('v')
  })

  it('deleteSecret returns a typed failure rather than swallowing', async () => {
    const s = store({ delete: vi.fn().mockRejectedValue(new Error('nope')) })
    const r = await deleteSecret(s, 'N')
    expect(r.succeeded).toBe(false)
  })
})

describe('mintSandboxScopedToken', () => {
  it('delegates to box.mintScopedToken and returns a typed token outcome', async () => {
    const expiresAt = new Date(1_700_000_000_000)
    const box = {
      mintScopedToken: vi.fn().mockResolvedValue({ token: 't', expiresAt, scope: 'project' }),
    } as unknown as SandboxInstance
    const r = await mintSandboxScopedToken(box, { scope: 'project', ttlMinutes: 10 })
    expect(r.succeeded).toBe(true)
    if (r.succeeded) {
      expect(r.value.token).toBe('t')
      expect(r.value.scope).toBe('project')
      expect(r.value.expiresAt).toBe(expiresAt)
    }
    expect((box.mintScopedToken as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({
      scope: 'project',
      ttlMinutes: 10,
    })
  })

  it('returns a typed failure when the SDK call throws', async () => {
    const box = {
      mintScopedToken: vi.fn().mockRejectedValue(new Error('forbidden (403)')),
    } as unknown as SandboxInstance
    const r = await mintSandboxScopedToken(box, { scope: 'session' })
    expect(r.succeeded).toBe(false)
    if (!r.succeeded) expect(r.error.message).toContain('403')
  })
})