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
  classifySeveredStream,
  detectInteractiveQuestion,
  isTerminalPromptEvent,
  driveSandboxTurn,
  splitDeferredProfileFiles,
  writeProfileFilesToBox,
  type SandboxRuntimeConfig,
  type SecretStore,
} from './index'
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
    // Small files: truncate(.b64) + one base64 chunk + decode, per file.
    expect(exec).toHaveBeenCalledTimes(6)
    const cmds = exec.mock.calls.map((c) => c[0] as string)
    const joined = cmds.join('\n')
    // base64 of "# SEO" lands in a printf append; a final step decodes it.
    expect(joined).toContain(Buffer.from('# SEO', 'utf8').toString('base64'))
    expect(joined).toContain('base64 -d')
    // bin target gets +x; the non-bin skill file does not.
    const gtmCmds = cmds.filter((c) => c.includes('/usr/local/bin/gtm'))
    const seoCmds = cmds.filter((c) => c.includes('skills/seo.md'))
    expect(gtmCmds.some((c) => c.includes('chmod +x'))).toBe(true)
    expect(seoCmds.some((c) => c.includes('chmod +x'))).toBe(false)
  })

  it('chunks a large file so every exec body stays under the 4 KiB proxy cap', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    // >8 KiB of varied bytes (ascii + unicode + shell specials) exercises
    // multi-chunk slicing and byte-exact round-trip.
    const big =
      Array.from({ length: 9000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('') +
      '\nüé€\t"quotes" & $pecials\n'
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/big.md', big)])
    expect(res.succeeded).toBe(true)
    const cmds = exec.mock.calls.map((c) => c[0] as string)

    // (a) every recorded exec command's UTF-8 byte length is under the cap.
    for (const cmd of cmds) {
      expect(Buffer.byteLength(cmd, 'utf8')).toBeLessThan(4096)
    }
    // A >8 KiB file needs more than one append chunk.
    const appends = cmds.filter((c) => c.startsWith("printf '%s' '"))
    expect(appends.length).toBeGreaterThan(1)

    // (d) mkdir -p precedes the writes (it is part of the first command).
    expect(cmds[0]).toContain('mkdir -p')

    // (b) concatenating the printf payloads and base64-decoding reproduces the
    // original content byte-exact.
    const payload = appends
      .map((c) => c.replace(/^printf '%s' '/, '').replace(/' >> .*$/, ''))
      .join('')
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(big)
  })

  it('chmod +x is issued for an executable large file, every body under the cap', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const big = '#!/bin/sh\n' + 'echo x;'.repeat(2000) // >12 KiB
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/run.sh', big, true)])
    expect(res.succeeded).toBe(true)
    const cmds = exec.mock.calls.map((c) => c[0] as string)
    for (const cmd of cmds) expect(Buffer.byteLength(cmd, 'utf8')).toBeLessThan(4096)
    // (c) chmod +x is issued for the executable file.
    expect(cmds.some((c) => c.includes('chmod +x'))).toBe(true)
    // Round-trips byte-exact.
    const payload = cmds
      .filter((c) => c.startsWith("printf '%s' '"))
      .map((c) => c.replace(/^printf '%s' '/, '').replace(/' >> .*$/, ''))
      .join('')
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(big)
  })

  it('fails loud on a non-zero exec exit', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'disk full', exitCode: 1 })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')])
    expect(res.succeeded).toBe(false)
    if (!res.succeeded) expect(res.error.message).toContain('disk full')
  })

  it('expands a ~/ mount path to $HOME (not a literal ~ dir); absolute paths unchanged', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [
      inlineMount('~/.claude/skills/gtm/SKILL.md', '# GTM skill'),
      inlineMount('/etc/app/config.json', '{}'),
    ])
    expect(res.succeeded).toBe(true)
    const cmds = exec.mock.calls.map((c) => c[0] as string)

    // The tilde mount's commands expand `~` to $HOME and single-quote only the
    // remainder — never a single-quoted literal '~/...'.
    const tildeCmds = cmds.filter((c) => c.includes('.claude/skills/gtm'))
    expect(tildeCmds.length).toBeGreaterThan(0)
    for (const cmd of tildeCmds) {
      // Unquoted $HOME followed by `/` — the shell expands it to the real home.
      expect(cmd).toMatch(/"\$HOME"\//)
      expect(cmd).not.toContain("'~/")
      expect(cmd).not.toMatch(/'~'/)
    }
    // mkdir -p targets the real $HOME tree.
    expect(tildeCmds[0]).toContain(`mkdir -p "$HOME"/'.claude/skills/gtm'`)
    // The decode writes to $HOME, not a literal ~.
    expect(tildeCmds.some((c) => c.includes(`base64 -d`) && c.includes('"$HOME"/'))).toBe(true)

    // The absolute path is passed through single-quoted, with no $HOME rewrite.
    const absCmds = cmds.filter((c) => c.includes('/etc/app/config.json'))
    expect(absCmds.length).toBeGreaterThan(0)
    for (const cmd of absCmds) expect(cmd).not.toContain('$HOME')
    expect(absCmds[0]).toContain(`mkdir -p '/etc/app'`)
  })

  it('retries a 429 (rate limit) with backoff, then succeeds', async () => {
    let calls = 0
    const exec = vi.fn().mockImplementation(async () => {
      calls++
      // First exec is rate-limited twice, then the proxy lets it through.
      if (calls <= 2) {
        const err = Object.assign(new Error('Too Many Requests'), { status: 429, code: 'rate_limited' })
        throw err
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')])
    expect(res.succeeded).toBe(true)
    // 2 rejected attempts on the first step + the successful retry + the
    // remaining 2 steps (append, decode) = 5 total exec invocations.
    expect(calls).toBe(5)
  })

  it('fails loud immediately on a non-429 thrown error (no retry)', async () => {
    let calls = 0
    const exec = vi.fn().mockImplementation(async () => {
      calls++
      const err = Object.assign(new Error('connection reset'), { status: 503, code: 'server_error' })
      throw err
    })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')])
    expect(res.succeeded).toBe(false)
    // Exactly one attempt — a non-429 error is not retried.
    expect(calls).toBe(1)
    if (!res.succeeded) expect(res.error.message).toContain('exec failed')
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
    // ...and written into the box afterward (3 small execs per file).
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