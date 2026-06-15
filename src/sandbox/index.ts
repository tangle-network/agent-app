import {
  Sandbox,
  type AgentProfile,
  type AgentProfileFileMount,
  type AgentProfileMcpServer,
  type SandboxInstance,
  type ScopedTokenScope,
} from '@tangle-network/sandbox'
import {
  buildAppToolMcpServer,
  type AppToolName,
  type AppToolContext,
  type ToolHeaderNames,
} from '../tools/index'
import type { Harness } from '../harness/index'

export type Outcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: Error }

const ok = <T>(value: T): Outcome<T> => ({ succeeded: true, value })
const fail = (error: unknown): Outcome<never> => ({
  succeeded: false,
  error: error instanceof Error ? error : new Error(String(error)),
})

export interface SandboxClientCredentials {
  apiKey: string
  baseUrl: string
}

export interface SandboxResourceConfig {
  image: string
  cpuCores: number
  memoryMB: number
  diskGB: number
  maxLifetimeSeconds: number
  idleTimeoutSeconds: number
}

export interface ProviderResolutionConfig {
  routerBaseUrl?: string
  apiKey?: string
  providerName?: string
  modelName?: string
  defaultModel?: string
  openaiApiKey?: string
}

export interface SandboxBuildContext {
  workspaceId: string
  connectedIntegrationIds: string[]
}

export interface ProfileComposeOptions {
  systemPrompt?: string
  extraFiles?: AgentProfileFileMount[]
  extraMcp?: Record<string, AgentProfileMcpServer>
  name?: string
}

export interface SandboxRuntimeConfig {
  credentials: () => SandboxClientCredentials | null
  name: (workspaceId: string) => string
  metadata: (harness: Harness) => Record<string, unknown>
  connectedIntegrationIds: (workspaceId: string) => Promise<string[]>
  env: (ctx: SandboxBuildContext) => Promise<Record<string, string>>
  files: (ctx: SandboxBuildContext) => Promise<AgentProfileFileMount[]>
  secrets: (workspaceId: string) => Promise<string[]>
  profile: (options: ProfileComposeOptions) => AgentProfile
  permissionRole?: (workspaceRole: string) => SandboxPermissionLevel
  resources?: SandboxResourceConfig
  provider?: ProviderResolutionConfig
}

export const DEFAULT_SANDBOX_RESOURCES: SandboxResourceConfig = {
  image: 'universal',
  cpuCores: 2,
  memoryMB: 4096,
  diskGB: 10,
  maxLifetimeSeconds: 86400,
  idleTimeoutSeconds: 3600,
}

interface ClientCacheEntry {
  client: Sandbox
  fingerprint: string
}

let _cached: ClientCacheEntry | null = null

export function getClient(shell: SandboxRuntimeConfig): Sandbox {
  const creds = shell.credentials()
  if (!creds) throw new Error('sandbox credentials are required (apiKey/baseUrl)')

  const fingerprint = `${creds.apiKey} ${creds.baseUrl}`
  if (_cached && _cached.fingerprint === fingerprint) return _cached.client

  const client = new Sandbox({ apiKey: creds.apiKey, baseUrl: creds.baseUrl })
  _cached = { client, fingerprint }
  return client
}

export function resetClientCache(): void {
  _cached = null
}

export interface AppToolDescriptor {
  tool: AppToolName
  key: string
  description: string
}

export interface BuildAppToolMcpServersOptions {
  tools: AppToolDescriptor[]
  baseUrl: string
  token: string
  ctx: AppToolContext
  headerNames?: ToolHeaderNames
}

export function buildAppToolMcpServers(
  options: BuildAppToolMcpServersOptions,
): Record<string, AgentProfileMcpServer> {
  const entries: Record<string, AgentProfileMcpServer> = {}
  for (const { tool, key, description } of options.tools) {
    entries[key] = buildAppToolMcpServer({
      tool,
      baseUrl: options.baseUrl,
      token: options.token,
      ctx: options.ctx,
      description,
      headerNames: options.headerNames,
    }) as AgentProfileMcpServer
  }
  return entries
}

export interface EnsureWorkspaceSandboxOptions {
  workspaceId: string
  userId?: string
  harness: Harness
}

async function listRunning(
  client: Sandbox,
  name: string,
): Promise<Outcome<SandboxInstance | null>> {
  try {
    const running = await client.list({ status: 'running' })
    return ok(running.find((s) => s.name === name) ?? null)
  } catch (err) {
    return fail(err)
  }
}

