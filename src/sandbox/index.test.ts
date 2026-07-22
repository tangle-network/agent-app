import { execFile } from 'node:child_process'
import { mkdtemp, readFile as readFsFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileAsync = promisify(execFile)

const createMock = vi.fn()
const listMock = vi.fn()
const getMock = vi.fn()
const sandboxCtor = vi.fn()

vi.mock('@tangle-network/sandbox', () => ({
  Sandbox: class {
    list = listMock
    create = createMock
    get = getMock
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
  peekWorkspaceSandbox,
  buildAppToolMcpServers,
  streamSandboxPrompt,
  resolveModel,
  flattenHistory,
  mergeHistoryIntoParts,
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
  deferredCorpusHash,
  writeProfileFilesToBox,
  assertProvisionPayloadWithinCap,
  assertEnvWithinLimits,
  PROVISION_PAYLOAD_MAX_BYTES,
  ENV_VALUE_MAX_BYTES,
  ENV_TOTAL_MAX_BYTES,
  SandboxRuntimeAuthRefreshError,
  type SandboxRuntimeConfig,
  type SecretStore,
  type PromptInputPart,
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
    id: 'sandbox-1',
    metadata: { harness: 'opencode' },
    connection: {
      runtimeUrl: 'https://rt',
      authToken: 'runtime-token',
      authTokenExpiresAt: '2999-01-01T00:00:00.000Z',
    } as never,
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
  getMock.mockReset()
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

  it('refreshes a reused running box when the list shape has no runtime connection', async () => {
    const running = fakeBox({ name: 'box-w1', metadata: { harness: 'opencode' }, connection: undefined })
    const latest = fakeBox({
      id: running.id,
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      connection: { sidecarUrl: 'https://sidecar.example' } as never,
    })
    listMock.mockResolvedValue([running])
    getMock.mockResolvedValue(latest)

    const box = await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })

    expect(running.refresh).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith(running.id)
    expect(box).toBe(latest)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('deletes and recreates on harness mismatch', async () => {
    const stale = fakeBox({ name: 'box-w1', metadata: { harness: 'claude-code' } })
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'running' ? [stale] : []),
    )
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

  it('preserves a stopped-box lookup error instead of creating with the same identity', async () => {
    const error = new Error('list down')
    listMock.mockRejectedValue(error)
    await expect(
      ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' }),
    ).rejects.toBe(error)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('refreshes when the created box has no runtimeUrl', async () => {
    listMock.mockResolvedValue([])
    const created = fakeBox({ connection: undefined })
    const latest = fakeBox({
      id: created.id,
      connection: { sidecarUrl: 'https://sidecar.example' } as never,
    })
    createMock.mockResolvedValue(created)
    getMock.mockResolvedValue(latest)
    const box = await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })
    expect(created.refresh).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith(created.id)
    expect(box).toBe(latest)
  })

  it('treats sidecarUrl-only created boxes as runtime-ready', async () => {
    listMock.mockResolvedValue([])
    const created = fakeBox({ connection: { sidecarUrl: 'https://sidecar.example' } as never })
    createMock.mockResolvedValue(created)

    await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })

    expect(created.refresh).not.toHaveBeenCalled()
  })

  it('adds webTerminalEnabled to the create payload when requested by the shell', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox())

    await ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'https://s' }, {
      webTerminalEnabled: true,
    }), { workspaceId: 'w1', harness: 'opencode' })

    expect(createMock.mock.calls[0]![0].webTerminalEnabled).toBe(true)
  })

  it('recreates a reused box whose edge has failed instead of returning it', async () => {
    const del = vi.fn().mockResolvedValue(undefined)
    const failed = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      connection: { runtimeUrl: 'https://rt', edgeStatus: 'failed' } as never,
      delete: del,
    })
    // running-only: a status-blind mock would re-surface the box on the stopped
    // list and send Stage 2 down a resume() path the fake box can't service.
    listMock.mockImplementation(({ status }: { status: string }) =>
      status === 'running' ? Promise.resolve([failed]) : Promise.resolve([]),
    )
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))

    await ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })

    expect(del).toHaveBeenCalledOnce()
    expect(createMock).toHaveBeenCalledOnce()
  })

  it('recreates a reused box that never surfaces a runtime connection (no silent reuse)', async () => {
    vi.useFakeTimers()
    try {
      const del = vi.fn().mockResolvedValue(undefined)
      // Matches harness but has no connection; refresh + get never populate one,
      // so refreshRuntimeConnection exhausts its polling window.
      const stuck = fakeBox({
        name: 'box-w1',
        metadata: { harness: 'opencode' },
        connection: undefined,
        delete: del,
      })
      listMock.mockImplementation(({ status }: { status: string }) =>
        status === 'running' ? Promise.resolve([stuck]) : Promise.resolve([]),
      )
      getMock.mockResolvedValue(stuck)
      createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))

      const promise = ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })
      // Drive past the 30s readiness deadline so the poll loop gives up.
      await vi.advanceTimersByTimeAsync(31_000)
      await promise

      expect(del).toHaveBeenCalledOnce()
      expect(createMock).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recreates instead of hard-failing when refresh/get throw during the readiness poll', async () => {
    vi.useFakeTimers()
    try {
      const del = vi.fn().mockResolvedValue(undefined)
      // A harness-matched running box with no connection whose refresh + get
      // keep throwing (transient 5xx / network blip). The poll must swallow and
      // retry, then fall through to recreate — not surface a hard failure.
      const flaky = fakeBox({
        name: 'box-w1',
        metadata: { harness: 'opencode' },
        connection: undefined,
        delete: del,
        refresh: vi.fn().mockRejectedValue(new Error('transient 5xx')),
      })
      listMock.mockImplementation(({ status }: { status: string }) =>
        status === 'running' ? Promise.resolve([flaky]) : Promise.resolve([]),
      )
      getMock.mockRejectedValue(new Error('transient 5xx'))
      createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))

      const promise = ensureWorkspaceSandbox(shell(), { workspaceId: 'w1', harness: 'opencode' })
      await vi.advanceTimersByTimeAsync(31_000)

      await expect(promise).resolves.toBeDefined()
      expect(del).toHaveBeenCalledOnce()
      expect(createMock).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
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
      requireVisibleAssistantOutput: true,
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
    expect(opts.requireVisibleAssistantOutput).toBe(true)
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

  it('forwards interactions verbatim into backend when set', async () => {
    async function* events() {
      yield { type: 'result' }
    }
    const box = fakeBox({ streamPrompt: vi.fn().mockReturnValue(events()) })
    for await (const _ of streamSandboxPrompt(shell(), box, 'hi', {
      interactions: { question: true },
    })) {
      void _
    }
    const [, opts] = (box.streamPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(opts.backend.interactions).toEqual({ question: true })
  })

  it('omits interactions from backend when not set', async () => {
    async function* events() {
      yield { type: 'result' }
    }
    const box = fakeBox({ streamPrompt: vi.fn().mockReturnValue(events()) })
    for await (const _ of streamSandboxPrompt(shell(), box, 'hi')) void _
    const [, opts] = (box.streamPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(opts.backend.interactions).toBeUndefined()
  })

  it('forwards a PromptInputPart[] message to box.streamPrompt with history folded into the text part', async () => {
    async function* events() {
      yield { type: 'result' }
    }
    const box = fakeBox({ streamPrompt: vi.fn().mockReturnValue(events()) })
    const parts: PromptInputPart[] = [
      { type: 'image', url: 'https://img/1.png' },
      { type: 'text', text: 'describe this' },
    ]
    for await (const _ of streamSandboxPrompt(shell(), box, parts, {
      history: [{ role: 'assistant', content: 'prior' }],
    })) {
      void _
    }
    const [prompt] = (box.streamPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(Array.isArray(prompt)).toBe(true)
    expect(prompt).toEqual([
      { type: 'image', url: 'https://img/1.png' },
      { type: 'text', text: 'Assistant: prior\n\nUser: describe this' },
    ])
  })
})

describe('pure seam helpers', () => {
  it('flattenHistory returns the bare message when no history', () => {
    expect(flattenHistory('x')).toBe('x')
  })

  it('mergeHistoryIntoParts returns the same parts when there is no history', () => {
    const parts: PromptInputPart[] = [{ type: 'text', text: 'hi' }]
    expect(mergeHistoryIntoParts(parts)).toBe(parts)
    expect(mergeHistoryIntoParts(parts, [])).toBe(parts)
  })

  it('mergeHistoryIntoParts folds the transcript into the first text part, preserving other parts and order', () => {
    const parts: PromptInputPart[] = [
      { type: 'image', url: 'https://img/1.png' },
      { type: 'text', text: 'describe this' },
      { type: 'file', filename: 'notes.txt' },
    ]
    const merged = mergeHistoryIntoParts(parts, [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ])
    expect(merged).toEqual([
      { type: 'image', url: 'https://img/1.png' },
      {
        type: 'text',
        text: 'User: earlier question\n\nAssistant: earlier answer\n\nUser: describe this',
      },
      { type: 'file', filename: 'notes.txt' },
    ])
  })

  it('mergeHistoryIntoParts throws fail-loud when parts contain no text part', () => {
    const parts: PromptInputPart[] = [{ type: 'image', url: 'https://img/1.png' }]
    expect(() => mergeHistoryIntoParts(parts, [{ role: 'user', content: 'prior' }])).toThrow(
      /text part/,
    )
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

  it('resolveModel keyless config stays undefined without allowKeylessModel', () => {
    expect(
      resolveModel({ providerName: 'openai-compat', modelName: 'm', routerBaseUrl: 'https://r' }),
    ).toBeUndefined()
  })

  it('resolveModel allowKeylessModel emits metadata with NO apiKey property', () => {
    const m = resolveModel({
      providerName: 'openai-compat',
      modelName: 'm',
      routerBaseUrl: 'https://r',
      allowKeylessModel: true,
    })
    expect(m).toEqual({ model: 'm', provider: 'openai-compat', baseUrl: 'https://r' })
    expect(m && 'apiKey' in m).toBe(false)
  })

  it('resolveModel allowKeylessModel still round-trips a supplied key unchanged', () => {
    const m = resolveModel(
      { providerName: 'openai-compat', modelName: 'm', allowKeylessModel: true },
      { modelApiKey: 'k1' },
    )
    expect(m).toEqual({ model: 'm', provider: 'openai-compat', apiKey: 'k1' })
  })

  it('resolveModel allowKeylessModel without explicit providerName stays undefined', () => {
    expect(resolveModel({ modelName: 'm', allowKeylessModel: true })).toBeUndefined()
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

describe('provision S-cost gates', () => {
  it('assertEnvWithinLimits REDS on a single env value over the per-entry cap, naming the variable', () => {
    expect(() =>
      assertEnvWithinLimits({ SMALL: 'ok', OPENCODE_CONFIG_CONTENT: 'x'.repeat(ENV_VALUE_MAX_BYTES) }),
    ).toThrow(/OPENCODE_CONFIG_CONTENT is \d+ bytes[\s\S]*MAX_ARG_STRLEN/)
  })

  it('assertEnvWithinLimits REDS on total env size over the block cap, naming the largest entry', () => {
    const env: Record<string, string> = {}
    for (let i = 0; i < 4; i += 1) env[`VAR_${i}`] = 'x'.repeat(60_000)
    env.VAR_3 = 'x'.repeat(61_000)
    expect(() => assertEnvWithinLimits(env)).toThrow(
      new RegExp(`env block is \\d+ bytes total — over the ${ENV_TOTAL_MAX_BYTES}-byte gate[\\s\\S]*VAR_3`),
    )
  })

  it('assertEnvWithinLimits passes a normal env untouched', () => {
    expect(() => assertEnvWithinLimits({ WORKSPACE_ID: 'w1', NODE_ENV: 'test' })).not.toThrow()
  })

  it('assertProvisionPayloadWithinCap REDS over 240KB with a per-section breakdown and the defer hint', () => {
    const payload = {
      env: { WORKSPACE_ID: 'w1' },
      secrets: ['SECRET_A'],
      backend: {
        profile: {
          name: 'big',
          resources: {
            files: [
              { path: 'corpus.md', resource: { kind: 'inline', name: 'corpus', content: 'x'.repeat(280_000) } },
            ],
          },
        } as AgentProfile,
      },
    }
    expect(() => assertProvisionPayloadWithinCap(payload)).toThrow(
      new RegExp(
        `payload is \\d+ bytes — over the ${PROVISION_PAYLOAD_MAX_BYTES}-byte gate` +
          `[\\s\\S]*profile=\\d+B \\(files=\\d+B\\), env=\\d+B, secrets=\\d+B` +
          `[\\s\\S]*deferProfileFiles: true or move content to resources`,
      ),
    )
  })

  it('assertProvisionPayloadWithinCap passes an under-cap payload', () => {
    expect(() =>
      assertProvisionPayloadWithinCap({ env: { A: 'a' }, secrets: [], backend: { profile: PROFILE } }),
    ).not.toThrow()
  })

  it('ensureWorkspaceSandbox rejects an over-cap payload BEFORE the create POST', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox())
    const bigProfile: AgentProfile = {
      name: 'big',
      resources: {
        files: [
          { path: 'corpus.md', resource: { kind: 'inline', name: 'corpus', content: 'x'.repeat(280_000) } },
        ],
      },
    } as AgentProfile
    await expect(
      ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'https://s' }, { profile: () => bigProfile }), {
        workspaceId: 'w1',
        harness: 'opencode',
      }),
    ).rejects.toThrow(/over the 240000-byte gate[\s\S]*deferProfileFiles/)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('ensureWorkspaceSandbox rejects an E2BIG-class env var BEFORE the create POST', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox())
    await expect(
      ensureWorkspaceSandbox(
        shellFor(
          { apiKey: 'k', baseUrl: 'https://s' },
          { env: async () => ({ OPENCODE_CONFIG_CONTENT: 'x'.repeat(130_000) }) },
        ),
        { workspaceId: 'w1', harness: 'opencode' },
      ),
    ).rejects.toThrow(/OPENCODE_CONFIG_CONTENT/)
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('ensureWorkspaceSandbox — new seams', () => {
  beforeEach(() => {
    resetClientCache()
    listMock.mockReset()
    createMock.mockReset()
    getMock.mockReset()
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

  it('preserves a typed egress recovery error from a stopped-box resume', async () => {
    class EgressProxyRecoveryError extends Error {
      readonly code = 'EGRESS_PROXY_RECOVERY_REQUIRED'
      readonly status = 409
      readonly phase = 'egress_proxy_recovery'

      constructor() {
        super('Egress proxy recovery required')
        this.name = 'EgressProxyRecoveryError'
      }
    }

    const error = new EgressProxyRecoveryError()
    const stopped = fakeBox({
      name: 'box-w1',
      resume: vi.fn().mockRejectedValue(error),
    })
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'stopped' ? [stopped] : []),
    )

    await expect(
      ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }), {
        workspaceId: 'w1',
        harness: 'opencode',
      }),
    ).rejects.toBe(error)

    expect(stopped.delete).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('preserves a generic stopped-box resume error instead of creating', async () => {
    const error = new Error('resume unavailable')
    const stopped = fakeBox({
      name: 'box-w1',
      resume: vi.fn().mockRejectedValue(error),
    })
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'stopped' ? [stopped] : []),
    )

    await expect(
      ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }), {
        workspaceId: 'w1',
        harness: 'opencode',
      }),
    ).rejects.toBe(error)

    expect(stopped.delete).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('lets product recovery choose deletion, restore, and a fresh create identity', async () => {
    const error = new Error('resume unavailable')
    const stopped = fakeBox({
      name: 'box-w1',
      resume: vi.fn().mockRejectedValue(error),
    })
    const recovered = fakeBox({ name: 'box-w1-recovery' })
    const restore = { fromSnapshot: 'snapshot-1', fromSandboxId: stopped.id }
    const recoverStoppedSandbox = vi.fn(async (failure: { box: SandboxInstance }) => {
      await failure.box.delete()
      return {
        succeeded: true as const,
        value: {
          replacementBoxKey: 'box-w1-recovery',
          restore,
        },
      }
    })
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'stopped' ? [stopped] : []),
    )
    createMock.mockResolvedValue(recovered)

    await ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      recoverStoppedSandbox,
    }), { workspaceId: 'w1', harness: 'opencode' })

    expect(recoverStoppedSandbox).toHaveBeenCalledWith(expect.objectContaining({
      box: stopped,
      error,
      boxKey: 'box-w1',
      scope: { workspaceId: 'w1' },
    }))
    expect(stopped.delete).toHaveBeenCalledOnce()
    expect(createMock).toHaveBeenCalledOnce()
    expect(createMock.mock.calls[0]![0]).toMatchObject({
      name: 'box-w1-recovery',
      idempotencyKey: 'box-w1-recovery',
      fromSnapshot: 'snapshot-1',
      fromSandboxId: stopped.id,
    })
  })

  it('lets product recovery decline and preserve the original resume error', async () => {
    const error = new Error('resume unavailable')
    const stopped = fakeBox({
      name: 'box-w1',
      resume: vi.fn().mockRejectedValue(error),
    })
    const recoverStoppedSandbox = vi.fn(async () => ({
      succeeded: true as const,
      value: null,
    }))
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'stopped' ? [stopped] : []),
    )

    await expect(
      ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }, {
        recoverStoppedSandbox,
      }), { workspaceId: 'w1', harness: 'opencode' }),
    ).rejects.toBe(error)

    expect(stopped.delete).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('preserves a failed product recovery outcome', async () => {
    const resumeError = new Error('resume unavailable')
    const recoveryError = new Error('snapshot failed')
    const stopped = fakeBox({
      name: 'box-w1',
      resume: vi.fn().mockRejectedValue(resumeError),
    })
    const recoverStoppedSandbox = vi.fn(async () => ({
      succeeded: false as const,
      error: recoveryError,
    }))
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'stopped' ? [stopped] : []),
    )

    await expect(
      ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }, {
        recoverStoppedSandbox,
      }), { workspaceId: 'w1', harness: 'opencode' }),
    ).rejects.toBe(recoveryError)

    expect(stopped.delete).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('lets product recovery suppress a configured restore', async () => {
    const error = new Error('resume unavailable')
    const stopped = fakeBox({
      name: 'box-w1',
      resume: vi.fn().mockRejectedValue(error),
    })
    const recovered = fakeBox({ name: 'box-w1-recovery' })
    const recoverStoppedSandbox = vi.fn(async () => ({
      succeeded: true as const,
      value: { replacementBoxKey: 'box-w1-recovery', restore: null },
    }))
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'stopped' ? [stopped] : []),
    )
    createMock.mockResolvedValue(recovered)

    await ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      restore: () => ({ fromSnapshot: 'normal-snapshot', fromSandboxId: 'normal-sandbox' }),
      recoverStoppedSandbox,
    }), { workspaceId: 'w1', harness: 'opencode' })

    const payload = createMock.mock.calls[0]![0]
    expect(payload.fromSnapshot).toBeUndefined()
    expect(payload.fromSandboxId).toBeUndefined()
  })

  it('rejects stopped-box recovery that reuses the failed create identity', async () => {
    const error = new Error('resume unavailable')
    const stopped = fakeBox({
      name: 'box-w1',
      resume: vi.fn().mockRejectedValue(error),
    })
    const recoverStoppedSandbox = vi.fn(async () => ({
      succeeded: true as const,
      value: { replacementBoxKey: 'box-w1' },
    }))
    listMock.mockImplementation(({ status }: { status: string }) =>
      Promise.resolve(status === 'stopped' ? [stopped] : []),
    )

    await expect(
      ensureWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'u' }, {
        recoverStoppedSandbox,
      }), { workspaceId: 'w1', harness: 'opencode' }),
    ).rejects.toThrow(/fresh replacement box key/)

    expect(createMock).not.toHaveBeenCalled()
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
    expect(payload.idempotencyKey).toBe('box-w1')
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

  it('billingOwnerId is included in the create payload only when set', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, { resumeStopped: false })
    await ensureWorkspaceSandbox(shell, {
      workspaceId: 'w1',
      harness: 'opencode',
      billingOwnerId: 'platform-user-7',
    })
    expect(createMock.mock.calls[0]![0].billingOwnerId).toBe('platform-user-7')

    createMock.mockClear()
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    expect('billingOwnerId' in createMock.mock.calls[0]![0]).toBe(false)
  })

  it('bakes keyless model metadata at create under allowKeylessModel (no apiKey field)', async () => {
    listMock.mockResolvedValue([])
    createMock.mockResolvedValue(fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), connection: { runtimeUrl: 'x' } as never }))
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      backendModelAtCreate: true,
      resumeStopped: false,
      provider: {
        providerName: 'openai-compat',
        modelName: 'm',
        routerBaseUrl: 'https://router',
        allowKeylessModel: true,
      },
    })
    await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
    const model = createMock.mock.calls[0]![0].backend.model
    expect(model).toEqual({ model: 'm', provider: 'openai-compat', baseUrl: 'https://router' })
    expect('apiKey' in model).toBe(false)
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
    expect(createMock.mock.calls[0]![0].idempotencyKey).toBe('vault-ai-abcdef12')
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
  it('detectInteractiveQuestion recognizes generic interaction/kind:question events', () => {
    expect(
      detectInteractiveQuestion({ type: 'interaction', data: { kind: 'question', questions: [{ question: 'pick?' }] } }),
    ).toBe('pick?')
    expect(detectInteractiveQuestion({ type: 'interaction', data: { kind: 'permission' } })).toBeNull()
  })
})

