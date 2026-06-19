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
  mintTerminalProxyToken,
  verifyTerminalProxyToken,
  resolveSandboxClientCredentials,
  classifySeveredStream,
  detectInteractiveQuestion,
  isTerminalPromptEvent,
  driveSandboxTurn,
  sandboxToolBinDir,
  sandboxToolPath,
  buildSandboxToolFileMounts,
  buildSandboxToolPathSetupScript,
  runSandboxToolPathSetup,
  splitDeferredProfileFiles,
  writeProfileFilesToBox,
  type SandboxRuntimeConfig,
  type SecretStore,
} from './index'
import { resolveTangleExecutionEnvironment } from '../runtime/model'
import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileMcpServer,
  SandboxInstance,
} from '@tangle-network/sandbox'

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

describe('resolveSandboxClientCredentials', () => {
  it('classifies local/test envs as direct-env capable and unknown envs as production-safe', () => {
    expect(resolveTangleExecutionEnvironment({ APP_ENV: 'local' })).toBe('development')
    expect(resolveTangleExecutionEnvironment({ NODE_ENV: 'test' })).toBe('test')
    expect(resolveTangleExecutionEnvironment({ APP_ENV: 'preview' })).toBe('production')
    expect(resolveTangleExecutionEnvironment({})).toBe('production')
  })

  it('uses direct env credentials in local development without calling provision', async () => {
    const provision = vi.fn()
    await expect(resolveSandboxClientCredentials({
      env: {
        APP_ENV: 'development',
        TANGLE_API_KEY: 'sk-tan-local',
        SANDBOX_API_URL: 'https://sandbox.example.com/v1',
      },
      provision,
    })).resolves.toEqual({
      apiKey: 'sk-tan-local',
      baseUrl: 'https://sandbox.example.com',
    })
    expect(provision).not.toHaveBeenCalled()
  })

  it('prefers the provision callback in production even when a direct env key exists', async () => {
    const provision = vi.fn(async () => ({
      apiKey: 'sk-sandbox-provisioned',
      baseUrl: 'https://sandbox.tangle.tools/v1',
    }))
    await expect(resolveSandboxClientCredentials({
      env: {
        APP_ENV: 'production',
        TANGLE_API_KEY: 'sk-tan-env',
        SANDBOX_API_URL: 'https://sandbox.example.com',
      },
      provision,
    })).resolves.toEqual({
      apiKey: 'sk-sandbox-provisioned',
      baseUrl: 'https://sandbox.tangle.tools',
    })
    expect(provision).toHaveBeenCalledTimes(1)
  })

  it('can explicitly allow direct env credentials outside local/test', async () => {
    await expect(resolveSandboxClientCredentials({
      env: {
        APP_ENV: 'staging',
        SANDBOX_API_KEY: 'sk-sandbox-staging',
      },
      defaultBaseUrl: 'https://sandbox.tangle.tools',
      allowDirectEnvCredentials: true,
    })).resolves.toEqual({
      apiKey: 'sk-sandbox-staging',
      baseUrl: 'https://sandbox.tangle.tools',
    })
  })

  it('throws a clear error when the direct key exists but no sandbox base URL resolves', async () => {
    await expect(resolveSandboxClientCredentials({
      env: {
        APP_ENV: 'development',
        TANGLE_API_KEY: 'sk-tan-local',
      },
    })).rejects.toThrow(/Sandbox base URL is required/)
  })

  it('throws a clear error when neither provisioning nor direct env credentials resolve', async () => {
    await expect(resolveSandboxClientCredentials({
      env: { APP_ENV: 'development' },
      provision: async () => null,
    })).rejects.toThrow(/Sandbox credentials are required for development/)
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

describe('ensureWorkspaceSandbox — new seams', () => {
  beforeEach(() => {
    resetClientCache()
    listMock.mockReset()
    createMock.mockReset()
    sandboxCtor.mockReset()
  })

  it('forceNew deletes a name-matched running box and creates fresh', async () => {
    const del = vi.fn().mockResolvedValue(undefined)
    listMock.mockImplementation(({ status }: { status: string }) =>
      status === 'running'
        ? Promise.resolve([fakeBox({ name: 'box-w1', delete: del })])
        : Promise.resolve([]),
    )
    const created = fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never })
    createMock.mockResolvedValue(created)
    await ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }), {
      workspaceId: 'w1',
      harness: 'opencode',
      forceNew: true,
    })
    expect(del).toHaveBeenCalledOnce()
    expect(createMock).toHaveBeenCalledOnce()
  })

  it('liveness probe deletes an unresponsive running box and recreates', async () => {
    const del = vi.fn().mockResolvedValue(undefined)
    const dead = fakeBox({
      name: 'box-w1',
      delete: del,
      exec: vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 }),
    })
    listMock.mockImplementation(({ status }: { status: string }) =>
      status === 'running' ? Promise.resolve([dead]) : Promise.resolve([]),
    )
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      livenessProbe: { sidecarProcessPattern: () => 'opencode\\|claude' },
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    expect(dead.exec).toHaveBeenCalledWith('echo alive')
    expect(del).toHaveBeenCalledOnce()
    expect(createMock).toHaveBeenCalledOnce()
  })

  it('resumes a stopped box from snapshot instead of creating', async () => {
    const resume = vi.fn().mockResolvedValue(undefined)
    const stopped = fakeBox({
      name: 'box-w1',
      resume,
      waitFor: vi.fn(),
      exec: vi.fn().mockResolvedValue({ stdout: 'alive', exitCode: 0 }),
    })
    listMock.mockImplementation(({ status }: { status: string }) =>
      status === 'running'
        ? Promise.resolve([])
        : status === 'stopped'
          ? Promise.resolve([stopped])
          : Promise.resolve([]),
    )
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      livenessProbe: { sidecarProcessPattern: () => 'opencode' },
    })
    const box = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    expect(resume).toHaveBeenCalledOnce()
    expect(createMock).not.toHaveBeenCalled()
    expect(box).toBe(stopped)
  })

  it('spreads storage + restore into the create payload', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const storage = {
      type: 'r2' as const,
      bucket: 'b',
      endpoint: 'e',
      credentials: { accessKeyId: 'a', secretAccessKey: 's' },
      prefix: 'p/w1/',
    }
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      storage: () => storage,
      restore: () => ({ fromSnapshot: 'snap1', fromSandboxId: 'sb1' }),
      resumeStopped: false,
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    const payload = createMock.mock.calls[0]![0]
    expect(payload.storage).toEqual(storage)
    expect(payload.fromSnapshot).toBe('snap1')
    expect(payload.fromSandboxId).toBe('sb1')
  })

  it('bakes resolved model + childKeyMint override into backend.model', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      backendModelAtCreate: true,
      resumeStopped: false,
      provider: { providerName: 'openai-compat', modelName: 'm', apiKey: 'parent' },
      childKeyMint: async () => ({ succeeded: true, value: 'child-key' }),
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', userId: 'u9', harness: 'opencode' })
    expect(createMock.mock.calls[0]![0].backend.model).toMatchObject({
      provider: 'openai-compat',
      model: 'm',
      apiKey: 'child-key',
    })
  })

  it('childKeyMint failure falls through to parent key (logged, not thrown)', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      backendModelAtCreate: true,
      resumeStopped: false,
      provider: { providerName: 'openai-compat', modelName: 'm', apiKey: 'parent' },
      childKeyMint: async () => ({ succeeded: false, error: new Error('tcloud down') }),
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    expect(createMock.mock.calls[0]![0].backend.model.apiKey).toBe('parent')
  })

  it('runs bootstrap after create and on reuse; throws on bootstrap failure', async () => {
    const boot = vi.fn().mockResolvedValue({ succeeded: false, error: new Error('apk failed') })
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, { bootstrap: boot, resumeStopped: false })
    await expect(
      ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' }),
    ).rejects.toThrow(/bootstrap failed/)
    expect(boot).toHaveBeenCalledOnce()
  })

  it('boxKey overrides the workspace-keyed name (per-user keying)', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      boxKey: (s) => `vault-ai-${(s.userId ?? '').slice(0, 8)}`,
      resumeStopped: false,
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', userId: 'abcdef1234', harness: 'opencode' })
    expect(createMock.mock.calls[0]![0].name).toBe('vault-ai-abcdef12')
  })

  it('async scoped credentials mint a per-user client', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const creds = vi.fn(async (scope?: { userId?: string }) => ({
      apiKey: `key-${scope?.userId}`,
      baseUrl: 'u',
    }))
    const shell = shellFor(null, { credentials: creds, resumeStopped: false })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', userId: 'u9', harness: 'opencode' })
    expect(creds).toHaveBeenCalledWith({ workspaceId: 'w1', userId: 'u9' })
    expect(sandboxCtor).toHaveBeenCalledWith({ apiKey: 'key-u9', baseUrl: 'u' })
  })

  it('userId reaches the env/files build context', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const env = vi.fn(async (ctx: { userId?: string }) => ({
      BAD_CUSTOMER_ID: ctx.userId ? `user:${ctx.userId}` : '',
    }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, { env, resumeStopped: false })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', userId: 'u9', harness: 'opencode' })
    expect(createMock.mock.calls[0]![0].env.BAD_CUSTOMER_ID).toBe('user:u9')
  })
})