async function deleteBox(box: SandboxInstance): Promise<Outcome<void>> {
  try {
    await box.delete()
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

// The SDK narrows `backend.type` to its own BackendType union and
// `initialUsers[].role` to PermissionLevel — neither symbol is exported. The
// create payload is assembled with the product's Harness/role strings, which
// are a superset surface; the localized cast at the boundary is the only place
// this widening is allowed, and the runtime contract (the sidecar boots the
// named harness) is what enforces correctness.
type CreatePayload = Parameters<Sandbox['create']>[0]

export async function ensureWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
): Promise<SandboxInstance> {
  const { workspaceId, userId, harness } = options
  const client = getClient(shell)
  const name = shell.name(workspaceId)
  const resources = shell.resources ?? DEFAULT_SANDBOX_RESOURCES

  const existing = await listRunning(client, name)
  if (existing.succeeded && existing.value) {
    const found = existing.value
    if (found.metadata?.harness === harness) return found
    const dropped = await deleteBox(found)
    if (!dropped.succeeded) {
      throw new Error(
        `harness-mismatched sandbox ${name} ` +
          `(was ${String(found.metadata?.harness ?? 'unknown')}, want ${harness}) could not be deleted`,
        { cause: dropped.error },
      )
    }
  }

  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId)
  const buildCtx: SandboxBuildContext = { workspaceId, connectedIntegrationIds }
  const [secrets, env, files] = await Promise.all([
    shell.secrets(workspaceId),
    shell.env(buildCtx),
    shell.files(buildCtx),
  ])
  const profile = shell.profile({ extraFiles: files })

  const role = userId && shell.permissionRole ? shell.permissionRole('developer') : undefined

  const payload = {
    name,
    image: resources.image,
    metadata: shell.metadata(harness),
    ...(userId ? { permissions: { initialUsers: [{ userId, role }] } } : {}),
    env,
    secrets,
    backend: { type: harness, profile },
    maxLifetimeSeconds: resources.maxLifetimeSeconds,
    idleTimeoutSeconds: resources.idleTimeoutSeconds,
    resources: {
      cpuCores: resources.cpuCores,
      memoryMB: resources.memoryMB,
      diskGB: resources.diskGB,
    },
  } as CreatePayload

  const box = await client.create(payload)

  await box.waitFor('running', { timeoutMs: 120_000 })
  if (!box.connection?.runtimeUrl) await box.refresh()
  return box
}

export interface ResolvedModel {
  model: string
  provider: string
  apiKey: string
  baseUrl?: string
}

export function resolveModel(
  config: ProviderResolutionConfig | undefined,
  override?: { model?: string; modelApiKey?: string },
): ResolvedModel | undefined {
  const c = config ?? {}
  const explicitBaseUrl = c.routerBaseUrl
  const explicitApiKey = override?.modelApiKey ?? c.apiKey
  const provider =
    c.providerName ?? (explicitApiKey ? 'openai-compat' : c.openaiApiKey ? 'openai' : undefined)
  const modelName =
    override?.model ??
    c.modelName ??
    (provider === 'openai' || provider === 'openai-compat' ? c.defaultModel : undefined)
  const apiKey = explicitApiKey ?? (provider === 'openai' ? c.openaiApiKey : undefined)
  if (!provider || !modelName || !apiKey) return undefined
  return {
    model: modelName,
    provider,
    apiKey,
    ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
  }
}