describe('driveSandboxTurn', () => {
  it('delegates to box.driveTurn and surfaces the settled state (completed / failed)', async () => {
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' })
    const okBox = fakeBox({
      driveTurn: vi.fn().mockResolvedValue({ state: 'completed', text: 'hi', result: { text: 'hi' } }),
    })
    const r1 = await driveSandboxTurn(shell, okBox, 'go', { sessionId: 'sess1' })
    expect(r1.succeeded).toBe(true)
    expect(r1.succeeded && r1.value.state).toBe('completed')
    // A deterministic `failed` turn is a settled state the caller inspects — not a
    // thrown transport error — so the Outcome is still `ok`, carrying state:'failed'.
    const failBox = fakeBox({
      driveTurn: vi.fn().mockResolvedValue({ state: 'failed', error: 'boom' }),
    })
    const r2 = await driveSandboxTurn(shell, failBox, 'go', { sessionId: 'sess1' })
    expect(r2.succeeded).toBe(true)
    expect(r2.succeeded && r2.value.state).toBe('failed')
  })
  it('fails the Outcome when the drive call itself throws (retryable transport error)', async () => {
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' })
    const box = fakeBox({ driveTurn: vi.fn().mockRejectedValue(new Error('network')) })
    const r = await driveSandboxTurn(shell, box, 'go', { sessionId: 'sess1' })
    expect(r.succeeded).toBe(false)
  })
  it('returns promptly on a still-running turn — does NOT block awaiting completion', async () => {
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' })
    // A blocking box.prompt would never resolve on a mid-flight turn; the one-tick
    // driver resolves immediately with state:'running' and never touches box.prompt.
    const drive = vi.fn().mockResolvedValue({ state: 'running', elapsedMs: 5 })
    const prompt = vi.fn(() => new Promise<never>(() => {}))
    const box = fakeBox({ driveTurn: drive, prompt: prompt as never })
    const r = await driveSandboxTurn(shell, box, 'go', { sessionId: 'sess1' })
    expect(r.succeeded).toBe(true)
    expect(r.succeeded && r.value.state).toBe('running')
    expect(prompt).not.toHaveBeenCalled()
    expect(drive).toHaveBeenCalledTimes(1)
  })
  it('forwards turnId + wallCapMs to box.driveTurn but never leaks interactions into the backend', async () => {
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' })
    const box = fakeBox({
      driveTurn: vi.fn().mockResolvedValue({ state: 'running', elapsedMs: 1 }),
    })
    await driveSandboxTurn(shell, box, 'go', {
      sessionId: 'sess1',
      turnId: 'turn-42',
      wallCapMs: 60_000,
      interactions: { question: true },
    })
    const [, opts] = (box.driveTurn as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(opts.sessionId).toBe('sess1')
    expect(opts.turnId).toBe('turn-42')
    expect(opts.wallCapMs).toBe(60_000)
    expect(opts.backend.interactions).toBeUndefined()
  })
})

describe('deferred profile files', () => {
  const inlineMount = (path: string, content: string, executable?: boolean): AgentProfileFileMount => ({
    path,
    resource: { kind: 'inline', name: path, content },
    ...(executable !== undefined ? { executable } : {}),
  })

  async function withShellBackedProfileWriter<T>(
    failAfterSuccessfulCalls: Set<number>,
    run: (ctx: { box: SandboxInstance; cwd: string; exec: ReturnType<typeof vi.fn> }) => Promise<T>,
  ): Promise<T> {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-app-profile-write-'))
    let calls = 0
    const exec = vi.fn().mockImplementation(async (cmd: string) => {
      calls++
      let stdout = ''
      let stderr = ''
      try {
        const output = await execFileAsync('bash', ['-lc', cmd], { cwd, timeout: 5000 })
        stdout = String(output.stdout)
        stderr = String(output.stderr)
      } catch (err) {
        const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown }
        return {
          stdout: typeof e.stdout === 'string' ? e.stdout : '',
          stderr: typeof e.stderr === 'string' ? e.stderr : '',
          exitCode: typeof e.code === 'number' ? e.code : 1,
        }
      }
      if (failAfterSuccessfulCalls.has(calls)) {
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      }
      return { stdout, stderr, exitCode: 0 }
    })
    try {
      return await run({ box: fakeBox({ exec }), cwd, exec })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

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
    ], { paceMs: 0 })
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
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/big.md', big)], { paceMs: 0 })
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
      .map((c) => c.replace(/' > .*$/, ''))
      .join('')
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(big)
  })

  it('chmod +x is issued for an executable large file, every body under the cap', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const big = '#!/bin/sh\n' + 'echo x;'.repeat(2000) // >12 KiB
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/run.sh', big, true)], { paceMs: 0 })
    expect(res.succeeded).toBe(true)
    const cmds = exec.mock.calls.map((c) => c[0] as string)
    for (const cmd of cmds) expect(Buffer.byteLength(cmd, 'utf8')).toBeLessThan(4096)
    // (c) chmod +x is issued for the executable file.
    expect(cmds.some((c) => c.includes('chmod +x'))).toBe(true)
    // Round-trips byte-exact.
    const payload = cmds
      .filter((c) => c.startsWith("printf '%s' '"))
      .map((c) => c.replace(/^printf '%s' '/, '').replace(/' >> .*$/, ''))
      .map((c) => c.replace(/' > .*$/, ''))
      .join('')
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(big)
  })

  it('fails loud on a non-zero exec exit', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'disk full', exitCode: 1 })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')])
    expect(res.succeeded).toBe(false)
    expect(exec).toHaveBeenCalledTimes(1)
    if (!res.succeeded) expect(res.error.message).toContain('disk full')
  })

  it('handles a GTM-scale deferred corpus without oversized execs', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const fileSizes = [
      ...Array.from({ length: 22 }, () => 4500),
      ...Array.from({ length: 25 }, () => 4941),
      4952,
    ]
    expect(fileSizes.reduce((sum, size) => sum + size, 0)).toBe(227_477)
    const files = fileSizes.map((size, i) => inlineMount(`skills/gtm/file-${i}.md`, 'x'.repeat(size)))

    const res = await writeProfileFilesToBox(box, files, { paceMs: 0 })

    expect(res.succeeded).toBe(true)
    expect(exec).toHaveBeenCalledTimes(218)
    for (const [cmd] of exec.mock.calls) {
      expect(Buffer.byteLength(cmd as string, 'utf8')).toBeLessThan(4096)
    }
  })

  it('expands a ~/ mount path to $HOME (not a literal ~ dir); absolute paths unchanged', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [
      inlineMount('~/.claude/skills/gtm/SKILL.md', '# GTM skill'),
      inlineMount('/etc/app/config.json', '{}'),
    ], { paceMs: 0 })
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
    expect(cmds.some((c) => c === `mkdir -p '/etc/app'`)).toBe(true)
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
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], { paceMs: 0 })
    expect(res.succeeded).toBe(true)
    // 2 rejected attempts on the first step + the successful retry + the
    // remaining 2 steps (append, decode) = 5 total exec invocations.
    expect(calls).toBe(5)
  })

  it('retries a 5xx SandboxError with backoff, then succeeds', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        if (calls === 1) {
          const err = Object.assign(new Error('Service Unavailable'), { status: 503, code: 'server_error' })
          throw err
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const box = fakeBox({ exec })
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], { paceMs: 0 })

      await vi.advanceTimersByTimeAsync(2_000)
      const res = await promise

      expect(res.succeeded).toBe(true)
      expect(calls).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries connection reset/refused network errors with backoff, then succeeds', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        if (calls === 1) throw new Error('fetch failed', { cause: reset })
        if (calls === 2) throw refused
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const box = fakeBox({ exec })
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], { paceMs: 0 })

      await vi.advanceTimersByTimeAsync(2_000)
      const res = await promise

      expect(res.succeeded).toBe(true)
      expect(calls).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a lost transport response after a chunk write without duplicating content', async () => {
    await withShellBackedProfileWriter(new Set([2]), async ({ box, cwd, exec }) => {
      const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'abc')], { paceMs: 0 })

      expect(res.succeeded).toBe(true)
      expect(exec).toHaveBeenCalledTimes(4)
      await expect(readFsFile(join(cwd, 'skills/x.md'), 'utf8')).resolves.toBe('abc')
    })
  })

  it('retries a lost transport response after final materialization without false failure', async () => {
    await withShellBackedProfileWriter(new Set([3]), async ({ box, cwd, exec }) => {
      const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'abc')], { paceMs: 0 })

      expect(res.succeeded).toBe(true)
      expect(exec).toHaveBeenCalledTimes(4)
      await expect(readFsFile(join(cwd, 'skills/x.md'), 'utf8')).resolves.toBe('abc')
      await expect(readFsFile(join(cwd, 'skills/x.md.b64.part.0'), 'utf8')).rejects.toThrow()
      await expect(readFsFile(join(cwd, 'skills/x.md.b64'), 'utf8')).rejects.toThrow()
    })
  })

  it.each([
    ['prefetch failed', () => new Error('prefetch failed')],
    ['payment not ready', () => new Error('payment not ready')],
    ['unsupported 501 status', () => Object.assign(new Error('not implemented'), { status: 501 })],
  ])('does not retry unrelated exec message/status: %s', async (_label, makeError) => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        throw makeError()
      })
      const box = fakeBox({ exec })
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], {
        maxRetries: 2,
        paceMs: 0,
      })

      await vi.advanceTimersByTimeAsync(2_000)
      const res = await promise

      expect(res.succeeded).toBe(false)
      expect(calls).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['runtime not ready', () => new Error('runtime not ready')],
    ['sidecar exec plane not ready', () => new Error('sidecar exec plane not ready')],
    ['terminal service not ready', () => new Error('terminal service not ready')],
  ])('retries exec readiness message with context: %s', async (_label, makeError) => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        if (calls === 1) throw makeError()
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const box = fakeBox({ exec })
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], { paceMs: 0 })

      await vi.advanceTimersByTimeAsync(2_000)
      const res = await promise

      expect(res.succeeded).toBe(true)
      expect(calls).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails loud immediately on a non-retryable thrown error (no retry)', async () => {
    let calls = 0
    const exec = vi.fn().mockImplementation(async () => {
      calls++
      const err = Object.assign(new Error('bad request'), { status: 400, code: 'bad_request' })
      throw err
    })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], { paceMs: 0 })
    expect(res.succeeded).toBe(false)
    // Exactly one attempt — deterministic/non-transient transport errors are not retried.
    expect(calls).toBe(1)
    if (!res.succeeded) expect(res.error.message).toContain('exec failed')
  })

  it('persistent retryable exec failures exhaust retries and preserve the cause', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const cause = Object.assign(new Error('Service Unavailable'), { status: 503, code: 'server_error' })
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        throw cause
      })
      const box = fakeBox({ exec })
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], {
        maxRetries: 2,
        paceMs: 0,
      })

      await vi.advanceTimersByTimeAsync(2_000)
      const res = await promise

      expect(res.succeeded).toBe(false)
      expect(calls).toBe(3)
      if (!res.succeeded) {
        expect(res.error.message).toContain('exec failed for skills/x.md')
        expect(res.error.cause).toBe(cause)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a hung exec, retries with backoff, then succeeds (no infinite park)', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      // The first exec HANGS forever (never resolves) — the proxy wedge. The
      // client-side timeout must abandon it and retry; the retry succeeds.
      const exec = vi.fn().mockImplementation(
        () =>
          new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
            calls++
            if (calls === 1) return // hang: never settle
            resolve({ stdout: '', stderr: '', exitCode: 0 })
          }),
      )
      const box = fakeBox({ exec })
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], {
        execTimeoutMs: 1000,
        paceMs: 0,
      })
      // Drive past the 1s exec timeout (abandons the hang) + the first backoff.
      await vi.advanceTimersByTimeAsync(1000 + 250 + 50)
      const res = await promise
      expect(res.succeeded).toBe(true)
      // hung attempt 1 + retry of the same step (2) + append + decode = 4 execs.
      expect(calls).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a persistently-hanging exec fails fast after the retry bound (not an infinite hang), timeout as cause', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      // Every exec hangs forever — a fully-wedged channel. The loop must give up
      // after maxRetries and fail loud with the timeout as cause, NOT hang.
      const exec = vi.fn().mockImplementation(() => {
        calls++
        return new Promise<never>(() => {}) // never settles
      })
      const box = fakeBox({ exec })
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], {
        execTimeoutMs: 1000,
        maxRetries: 2,
        paceMs: 0,
      })
      // Advance well past all (timeout + backoff) cycles: the whole thing must
      // settle to a rejected-as-Outcome result in bounded time.
      await vi.advanceTimersByTimeAsync(60_000)
      const res = await promise
      expect(res.succeeded).toBe(false)
      // Initial attempt + 2 retries = 3 exec invocations on the first step,
      // then the loop stops — it never reaches the append/decode steps.
      expect(calls).toBe(3)
      if (!res.succeeded) {
        expect(res.error.message).toContain('exec failed')
        // The wedged exec surfaces as the Outcome cause (a timeout), so callers
        // see WHY provisioning failed instead of an opaque 140s park.
        const cause = res.error.cause as Error
        expect(cause).toBeInstanceOf(Error)
        expect(cause.name).toBe('ProfileWriteExecTimeoutError')
        expect(cause.message).toContain('1000ms')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('paces execs: a delay elapses between consecutive execs (throttle avoidance)', async () => {
    vi.useFakeTimers()
    try {
      const callTimes: number[] = []
      const exec = vi.fn().mockImplementation(async () => {
        callTimes.push(Date.now())
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const box = fakeBox({ exec })
      // One small file = 3 execs (truncate, append, decode). With paceMs=200,
      // the 2nd and 3rd execs must each be ~200ms after the prior one.
      const promise = writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], {
        paceMs: 200,
      })
      await vi.advanceTimersByTimeAsync(1000)
      const res = await promise
      expect(res.succeeded).toBe(true)
      expect(callTimes.length).toBe(3)
      // No pace before the first exec; a pace before each subsequent exec.
      expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(200)
      expect(callTimes[2]! - callTimes[1]!).toBeGreaterThanOrEqual(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards the per-exec timeout to the SDK exec call (defense-in-depth)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], {
      execTimeoutMs: 12_345,
      paceMs: 0,
    })
    expect(res.succeeded).toBe(true)
    for (const call of exec.mock.calls) {
      expect(call[1]).toMatchObject({ timeoutMs: 12_345 })
    }
  })

  it('ensureWorkspaceSandbox: deferred files are stripped from create payload and written post-running', async () => {
    vi.useFakeTimers()
    try {
      listMock.mockResolvedValue([])
      let calls = 0
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        if (calls === 1) {
          const err = Object.assign(new Error('Service Unavailable'), { status: 503, code: 'server_error' })
          throw err
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      })
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
      const promise = ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

      await vi.advanceTimersByTimeAsync(2_000)
      await promise

      const payload = createMock.mock.calls[0]![0]
      // Inline files stripped from the create payload.
      expect(payload.backend.profile.resources.files).toEqual([])
      // ...and written into the box afterward; first exec retried once after a transient 503.
      expect(exec).toHaveBeenCalledTimes(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ensureWorkspaceSandbox: retries deferred writes on a reused box', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const running = fakeBox({ name: 'box-w1', metadata: { harness: 'opencode' }, exec })
      listMock.mockResolvedValue([running])
      const filesProfile = {
        name: 'p',
        resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
      } as unknown as AgentProfile
      const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
        deferProfileFiles: true,
        profile: () => filesProfile,
      })
      const promise = ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

      await vi.advanceTimersByTimeAsync(2_000)
      const box = await promise

      expect(box).toBe(running)
      expect(createMock).not.toHaveBeenCalled()
      expect(exec).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ensureWorkspaceSandbox: reused box with a matching corpus hash SKIPS the deferred re-write', async () => {
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const { deferredFiles } = splitDeferredProfileFiles(filesProfile)
    const hash = deferredCorpusHash(deferredFiles)
    const writeMany = vi.fn().mockResolvedValue(undefined)
    // Reused box already carries the corpus hash it was created with; liveness
    // exec answers 'alive'. The re-write (writeMany) must NOT fire.
    const running = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode', agentAppDeferredCorpusHash: hash },
      exec: vi.fn().mockResolvedValue({ stdout: 'alive', stderr: '', exitCode: 0 }),
      fs: { writeMany, supportsWriteMode: () => true } as never,
    })
    listMock.mockResolvedValue([running])
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const box = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

    expect(box).toBe(running)
    expect(createMock).not.toHaveBeenCalled()
    expect(writeMany).not.toHaveBeenCalled()
  })

  it('ensureWorkspaceSandbox: retries deferred writes on a resumed box', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const exec = vi.fn().mockImplementation(async () => {
        calls++
        if (calls === 1) throw Object.assign(new Error('sidecar not ready'), { status: 425 })
        return { stdout: '', stderr: '', exitCode: 0 }
      })
      const stopped = fakeBox({ name: 'box-w1', metadata: { harness: 'opencode' }, resume: vi.fn(), exec })
      listMock.mockImplementation(({ status }: { status: string }) =>
        status === 'running'
          ? Promise.resolve([])
          : status === 'stopped'
            ? Promise.resolve([stopped])
            : Promise.resolve([]),
      )
      const filesProfile = {
        name: 'p',
        resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
      } as unknown as AgentProfile
      const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
        deferProfileFiles: true,
        profile: () => filesProfile,
      })
      const promise = ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

      await vi.advanceTimersByTimeAsync(2_000)
      const box = await promise

      expect(box).toBe(stopped)
      expect(stopped.resume).toHaveBeenCalledOnce()
      expect(createMock).not.toHaveBeenCalled()
      expect(exec).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ensureWorkspaceSandbox: refreshes missing runtime auth before deferred writes on a reused box', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const running = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      connection: { runtimeUrl: 'https://rt' } as never,
    })
    const refreshed = fakeBox({
      id: running.id,
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      exec,
    })
    listMock.mockResolvedValue([running])
    getMock.mockResolvedValue(refreshed)
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const box = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

    expect(box).toBe(refreshed)
    expect(running.refresh).toHaveBeenCalledOnce()
    expect(getMock).toHaveBeenCalledWith(running.id)
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('ensureWorkspaceSandbox: refreshes expired runtime auth before deferred writes on a resumed box', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const stopped = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      resume: vi.fn(),
      connection: {
        runtimeUrl: 'https://rt',
        authToken: 'expired-runtime-token',
        authTokenExpiresAt: '2000-01-01T00:00:00.000Z',
      } as never,
    })
    const refreshed = fakeBox({
      id: stopped.id,
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      exec,
    })
    listMock.mockImplementation(({ status }: { status: string }) =>
      status === 'running'
        ? Promise.resolve([])
        : status === 'stopped'
          ? Promise.resolve([stopped])
          : Promise.resolve([]),
    )
    getMock.mockResolvedValue(refreshed)
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const box = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

    expect(box).toBe(refreshed)
    expect(stopped.resume).toHaveBeenCalledOnce()
    expect(stopped.refresh).toHaveBeenCalledOnce()
    expect(getMock).toHaveBeenCalledWith(stopped.id)
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('ensureWorkspaceSandbox: tokenless reused box still attempts deferred write when exec works', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const running = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      connection: { runtimeUrl: 'https://rt' } as never,
      exec,
    })
    listMock.mockResolvedValue([running])
    getMock.mockResolvedValue(undefined)
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const box = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

    expect(box).toBe(running)
    expect(running.refresh).toHaveBeenCalledOnce()
    expect(getMock).toHaveBeenCalledWith(running.id)
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('ensureWorkspaceSandbox: tokenless resumed box still attempts deferred write when exec works', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const stopped = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      connection: { runtimeUrl: 'https://rt' } as never,
      resume: vi.fn(),
      exec,
    })
    listMock.mockImplementation(({ status }: { status: string }) =>
      status === 'running'
        ? Promise.resolve([])
        : status === 'stopped'
          ? Promise.resolve([stopped])
          : Promise.resolve([]),
    )
    getMock.mockResolvedValue(undefined)
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const box = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

    expect(box).toBe(stopped)
    expect(stopped.resume).toHaveBeenCalledOnce()
    expect(stopped.refresh).toHaveBeenCalledOnce()
    expect(getMock).toHaveBeenCalledWith(stopped.id)
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('ensureWorkspaceSandbox: refresh 403 during best-effort auth refresh fails typed without writing', async () => {
    const denied = Object.assign(new Error('forbidden'), { status: 403 })
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const running = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      connection: { runtimeUrl: 'https://rt' } as never,
      refresh: vi.fn().mockRejectedValue(denied),
      exec,
    })
    listMock.mockResolvedValue([running])
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const err = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
      .catch((error: Error) => error)
    const thrown = err as Error

    expect(thrown.message).toContain(
      'deferred file write failed on reused box box-w1: reused sandbox auth refresh failed for box-w1: runtime exec auth refresh was unauthorized',
    )
    expect(thrown.cause).toBeInstanceOf(SandboxRuntimeAuthRefreshError)
    expect((thrown.cause as Error).cause).toBe(denied)
    expect(running.refresh).toHaveBeenCalledOnce()
    expect(getMock).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })

  it('ensureWorkspaceSandbox: get 403 during best-effort auth refresh fails typed without writing', async () => {
    const denied = Object.assign(new Error('forbidden'), { status: 403 })
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const running = fakeBox({
      name: 'box-w1',
      metadata: { harness: 'opencode' },
      connection: { runtimeUrl: 'https://rt' } as never,
      exec,
    })
    listMock.mockResolvedValue([running])
    getMock.mockRejectedValue(denied)
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const err = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
      .catch((error: Error) => error)
    const thrown = err as Error

    expect(thrown.message).toContain(
      'deferred file write failed on reused box box-w1: reused sandbox auth refresh failed for box-w1: runtime exec auth re-fetch was unauthorized',
    )
    expect(thrown.cause).toBeInstanceOf(SandboxRuntimeAuthRefreshError)
    expect((thrown.cause as Error).cause).toBe(denied)
    expect(running.refresh).toHaveBeenCalledOnce()
    expect(getMock).toHaveBeenCalledWith(running.id)
    expect(exec).not.toHaveBeenCalled()
  })

  it('ensureWorkspaceSandbox: refreshes runtime auth after one deferred-write 401 and retries idempotently', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-app-profile-write-auth-'))
    let calls = 0
    const exec = vi.fn().mockImplementation(async (cmd: string) => {
      calls++
      try {
        const output = await execFileAsync('bash', ['-lc', cmd], { cwd, timeout: 5000 })
        if (calls === 2) {
          throw Object.assign(new Error('Missing or invalid authentication'), {
            status: 401,
            code: 'AUTH_ERROR',
          })
        }
        return { stdout: String(output.stdout), stderr: String(output.stderr), exitCode: 0 }
      } catch (err) {
        const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown; status?: unknown }
        if (e.status === 401) throw err
        return {
          stdout: typeof e.stdout === 'string' ? e.stdout : '',
          stderr: typeof e.stderr === 'string' ? e.stderr : '',
          exitCode: typeof e.code === 'number' ? e.code : 1,
        }
      }
    })
    try {
      const running = fakeBox({ name: 'box-w1', metadata: { harness: 'opencode' }, exec })
      listMock.mockResolvedValue([running])
      const filesProfile = {
        name: 'p',
        resources: { files: [inlineMount('skills/seo.md', 'abc')] },
      } as unknown as AgentProfile
      const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
        deferProfileFiles: true,
        profile: () => filesProfile,
      })

      const box = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })

      expect(box).toBe(running)
      expect(running.refresh).toHaveBeenCalledOnce()
      expect(exec).toHaveBeenCalledTimes(5)
      await expect(readFsFile(join(cwd, 'skills/seo.md'), 'utf8')).resolves.toBe('abc')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('ensureWorkspaceSandbox: persistent deferred-write 401 after auth refresh is typed and bounded', async () => {
    const authError = Object.assign(new Error('Missing or invalid authentication'), {
      status: 401,
      code: 'AUTH_ERROR',
    })
    const exec = vi.fn().mockRejectedValue(authError)
    const running = fakeBox({ name: 'box-w1', metadata: { harness: 'opencode' }, exec })
    listMock.mockResolvedValue([running])
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const err = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
      .catch((error: Error) => error)
    const thrown = err as Error

    expect(thrown.message).toContain(
      'deferred file write failed on reused box box-w1: reused sandbox auth refresh failed for box-w1: runtime exec remained unauthorized after auth refresh',
    )
    expect(thrown.cause).toBeInstanceOf(SandboxRuntimeAuthRefreshError)
    expect(((thrown.cause as Error).cause as Error).cause).toBe(authError)
    expect(running.refresh).toHaveBeenCalledOnce()
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('ensureWorkspaceSandbox: shell failures with auth-like path/stderr do not refresh auth or retry', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'unauthorized content in generated file',
      exitCode: 1,
    })
    const running = fakeBox({ name: 'box-w1', metadata: { harness: 'opencode' }, exec })
    listMock.mockResolvedValue([running])
    const filesProfile = {
      name: 'p',
      resources: { files: [inlineMount('skills/http-401.md', '# SEO')] },
    } as unknown as AgentProfile
    const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
      deferProfileFiles: true,
      profile: () => filesProfile,
    })

    const err = await ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
      .catch((error: Error) => error)
    const thrown = err as Error

    expect(thrown.message).toContain('failed to write skills/http-401.md')
    expect(thrown.message).toContain('unauthorized content')
    expect(thrown.cause).not.toBeInstanceOf(SandboxRuntimeAuthRefreshError)
    expect(running.refresh).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('ensureWorkspaceSandbox: deferred write failure includes failed path and cause chain', async () => {
    vi.useFakeTimers()
    try {
      listMock.mockResolvedValue([])
      const cause = Object.assign(new Error('Service Unavailable'), { status: 503, code: 'server_error' })
      const exec = vi.fn().mockRejectedValue(cause)
      const created = fakeBox({ waitFor: vi.fn(), refresh: vi.fn(), exec, connection: { runtimeUrl: 'x' } as never })
      createMock.mockResolvedValue(created)
      const filesProfile = {
        name: 'p',
        resources: { files: [inlineMount('skills/seo.md', '# SEO')] },
      } as unknown as AgentProfile
      const shell = shellFor({ apiKey: 'k', baseUrl: 'u' }, {
        deferProfileFiles: true,
        resumeStopped: false,
        profile: () => filesProfile,
      })
      const promise = ensureWorkspaceSandbox(shell, { workspaceId: 'w1', harness: 'opencode' })
        .catch((err: Error) => err)

      await vi.advanceTimersByTimeAsync(60_000)
      const err = await promise
      expect(err).toBeInstanceOf(Error)
      const thrown = err as Error

      expect(thrown.message).toContain(
        'deferred file write failed on new box box-w1: writeProfileFilesToBox: exec failed for skills/seo.md',
      )
      expect((thrown.cause as Error).cause).toBe(cause)
    } finally {
      vi.useRealTimers()
    }
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

describe('writeProfileFilesToBox — file API transport', () => {
  const inlineMount = (path: string, content: string, executable?: boolean): AgentProfileFileMount => ({
    path,
    resource: { kind: 'inline', name: path, content },
    ...(executable !== undefined ? { executable } : {}),
  })

  // A box exposing BOTH mode-aware box.fs.writeMany (file API batch) and
  // box.exec, so the transport choice is asserted by which mock received the
  // mounts. Pacing + transient-retry live INSIDE the SDK's writeMany, so these
  // tests assert the batch hand-off, not per-file retry.
  const dualBox = (
    over: { writeMany?: ReturnType<typeof vi.fn>; exec?: ReturnType<typeof vi.fn> } = {},
  ) => {
    const writeMany = over.writeMany ?? vi.fn().mockResolvedValue(undefined)
    const exec = over.exec ?? vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec, fs: { supportsWriteMode: true, writeMany } } as unknown as Partial<SandboxInstance>)
    return { box, writeMany, exec }
  }

  it('batches a relative, non-executable file through writeMany (one call, no exec)', async () => {
    const { box, writeMany, exec } = dualBox()
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/seo.md', '# SEO')], { paceMs: 0 })
    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledTimes(1)
    expect(writeMany).toHaveBeenCalledWith(
      [{ path: 'skills/seo.md', content: '# SEO' }],
      expect.objectContaining({ paceMs: 0 }),
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('routes the GTM-scale relative corpus through ONE writeMany batch (no exec, no quota)', async () => {
    const { box, writeMany, exec } = dualBox()
    const files = Array.from({ length: 48 }, (_, i) => inlineMount(`skills/gtm/file-${i}.md`, `# ${i}`))
    const res = await writeProfileFilesToBox(box, files, { paceMs: 0 })
    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledTimes(1)
    expect(writeMany.mock.calls[0]![0]).toHaveLength(48) // all 48 in one batch
    expect(exec).not.toHaveBeenCalled()
  })

  it('batches executable and bin-dir files with executable mode, no exec', async () => {
    const { box, writeMany, exec } = dualBox()
    const res = await writeProfileFilesToBox(
      box,
      [
        inlineMount('skills/run.sh', '#!/bin/sh\n', true),
        inlineMount('bin/tool', 'x'),
      ],
      { paceMs: 0 },
    )
    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledTimes(1)
    expect(writeMany.mock.calls[0]![0]).toEqual([
      { path: 'skills/run.sh', content: '#!/bin/sh\n', mode: 0o755 },
      { path: 'bin/tool', content: 'x', mode: 0o755 },
    ])
    expect(exec).not.toHaveBeenCalled()
  })

  it('keeps executable files on exec when writeMany is not mode-aware', async () => {
    const writeMany = vi.fn().mockResolvedValue(undefined)
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec, fs: { writeMany } } as unknown as Partial<SandboxInstance>)
    const res = await writeProfileFilesToBox(
      box,
      [inlineMount('skills/run.sh', '#!/bin/sh\n', true)],
      { paceMs: 0 },
    )
    expect(res.succeeded).toBe(true)
    expect(writeMany).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalled()
  })

  it('keeps absolute and unsafe paths on the exec path', async () => {
    const { box, writeMany, exec } = dualBox()
    const res = await writeProfileFilesToBox(
      box,
      [
        inlineMount('/usr/local/bin/gtm', 'x'), // absolute outside workspace home
        inlineMount('~weird', 'x'), // bare ~ / ~user form
        inlineMount('~//escape', 'x'), // malformed home-relative absolute target
        inlineMount('/home/agent//escape', 'x'), // malformed home absolute target
        inlineMount('skills/../escape.md', 'x'), // .. segment
        inlineMount('skills/.sidecar/x', 'x'), // .sidecar segment
      ],
      { paceMs: 0 },
    )
    expect(res.succeeded).toBe(true)
    expect(writeMany).not.toHaveBeenCalled() // nothing file-API-eligible
    expect(exec).toHaveBeenCalled()
  })

  it('batches ~/-relative files via writeMany with the home prefix stripped', async () => {
    const { box, writeMany, exec } = dualBox()
    const res = await writeProfileFilesToBox(
      box,
      [inlineMount('~/.claude/skills/vault-audit/SKILL.md', '# audit')],
      { paceMs: 0 },
    )
    expect(res.succeeded).toBe(true)
    // $HOME == workspace root in agent sandboxes, so the home-relative mount is
    // written as a workspace-relative path (the `~/` prefix stripped).
    expect(writeMany).toHaveBeenCalledTimes(1)
    expect(writeMany).toHaveBeenCalledWith(
      [{ path: '.claude/skills/vault-audit/SKILL.md', content: '# audit' }],
      expect.objectContaining({ paceMs: 0 }),
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('batches /home/agent absolute files via writeMany with the home prefix stripped', async () => {
    const { box, writeMany, exec } = dualBox()
    const res = await writeProfileFilesToBox(
      box,
      [inlineMount('/home/agent/tools/gtm-agent/bin/gtm', '#!/bin/sh\necho gtm\n', true)],
      { paceMs: 0 },
    )
    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledTimes(1)
    expect(writeMany).toHaveBeenCalledWith(
      [{ path: 'tools/gtm-agent/bin/gtm', content: '#!/bin/sh\necho gtm\n', mode: 0o755 }],
      expect.objectContaining({ paceMs: 0 }),
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('partitions a mixed corpus: workspace files batch via writeMany, unsupported paths via exec', async () => {
    const { box, writeMany, exec } = dualBox()
    const res = await writeProfileFilesToBox(
      box,
      [inlineMount('skills/a.md', 'A'), inlineMount('bin/tool', 'x'), inlineMount('/usr/local/bin/gtm', 'G')],
      { paceMs: 0 },
    )
    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledTimes(1)
    expect(writeMany.mock.calls[0]![0]).toEqual([
      { path: 'skills/a.md', content: 'A' },
      { path: 'bin/tool', content: 'x', mode: 0o755 },
    ])
    expect(exec).toHaveBeenCalled() // /usr/local/bin/gtm cannot use workspace file API
  })

  it('rewrites reused executable profile files via writeMany without bash/base64 exec', async () => {
    const { box, writeMany, exec } = dualBox()
    const res = await writeProfileFilesToBox(
      box,
      [inlineMount('skills/reused-tool.sh', '#!/bin/sh\necho reused\n', true)],
      { paceMs: 0 },
    )

    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledWith(
      [{ path: 'skills/reused-tool.sh', content: '#!/bin/sh\necho reused\n', mode: 0o755 }],
      expect.objectContaining({ paceMs: 0 }),
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('fails loud with the cause when writeMany rejects (SDK owns the retry)', async () => {
    const quota = Object.assign(new Error('Too many requests'), { status: 429, code: 'QUOTA_EXCEEDED' })
    const writeMany = vi.fn().mockRejectedValue(quota)
    const { box } = dualBox({ writeMany })
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/x.md', 'x')], { paceMs: 0 })
    expect(res.succeeded).toBe(false)
    if (res.succeeded) return
    expect(res.error.message).toContain('file-API batch write failed')
    // Cause preserved so the runtime-auth-refresh wrapper still sees a 401/etc.
    expect(res.error.cause).toBe(quota)
  })

  it('falls back to the exec path when the SDK exposes no writeMany', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec }) // no box.fs
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/seo.md', '# SEO')], { paceMs: 0 })
    expect(res.succeeded).toBe(true)
    expect(exec).toHaveBeenCalled() // relative file went via exec because box.fs.writeMany is absent
  })

  it('writes a large relative file in a single batched request (no chunking)', async () => {
    const { box, writeMany, exec } = dualBox()
    const big = 'x'.repeat(50_000)
    const res = await writeProfileFilesToBox(box, [inlineMount('skills/big.md', big)], { paceMs: 0 })
    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledTimes(1)
    expect(writeMany).toHaveBeenCalledWith(
      [{ path: 'skills/big.md', content: big }],
      expect.objectContaining({ paceMs: 0 }),
    )
    expect(exec).not.toHaveBeenCalled()
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

  it('writes default tool mounts through the file API', async () => {
    const writeMany = vi.fn().mockResolvedValue(undefined)
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    const box = fakeBox({ exec, fs: { supportsWriteMode: true, writeMany } } as unknown as Partial<SandboxInstance>)
    const files = buildSandboxToolFileMounts({
      appName: 'gtm-agent',
      tools: [{ name: 'gtm', content: '#!/bin/sh\necho hi' }],
    })

    const res = await writeProfileFilesToBox(box, files, { paceMs: 0 })

    expect(res.succeeded).toBe(true)
    expect(writeMany).toHaveBeenCalledWith(
      [{ path: 'tools/gtm-agent/bin/gtm', content: '#!/bin/sh\necho hi', mode: 0o755 }],
      expect.objectContaining({ paceMs: 0 }),
    )
    expect(exec).not.toHaveBeenCalled()
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

describe('peekWorkspaceSandbox', () => {
  const peekShell = () =>
    shellFor({ apiKey: 'k', baseUrl: 'https://s' }, {
      name: (workspaceId: string) => `display-${workspaceId}`,
      boxKey: (scope: { workspaceId: string }) => `app:workspace:${scope.workspaceId}`,
    })

  it('never provisions, resumes, or deletes — it only lists', async () => {
    const box = fakeBox({ name: 'app:workspace:w1', status: 'running' })
    listMock.mockResolvedValue([box])

    const peek = await peekWorkspaceSandbox(peekShell(), { workspaceId: 'w1' })

    expect(peek).toEqual({ status: 'running', box })
    expect(createMock).not.toHaveBeenCalled()
    expect(box.delete).not.toHaveBeenCalled()
    expect(box.waitFor).not.toHaveBeenCalled()
    // One unfiltered list: absent vs stopped is the whole question, and a
    // status-filtered listing cannot answer it.
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(listMock.mock.calls[0]![0]).toBeUndefined()
  })

  it('matches on the box key', async () => {
    const box = fakeBox({ name: 'app:workspace:w1', status: 'running' })
    listMock.mockResolvedValue([fakeBox({ name: 'app:workspace:other' }), box])

    await expect(peekWorkspaceSandbox(peekShell(), { workspaceId: 'w1' }))
      .resolves.toEqual({ status: 'running', box })
  })

  it('matches on the display name too — a box may surface under either', async () => {
    const box = fakeBox({ name: 'display-w1', status: 'running' })
    listMock.mockResolvedValue([box])

    await expect(peekWorkspaceSandbox(peekShell(), { workspaceId: 'w1' }))
      .resolves.toEqual({ status: 'running', box })
  })

  it('reports absent when no box carries either identity', async () => {
    listMock.mockResolvedValue([fakeBox({ name: 'app:workspace:w2', status: 'running' })])

    await expect(peekWorkspaceSandbox(peekShell(), { workspaceId: 'w1' }))
      .resolves.toEqual({ status: 'absent' })
  })

  it('reports not-running with the platform state for a box that is there but stopped', async () => {
    const box = fakeBox({ name: 'app:workspace:w1', status: 'stopped' })
    listMock.mockResolvedValue([box])

    await expect(peekWorkspaceSandbox(peekShell(), { workspaceId: 'w1' }))
      .resolves.toEqual({ status: 'not-running', state: 'stopped', box })
  })

  it('resolves credentials through the same scoped seam as ensure', async () => {
    const credentials = vi.fn().mockResolvedValue({ apiKey: 'k', baseUrl: 'https://s' })
    listMock.mockResolvedValue([])

    await peekWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'https://s' }, { credentials }), {
      workspaceId: 'w1',
      userId: 'u1',
    })

    expect(credentials).toHaveBeenCalledWith({ workspaceId: 'w1', userId: 'u1' })
  })

  it('fails loud when the shell cannot produce credentials', async () => {
    await expect(
      peekWorkspaceSandbox(shellFor({ apiKey: 'k', baseUrl: 'https://s' }, { credentials: async () => null }), {
        workspaceId: 'w1',
      }),
    ).rejects.toThrow(/credentials are required/)
  })
})