describe('terminal-proxy HMAC token', () => {
  const secret = 'test-secret'
  const id = { userId: 'u1', workspaceId: 'w1', sandboxId: 's1' }
  it('round-trips mint -> verify', async () => {
    const minted = await mintTerminalProxyToken(secret, id)
    expect(minted.succeeded).toBe(true)
    if (minted.succeeded) expect(await verifyTerminalProxyToken(secret, minted.value.token, id)).toBe(true)
  })
  it('rejects wrong identity, wrong secret, and expired token', async () => {
    const minted = await mintTerminalProxyToken(secret, id)
    if (!minted.succeeded) throw minted.error
    expect(await verifyTerminalProxyToken(secret, minted.value.token, { ...id, sandboxId: 's2' })).toBe(false)
    expect(await verifyTerminalProxyToken('other', minted.value.token, id)).toBe(false)
    const expired = await mintTerminalProxyToken(secret, id, -1000)
    if (expired.succeeded) expect(await verifyTerminalProxyToken(secret, expired.value.token, id)).toBe(false)
  })
  it('fails loud when secret absent', async () => {
    expect((await mintTerminalProxyToken('', id)).succeeded).toBe(false)
  })
})

describe('stream classifiers', () => {
  it('classifySeveredStream flags error-finish as severed, clears on step-start', () => {
    expect(
      classifySeveredStream({ type: 'message.part.updated', data: { part: { type: 'step-finish', reason: 'error' } } }),
    ).toEqual({ kind: 'step-finish', reason: 'error', severed: true })
    expect(
      classifySeveredStream({ type: 'message.part.updated', data: { part: { type: 'step-finish', reason: 'stop' } } }),
    ).toEqual({ kind: 'step-finish', reason: 'stop', severed: false })
    expect(
      classifySeveredStream({ type: 'message.part.updated', data: { part: { type: 'step-start' } } }),
    ).toEqual({ kind: 'step-start' })
  })
  it('isTerminalPromptEvent matches result/done only', () => {
    expect(isTerminalPromptEvent({ type: 'result' })).toBe(true)
    expect(isTerminalPromptEvent({ type: 'message.part.updated' })).toBe(false)
  })
  it('detectInteractiveQuestion extracts question text', () => {
    expect(
      detectInteractiveQuestion({ type: 'question.asked', data: { questions: [{ question: 'pick one?' }] } }),
    ).toBe('pick one?')
    expect(detectInteractiveQuestion({ type: 'message.part.updated', data: { part: { type: 'text' } } })).toBeNull()
  })
})