export function flattenHistory(
  message: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history?.length) return message
  const transcript = history
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content}`)
    .join('\n\n')
  return `${transcript}\n\nUser: ${message}`
}

export function mergeExtraMcp(
  appToolMcp: Record<string, AgentProfileMcpServer>,
  baseProfileMcp: Record<string, AgentProfileMcpServer>,
  extra: Record<string, AgentProfileMcpServer> | undefined,
): Record<string, AgentProfileMcpServer> {
  for (const key of Object.keys(extra ?? {})) {
    if (key in appToolMcp || key in baseProfileMcp) {
      throw new Error(`extraMcp key '${key}' collides with an existing profile MCP server`)
    }
  }
  return { ...appToolMcp, ...(extra ?? {}) }
}

export function attachReasoningEffort(
  profile: AgentProfile,
  harness: Harness,
  effort: 'auto' | 'low' | 'medium' | 'high' | undefined,
): AgentProfile {
  if (!effort || effort === 'auto') return profile
  return {
    ...profile,
    extensions: {
      ...(profile.extensions ?? {}),
      [harness]: {
        ...(profile.extensions?.[harness] ?? {}),
        reasoningEffort: effort,
      },
    },
  }
}

export interface StreamSandboxPromptOptions {
  sessionId?: string
  executionId?: string
  lastEventId?: string
  systemPrompt?: string
  model?: string
  modelApiKey?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  harness?: Harness
  effort?: 'auto' | 'low' | 'medium' | 'high'
  appToolMcp?: Record<string, AgentProfileMcpServer>
  baseProfileMcp?: Record<string, AgentProfileMcpServer>
  extraMcp?: Record<string, AgentProfileMcpServer>
}

type StreamPromptOptions = Parameters<SandboxInstance['streamPrompt']>[1]

export async function* streamSandboxPrompt(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string,
  options?: StreamSandboxPromptOptions,
): AsyncGenerator<unknown> {
  const harness = options?.harness ?? 'opencode'
  const model = resolveModel(shell.provider, {
    model: options?.model,
    modelApiKey: options?.modelApiKey,
  })

  const prompt = flattenHistory(message, options?.history)

  const appToolMcp = options?.appToolMcp ?? {}
  const extraMcp = mergeExtraMcp(appToolMcp, options?.baseProfileMcp ?? {}, options?.extraMcp)

  const profile = shell.profile({ systemPrompt: options?.systemPrompt, extraMcp })
  const profileWithEffort = attachReasoningEffort(profile, harness, options?.effort)

  const stream = box.streamPrompt(prompt, {
    sessionId: options?.sessionId,
    executionId: options?.executionId,
    lastEventId: options?.lastEventId,
    backend: {
      type: harness,
      profile: profileWithEffort,
      ...(model ? { model } : {}),
    },
  } as StreamPromptOptions)

  for await (const event of stream) yield event
}

export async function runSandboxPrompt(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string,
  options?: StreamSandboxPromptOptions,
): Promise<string> {
  let fullText = ''
  let firstTextSeen = false

  for await (const rawEvent of streamSandboxPrompt(shell, box, message, options)) {
    const event = rawEvent as { type?: string; data?: Record<string, unknown> }
    if (!event.type) continue

    if (event.type === 'message.part.updated') {
      const part = event.data?.part as Record<string, unknown> | undefined
      const delta = typeof event.data?.delta === 'string' ? event.data.delta : null
      if (String(part?.type ?? '') === 'text') {
        if (!firstTextSeen) {
          firstTextSeen = true
          continue
        }
        if (delta) fullText += delta
        else if (typeof part?.text === 'string') fullText = part.text
      }
    } else if (event.type === 'result') {
      const finalText = typeof event.data?.finalText === 'string' ? event.data.finalText : null
      if (finalText) fullText = finalText
    }
  }

  return fullText
}

// Mirrors the SDK's PermissionLevel union (not re-exported by
// @tangle-network/sandbox). The product's role-mapping seam must produce one of
// these; binding the seam's return type to the union makes a wrong mapping a
// compile error rather than a runtime 400 from the orchestrator.
export type SandboxPermissionLevel = 'owner' | 'admin' | 'developer' | 'viewer'

export interface MemberSyncSeam {
  roleToSandboxRole: (workspaceRole: string) => SandboxPermissionLevel
}

export async function syncSandboxMemberAdd(
  box: SandboxInstance,
  seam: MemberSyncSeam,
  userId: string,
  role: string,
): Promise<Outcome<void>> {
  try {
    await box.permissions.add({ userId, role: seam.roleToSandboxRole(role) })
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

export async function syncSandboxMemberRemove(
  box: SandboxInstance,
  userId: string,
): Promise<Outcome<void>> {
  try {
    await box.permissions.remove(userId, { preserveHomeDir: true })
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

export async function syncSandboxMemberRole(
  box: SandboxInstance,
  seam: MemberSyncSeam,
  userId: string,
  role: string,
): Promise<Outcome<void>> {
  try {
    await box.permissions.update(userId, { role: seam.roleToSandboxRole(role) })
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

export interface SecretStore {
  create: (name: string, value: string) => Promise<void>
  update: (name: string, value: string) => Promise<void>
  get: (name: string) => Promise<string>
  delete: (name: string) => Promise<void>
}

export function secretStoreFromClient(shell: SandboxRuntimeConfig): SecretStore {
  const client = getClient(shell)
  return {
    create: async (name, value) => {
      await client.secrets.create(name, value)
    },
    update: async (name, value) => {
      await client.secrets.update(name, value)
    },
    get: (name) => client.secrets.get(name),
    delete: async (name) => {
      await client.secrets.delete(name)
    },
  }
}

export async function storeSecret(
  store: SecretStore,
  name: string,
  value: string,
): Promise<Outcome<void>> {
  try {
    await store.create(name, value)
    return ok(undefined)
  } catch {
    try {
      await store.update(name, value)
      return ok(undefined)
    } catch (err) {
      return fail(new Error(`Failed to store sandbox secret ${name}`, { cause: err }))
    }
  }
}

export async function readSecret(store: SecretStore, name: string): Promise<Outcome<string>> {
  try {
    return ok(await store.get(name))
  } catch (err) {
    return fail(err)
  }
}

export async function deleteSecret(store: SecretStore, name: string): Promise<Outcome<void>> {
  try {
    await store.delete(name)
    return ok(undefined)
  } catch (err) {
    return fail(err)
  }
}

export interface ScopedTokenResult {
  token: string
  expiresAt: Date
  scope: ScopedTokenScope
}

/**
 * Mint a scoped token for an already-provisioned box (e.g. to hand a terminal
 * proxy a narrowed credential). Uses the SDK's native `box.mintScopedToken`,
 * which normalizes `expiresAt` to a Date — no hand-rolled wire call.
 */
export async function mintSandboxScopedToken(
  box: SandboxInstance,
  options: { scope: ScopedTokenScope; sessionId?: string; ttlMinutes?: number },
): Promise<Outcome<ScopedTokenResult>> {
  try {
    const token = await box.mintScopedToken({
      scope: options.scope,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.ttlMinutes ? { ttlMinutes: options.ttlMinutes } : {}),
    })
    return ok({ token: token.token, expiresAt: token.expiresAt, scope: token.scope })
  } catch (err) {
    return fail(err)
  }
}