describe('driveSandboxTurn', () => {
  it('returns ok on success and fail on result.success=false', async () => {
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' })
    const okBox = fakeBox({ prompt: vi.fn().mockResolvedValue({ success: true, response: 'hi', durationMs: 1 }) })
    const r1 = await driveSandboxTurn(shell, okBox, 'go', { sessionId: 'sess1' })
    expect(r1.succeeded).toBe(true)
    const failBox = fakeBox({ prompt: vi.fn().mockResolvedValue({ success: false, error: 'boom', durationMs: 1 }) })
    const r2 = await driveSandboxTurn(shell, failBox, 'go', { sessionId: 'sess1' })
    expect(r2.succeeded).toBe(false)
  })
})

describe('deferred profile files', () => {
  const inlineMount = (path: string, content: string, executable?: boolean): AgentProfileFileMount => ({
    path,
    resource: { kind: 'inline', name: path, content },
    ...(executable !== undefined ? { executable } : {}),
  })

  it('splits inline files out and keeps non-inline refs in the profile', () => {
    const profile = {
      name: 'p',
      resources: {
        files: [
          inlineMount('skills/a.md', '# A'),
          { path: 'gh/b.md', resource: { kind: 'github', path: 'b.md' } },
        ],
      },
    } as unknown as AgentProfile
    const { leanProfile, deferredFiles } = splitDeferredProfileFiles(profile)
    expect(deferredFiles.map((f) => f.path)).toEqual(['skills/a.md'])
    expect((leanProfile.resources?.files ?? []).map((f) => f.path)).toEqual(['gh/b.md'])
  })

  it('writes each inline file via base64 exec and chmods bin targets', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [
      inlineMount('skills/seo.md', '# SEO'),
      inlineMount('/usr/local/bin/gtm', '#!/bin/sh\necho hi'),
    ])
    expect(res.succeeded).toBe(true)
    expect(exec).toHaveBeenCalledTimes(6)
    const cmds = exec.mock.calls.map((c) => c[0] as string)
    // base64 of "# SEO"
    expect(cmds.some((cmd) => cmd.includes(Buffer.from('# SEO', 'utf8').toString('base64')))).toBe(true)
    expect(cmds.some((cmd) => cmd.includes('base64 -d'))).toBe(true)
    // bin target gets +x
    expect(cmds.at(-1)).toContain('chmod +x')
    expect(cmds.slice(0, -1).some((cmd) => cmd.includes('chmod +x'))).toBe(false)
  })

  it('chunks large inline files to avoid oversized sandbox exec commands', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const largeScript = '#!/bin/sh\n' + 'echo x\n'.repeat(1500)

    const res = await writeProfileFilesToBox(box, [
      inlineMount('/home/agent/tools/gtm-agent/bin/gtm', largeScript),
    ])

    expect(res.succeeded).toBe(true)
    const cmds = exec.mock.calls.map((c) => c[0] as string)
    expect(cmds.length).toBeGreaterThan(4)
    expect(Math.max(...cmds.map((cmd) => cmd.length))).toBeLessThan(2500)
    expect(cmds.at(-1)).toContain('base64 -d')
  })

  it('fails loud on a non-zero exec exit', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'disk full', exitCode: 1 })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')])
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect(res.error.message).toContain('disk full')
  })

  it('ensureWorkspaceSandbox: deferred files are stripped from create payload and written post-running', async () => {
    listMock.mockResolvedValue([])
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const created = fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), exec, connection: { runtimeUrl: 'x' } as never })
    createMock.mockResolvedValue(created)
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO'), inlineMount('/usr/local/bin/gtm', 'echo')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      resumeStopped: false,
      profile: () => filesProfile,
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    const payload = createMock.mock.calls[0]![0]
    // Inline files stripped from the create payload.
    expect(payload.backend.profile.resources.files).toEqual([])
    // ...and written into the box afterward.
    expect(exec).toHaveBeenCalledTimes(6)
  })

  it('ensureWorkspaceSandbox: keeps files inline when deferProfileFiles is unset', async () => {
    listMock.mockResolvedValue([])
    const created = fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never })
    createMock.mockResolvedValue(created)
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      resumeStopped: false,
      profile: () => filesProfile,
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    const payload = createMock.mock.calls[0]![0]
    expect(payload.backend.profile.resources.files).toHaveLength(1)
  })
})

describe('sandbox tool install helpers', () => {
  it('builds executable tool mounts under a writable app-owned bin dir', () => {
    expect(sandboxToolBinDir({ appName: 'gtm-agent' })).toBe('/home/agent/tools/gtm-agent/bin')
    expect(sandboxToolPath({ appName: 'gtm-agent', toolName: 'gtm' }))
      .toBe('/home/agent/tools/gtm-agent/bin/gtm')

    const files = buildSandboxToolFileMounts({
      appName: 'gtm-agent',
      tools: [{ name: 'gtm', content: '#!/bin/sh\necho hi' }],
    })

    expect(files).toEqual([
      {
        path: '/home/agent/tools/gtm-agent/bin/gtm',
        resource: { kind: 'inline', name: 'gtm', content: '#!/bin/sh\necho hi' },
        executable: true,
      },
    ])
    expect(files[0]!.path).not.toContain('/usr/local/bin')
  })

  it('rejects unsafe app and tool path segments', () => {
    expect(() => sandboxToolBinDir({ appName: '../gtm' })).toThrow(/appName/)
    expect(() => sandboxToolPath({ appName: 'gtm-agent', toolName: 'bin/gtm' })).toThrow(/tool name/)
    expect(() => buildSandboxToolFileMounts({
      appName: 'gtm-agent',
      tools: [{ name: 'bad name', content: 'x' }],
    })).toThrow(/tool name/)
  })

  it('builds an idempotent PATH setup script for shell profiles', () => {
    const script = buildSandboxToolPathSetupScript({ appName: 'gtm-agent' })
    expect(script).toContain("mkdir -p '/home/agent/tools/gtm-agent/bin'")
    expect(script).toContain("PATH='/home/agent/tools/gtm-agent/bin':$PATH")
    expect(script).toContain('export PATH=/home/agent/tools/gtm-agent/bin:$PATH')
    expect(script).toContain('.profile')
    expect(script).toContain('.bashrc')
    expect(script).toContain('.zshrc')
  })

  it('runs PATH setup through box.exec and preserves setup failures', async () => {
    const okExec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    await expect(runSandboxToolPathSetup(fakeBox({ exec: okExec }), { appName: 'gtm-agent' }))
      .resolves.toEqual({ succeeded: true, value: undefined })
    expect(okExec.mock.calls[0]![0]).toContain('/home/agent/tools/gtm-agent/bin')

    const failExec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'readonly', exitCode: 1 })
    const outcome = await runSandboxToolPathSetup(fakeBox({ exec: failExec }), { appName: 'gtm-agent' })
    expect(outcome.succeeded).toBe(false)
    if (!outcome.succeeded) expect(outcome.error.message).toContain('readonly')
  })
})
