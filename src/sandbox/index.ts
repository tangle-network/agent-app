import {
  Sandbox,
  type AgentProfile,
  type AgentProfileFileMount,
  type AgentProfileMcpServer,
  type SandboxConnection,
  type SandboxInstance,
  type ScopedTokenScope,
  type StorageConfig,
  type PromptResult,
} from '@tangle-network/sandbox'
import {
  buildAppToolMcpServer,
  type AppToolName,
  type AppToolContext,
  type ToolHeaderNames,
} from '../tools/index'
import { assertHarnessModelCompatible, type Harness } from '../harness/index'
import { ok, fail, type Outcome } from './outcome'

export type { Outcome } from './outcome'

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
  userId?: string
}

// SDK-typed snapshot storage config (re-exported for product seam closures).
export type { StorageConfig }

// Scope handed to per-identity seams. workspaceId is always present; userId is
// present when the lifecycle op carries one. Workspace-keyed products ignore userId.
export interface SandboxScope {
  workspaceId: string
  userId?: string
}

// Snapshot RESTORE-on-create. Returned alongside storage; undefined => fresh box.
export interface SandboxRestoreSpec {
  fromSnapshot: string
  fromSandboxId: string
}

// Reuse health gate + sidecar liveness. The exec+timeout-race is generic; the
// sidecarProcessPattern is harness-specific (which process is the live sidecar),
// so it is a closure. Absent => no liveness probe (reuse on metadata.harness match).
export interface LivenessProbeConfig {
  sidecarProcessPattern: (harness: Harness) => string
  execTimeoutMs?: number
  psTimeoutMs?: number
}

export interface ProfileComposeOptions {
  systemPrompt?: string
  extraFiles?: AgentProfileFileMount[]
  extraMcp?: Record<string, AgentProfileMcpServer>
  name?: string
}

export interface SandboxRuntimeConfig {
  // Widened to accept an optional scope and be async so a per-user key can be
  // minted. The sync, no-arg form still satisfies the type (back-compat).
  credentials: (
    scope?: SandboxScope,
  ) => SandboxClientCredentials | null | Promise<SandboxClientCredentials | null>
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

  // BYOS3/R2 snapshot storage. Returns undefined => key omitted entirely
  // (fail-closed when creds absent). Product owns bucket/endpoint/credentials/prefix.
  storage?: (ctx: SandboxBuildContext) => StorageConfig | undefined
  // Snapshot RESTORE-on-create. undefined => fresh box.
  restore?: (ctx: SandboxBuildContext) => SandboxRestoreSpec | undefined
  // Per-identity box NAME. Defaults to name(scope.workspaceId) when absent.
  boxKey?: (scope: SandboxScope) => string
  // Per-workspace child-key mint: overrides the resolved model apiKey before create.
  // Applied only when a model is resolved and its provider is openai-compat.
  childKeyMint?: (scope: SandboxScope) => Promise<Outcome<string>>
  // One-shot post-running bootstrap, on BOTH create and reuse paths (idempotency
  // is the closure's job — it owns the marker check).
  bootstrap?: (box: SandboxInstance, scope: SandboxScope) => Promise<Outcome<void>>
  // Reuse health gate + sidecar liveness probe.
  livenessProbe?: LivenessProbeConfig
  // Enable browser terminal endpoints on newly-created sandboxes.
  webTerminalEnabled?: boolean
  // default true: try stopped-resume before create.
  resumeStopped?: boolean
  // default false: bake resolveModel() into backend.model at create.
  backendModelAtCreate?: boolean
  // default false: write the profile's `resources.files` INTO the box after it
  // reaches running (via `box.exec`), instead of inlining them in the create
  // payload. The orchestrator caps the provision body at 256 KiB; a large
  // file corpus (skills, tool scripts) blows that cap. Deferring it keeps the
  // provision body small and uncapped in corpus size, and lands real files on
  // disk — which is also the only path that works for harnesses whose backend
  // does not materialize the provider-neutral `resources.files` channel.
  //
  // Only `kind: 'inline'` files are deferred; non-inline refs (e.g. github)
  // stay in the create payload so the orchestrator resolves them. Runs on the
  // create AND resume/reuse paths (idempotent overwrite). Inline files are
  // STRIPPED from `resources.files` before create when this is set.
  deferProfileFiles?: boolean
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

function getClientFromCreds(creds: SandboxClientCredentials): Sandbox {
  const fingerprint = `${creds.apiKey} ${creds.baseUrl}`
  if (_cached && _cached.fingerprint === fingerprint) return _cached.client

  const client = new Sandbox({ apiKey: creds.apiKey, baseUrl: creds.baseUrl })
  _cached = { client, fingerprint }
  return client
}

// Sync client for non-scoped callers (secretStoreFromClient etc.). Resolves
// credentials with no scope; throws if the seam returns a Promise — scoped
// products must use the async ensureWorkspaceSandbox path.
export function getClient(shell: SandboxRuntimeConfig): Sandbox {
  const creds = shell.credentials()
  if (creds && typeof (creds as Promise<unknown>).then === 'function') {
    throw new Error('getClient: scoped (async) credentials require the async sandbox path')
  }
  if (!creds) throw new Error('sandbox credentials are required (apiKey/baseUrl)')
  return getClientFromCreds(creds as SandboxClientCredentials)
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
  // When set, both the running-reuse and stopped-resume short-circuits are
  // skipped and any name-matched box is deleted before create.
  forceNew?: boolean
}

// Single-quote a string for safe interpolation into a shell command.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Split a profile's `resources.files` into the inline mounts that can be
// written into a running box and the rest (non-inline refs that the
// orchestrator must resolve, so they stay in the create payload). Returns the
// inline set to defer and a profile copy with those inline files removed.
export function splitDeferredProfileFiles(
  profile: AgentProfile,
): { leanProfile: AgentProfile; deferredFiles: AgentProfileFileMount[] } {
  const files = profile.resources?.files ?? []
  const deferredFiles: AgentProfileFileMount[] = []
  const keptFiles: AgentProfileFileMount[] = []
  for (const mount of files) {
    if (mount.resource.kind === 'inline') deferredFiles.push(mount)
    else keptFiles.push(mount)
  }
  if (deferredFiles.length === 0) return { leanProfile: profile, deferredFiles }
  const leanProfile: AgentProfile = {
    ...profile,
    resources: { ...(profile.resources ?? {}), files: keptFiles },
  }
  return { leanProfile, deferredFiles }
}

// Materialize inline profile files into a running box via `box.exec`. Uses a
// base64 pipe so arbitrary content (scripts, unicode, special chars) lands
// byte-exact, and writes to ANY absolute path (e.g. /usr/local/bin) or a
// `~`-relative path — the exec runs as the sidecar, which is not bound by the
// safe-prefix allow-list the /files/write API enforces. Sets the executable
// bit when the mount declares it OR the target is a bin directory. One exec
// per file keeps a single bad mount from poisoning the batch; the first
// failure is returned (fail-loud), the rest are not attempted.
export async function writeProfileFilesToBox(
  box: SandboxInstance,
  files: AgentProfileFileMount[],
): Promise<Outcome<void>> {
  for (const mount of files) {
    if (mount.resource.kind !== 'inline') continue
    const content = mount.resource.content ?? ''
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const path = mount.path
    const dir = path.replace(/\/[^/]*$/, '')
    const isBin = /(^|\/)(s?bin)\//.test(path)
    const executable = mount.executable ?? isBin
    const q = shellSingleQuote(path)
    // mkdir -p handles `~` (the shell expands it); printf '%s' avoids a
    // trailing newline; base64 -d reconstructs the exact bytes.
    const mkdir = dir && dir !== path ? `mkdir -p ${shellSingleQuote(dir)} && ` : ''
    const chmod = executable ? ` && chmod +x ${q}` : ''
    const cmd = `${mkdir}printf '%s' ${shellSingleQuote(b64)} | base64 -d > ${q}${chmod}`
    try {
      const res = await box.exec(cmd)
      if (res.exitCode !== 0) {
        return fail(
          new Error(
            `writeProfileFilesToBox: failed to write ${path} (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
          ),
        )
      }
    } catch (err) {
      return fail(new Error(`writeProfileFilesToBox: exec failed for ${path}`, { cause: err }))
    }
  }
  return ok(undefined)
}

// Resolve the shell's deferred (inline) profile files and write them into a
// box that already exists (reuse/resume paths). No-op unless the shell opts
// into deferProfileFiles. Idempotent overwrite — a redeploy with new skills
// refreshes the corpus on the next ensure call.
async function materializeDeferredFilesForExistingBox(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  workspaceId: string,
  userId: string | undefined,
): Promise<Outcome<void>> {
  if (!shell.deferProfileFiles) return ok(undefined)
  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId)
  const buildCtx: SandboxBuildContext = {
    workspaceId,
    connectedIntegrationIds,
    ...(userId ? { userId } : {}),
  }
  const files = await shell.files(buildCtx)
  const fullProfile = shell.profile({ extraFiles: files })
  const { deferredFiles } = splitDeferredProfileFiles(fullProfile)
  if (deferredFiles.length === 0) return ok(undefined)
  return writeProfileFilesToBox(box, deferredFiles)
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

// Generic exec+sidecar liveness probe. Absent probe => always alive (the prior
// reuse-on-metadata-match behavior). With a probe: the container must answer an
// `echo alive` exec within execTimeoutMs, and the sidecar process must be found
// by pgrep within psTimeoutMs (an inconclusive pgrep is treated as reusable).
async function isBoxAlive(
  box: SandboxInstance,
  harness: Harness,
  probe: LivenessProbeConfig | undefined,
): Promise<boolean> {
  if (!probe) return true
  const execTimeout = probe.execTimeoutMs ?? 5000
  const psTimeout = probe.psTimeoutMs ?? 3000
  const race = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
    ])
  try {
    const alive = await race(box.exec('echo alive'), execTimeout, 'alive check timeout')
    if (!alive.stdout.includes('alive')) return false
    const pattern = probe.sidecarProcessPattern(harness)
    try {
      const ps = await race(
        box.exec(`pgrep -f ${shellSingleQuote(pattern)} || echo no-sidecar`),
        psTimeout,
        'ps check timeout',
      )
      if (ps.stdout.includes('no-sidecar')) return false
    } catch {
      // sidecar probe inconclusive — container is alive, treat as reusable
    }
    return true
  } catch {
    return false
  }
}

const RUNTIME_CONNECTION_WAIT_MS = 30_000
const RUNTIME_CONNECTION_POLL_MS = 1_000

// `sidecarUrl` is a product/forward-compat field the orchestrator may set on
// the connection ahead of the SDK declaring it — the v0.6 `SandboxConnection`
// exposes only `runtimeUrl`. Read it through a typed augmentation rather than an
// ad-hoc cast (a plain `SandboxConnection` satisfies the optional field), and
// fall back to the SDK runtime URL. The product-facing `WorkspaceSandboxInstanceLike`
// carries the same field for consumers driving their own box types.
type RuntimeConnectionFields = SandboxConnection & { sidecarUrl?: string }

function sandboxRuntimeUrl(box: SandboxInstance): string | undefined {
  const connection: RuntimeConnectionFields | undefined = box.connection
  return connection?.sidecarUrl ?? connection?.runtimeUrl
}

function sandboxEdgeFailed(box: SandboxInstance): boolean {
  // `edgeStatus`/`edgeError` are declared on the SDK's `SandboxConnection`, so no cast.
  const connection = box.connection
  return connection?.edgeStatus === 'failed' || Boolean(connection?.edgeError)
}

async function refreshRuntimeConnection(
  client: Sandbox,
  box: SandboxInstance,
): Promise<SandboxInstance> {
  let current = box
  if (sandboxRuntimeUrl(current)) return current

  const deadline = Date.now() + RUNTIME_CONNECTION_WAIT_MS
  while (Date.now() < deadline) {
    // Tolerate transient refresh/get failures (5xx, network blips) while the
    // orchestrator is still attaching the connection: swallow and retry. A box
    // that never surfaces a runtime URL is returned as-is so the caller's
    // readiness gate (isReusableBox) drops and recreates it — rather than this
    // poll throwing a hard provisioning failure on a recoverable hiccup.
    try {
      await current.refresh()
      if (sandboxRuntimeUrl(current)) return current

      const latest = await client.get(current.id)
      if (latest) current = latest
      if (sandboxRuntimeUrl(current)) return current
    } catch {
      // transient — fall through to the poll delay and retry
    }

    await new Promise((resolve) => setTimeout(resolve, RUNTIME_CONNECTION_POLL_MS))
  }

  return current
}

// Decide whether an existing (reused or resumed) box is safe to hand back.
// `refreshRuntimeConnection` has already polled for the runtime URL, so a box
// that still has none never became connectable and must be recreated rather
// than silently reused — downstream exec/terminal traffic would fail against
// it. A failed edge is likewise unusable. Only when the connection is present
// do we spend an exec round-trip on the liveness probe.
async function isReusableBox(
  box: SandboxInstance,
  harness: Harness,
  probe: LivenessProbeConfig | undefined,
): Promise<boolean> {
  if (sandboxEdgeFailed(box)) return false
  if (!sandboxRuntimeUrl(box)) return false
  return isBoxAlive(box, harness, probe)
}

// Resume a name-matched stopped box and wait for it to reach running. Returns
// ok(null) when no stopped box matches the name.
async function resumeStoppedBox(
  client: Sandbox,
  name: string,
  timeoutMs: number,
): Promise<Outcome<SandboxInstance | null>> {
  try {
    const stopped = await client.list({ status: 'stopped' })
    const match = stopped.find((s) => s.name === name) ?? null
    if (!match) return ok(null)
    await match.resume()
    await match.waitFor('running', { timeoutMs })
    return ok(match)
  } catch (err) {
    return fail(err)
  }
}

export async function ensureWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
): Promise<SandboxInstance> {
  const { workspaceId, userId, harness, forceNew } = options
  const scope: SandboxScope = { workspaceId, ...(userId ? { userId } : {}) }
  const creds = await shell.credentials(scope)
  if (!creds) throw new Error('sandbox credentials are required (apiKey/baseUrl)')
  const client = getClientFromCreds(creds)
  const name = shell.boxKey ? shell.boxKey(scope) : shell.name(workspaceId)
  const resources = shell.resources ?? DEFAULT_SANDBOX_RESOURCES
  const resumeTimeout = 120_000

  // Stage 1 — running-box reuse (skipped on forceNew).
  const existing = await listRunning(client, name)
  if (existing.succeeded && existing.value) {
    const found = existing.value
    if (forceNew) {
      const dropped = await deleteBox(found)
      if (!dropped.succeeded) {
        throw new Error(`forceNew: sandbox ${name} could not be deleted`, { cause: dropped.error })
      }
    } else if (found.metadata?.harness === harness) {
      const ready = await refreshRuntimeConnection(client, found)
      if (await isReusableBox(ready, harness, shell.livenessProbe)) {
        const written = await materializeDeferredFilesForExistingBox(shell, ready, workspaceId, userId)
        if (!written.succeeded) {
          throw new Error(`deferred file write failed on reused box ${name}`, { cause: written.error })
        }
        if (shell.bootstrap) {
          const boot = await shell.bootstrap(ready, scope)
          if (!boot.succeeded) {
            throw new Error(`bootstrap failed on reused box ${name}`, { cause: boot.error })
          }
        }
        return ready
      }
      const dropped = await deleteBox(ready)
      if (!dropped.succeeded) {
        throw new Error(
          `sandbox ${name} ` +
            `(was ${String(found.metadata?.harness ?? 'unknown')}, want ${harness}, or unresponsive) ` +
            `could not be deleted`,
          { cause: dropped.error },
        )
      }
    } else {
      const dropped = await deleteBox(found)
      if (!dropped.succeeded) {
        throw new Error(
          `sandbox ${name} ` +
            `(was ${String(found.metadata?.harness ?? 'unknown')}, want ${harness}, or unresponsive) ` +
            `could not be deleted`,
          { cause: dropped.error },
        )
      }
    }
  }

  // Stage 2 — stopped-box resume (skipped on forceNew or resumeStopped===false).
  if (!forceNew && shell.resumeStopped !== false) {
    const resumed = await resumeStoppedBox(client, name, resumeTimeout)
    if (resumed.succeeded && resumed.value) {
      const box = await refreshRuntimeConnection(client, resumed.value)
      if (await isReusableBox(box, harness, shell.livenessProbe)) {
        const written = await materializeDeferredFilesForExistingBox(shell, box, workspaceId, userId)
        if (!written.succeeded) {
          throw new Error(`deferred file write failed on resumed box ${name}`, { cause: written.error })
        }
        if (shell.bootstrap) {
          const boot = await shell.bootstrap(box, scope)
          if (!boot.succeeded) {
            throw new Error(`bootstrap failed on resumed box ${name}`, { cause: boot.error })
          }
        }
        return box
      }
      const dropped = await deleteBox(box)
      if (!dropped.succeeded) {
        throw new Error(
          `resumed sandbox ${name} ` +
            `(was ${String(box.metadata?.harness ?? 'unknown')}, want ${harness}, or unresponsive) ` +
            `could not be deleted`,
          { cause: dropped.error },
        )
      }
    }
  }

  // Stage 3 — create fresh.
  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId)
  const buildCtx: SandboxBuildContext = {
    workspaceId,
    connectedIntegrationIds,
    ...(userId ? { userId } : {}),
  }
  const [secrets, env, files] = await Promise.all([
    shell.secrets(workspaceId),
    shell.env(buildCtx),
    shell.files(buildCtx),
  ])
  const fullProfile = shell.profile({ extraFiles: files })
  // When deferring, strip inline files from the create payload and write them
  // into the box after it reaches running. Keeps the provision body under the
  // orchestrator's 256 KiB cap and lands real files on disk.
  const { leanProfile, deferredFiles } = shell.deferProfileFiles
    ? splitDeferredProfileFiles(fullProfile)
    : { leanProfile: fullProfile, deferredFiles: [] as AgentProfileFileMount[] }
  const profile = leanProfile

  const role = userId && shell.permissionRole ? shell.permissionRole('developer') : undefined

  // Bake the model at create when opted in. childKeyMint overrides the apiKey
  // per-workspace; a typed mint failure falls through to the parent key (logged).
  let model = shell.backendModelAtCreate ? resolveModel(shell.provider) : undefined
  if (model && shell.childKeyMint && model.provider === 'openai-compat') {
    const minted = await shell.childKeyMint(scope)
    if (minted.succeeded) model = { ...model, apiKey: minted.value }
    else {
      console.error(
        `[sandbox] childKeyMint failed for ${workspaceId}; using parent key:`,
        minted.error.message,
      )
    }
  }

  const storage = shell.storage?.(buildCtx)
  const restore = shell.restore?.(buildCtx)

  const payload = {
    name,
    image: resources.image,
    metadata: shell.metadata(harness),
    ...(userId ? { permissions: { initialUsers: [{ userId, role }] } } : {}),
    env,
    secrets,
    backend: { type: harness, profile, ...(model ? { model } : {}) },
    ...(storage ? { storage } : {}),
    ...(restore ? restore : {}),
    ...(shell.webTerminalEnabled ? { webTerminalEnabled: true } : {}),
    maxLifetimeSeconds: resources.maxLifetimeSeconds,
    idleTimeoutSeconds: resources.idleTimeoutSeconds,
    resources: {
      cpuCores: resources.cpuCores,
      memoryMB: resources.memoryMB,
      diskGB: resources.diskGB,
    },
  } as CreatePayload

  let box = await client.create(payload)

  await box.waitFor('running', { timeoutMs: 120_000 })
  box = await refreshRuntimeConnection(client, box)

  if (deferredFiles.length > 0) {
    const written = await writeProfileFilesToBox(box, deferredFiles)
    if (!written.succeeded) {
      throw new Error(`deferred file write failed on new box ${name}`, { cause: written.error })
    }
  }

  if (shell.bootstrap) {
    const boot = await shell.bootstrap(box, scope)
    if (!boot.succeeded) {
      throw new Error(`bootstrap failed on new box ${name}`, { cause: boot.error })
    }
  }
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
  signal?: AbortSignal
  timeoutMs?: number
  // When true, an interactive question event throws instead of yielding —
  // detached (cron/mission-step) runs have no consumer to answer it.
  disallowQuestions?: boolean
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

  // Server-side enforcement of the harness↔model policy: a vendor-locked harness
  // (claude-code/codex/kimi-code) must not be sent a foreign-provider model, even
  // if the UI snap was bypassed. Provider-less ids pass (session's own config).
  if (model?.model) assertHarnessModelCompatible(harness, model.model)

  const prompt = flattenHistory(message, options?.history)

  const appToolMcp = options?.appToolMcp ?? {}
  const extraMcp = mergeExtraMcp(appToolMcp, options?.baseProfileMcp ?? {}, options?.extraMcp)

  const profile = shell.profile({ systemPrompt: options?.systemPrompt, extraMcp })
  const profileWithEffort = attachReasoningEffort(profile, harness, options?.effort)

  const stream = box.streamPrompt(prompt, {
    sessionId: options?.sessionId,
    executionId: options?.executionId,
    lastEventId: options?.lastEventId,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    backend: {
      type: harness,
      profile: profileWithEffort,
      ...(model ? { model } : {}),
    },
  } as StreamPromptOptions)

  let severedFinishReason: string | null = null
  for await (const event of stream) {
    const step = classifySeveredStream(event)
    if (step) severedFinishReason = step.kind === 'step-finish' && step.severed ? step.reason : null
    if (severedFinishReason && isTerminalPromptEvent(event)) {
      throw new Error(`sandbox model stream severed mid-turn (reason="${severedFinishReason}")`)
    }
    if (options?.disallowQuestions) {
      const q = detectInteractiveQuestion(event)
      if (q) {
        throw new Error(`sandbox agent asked an interactive question during an autonomous run: ${q}`)
      }
    }
    yield event
  }
  // Reconnect-exhausted path: the stream ended on a severed step without a
  // terminal event. A truncated turn must fail loud, not return silently.
  if (severedFinishReason) {
    throw new Error(`sandbox model stream severed mid-turn (reason="${severedFinishReason}")`)
  }
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

// Detached single-turn advance. The SDK SandboxInstance has no `driveTurn`; the
// non-streaming sibling of streamPrompt is box.prompt(message, opts) -> PromptResult.
// Returns a typed Outcome so a failed turn is inspected, not swallowed.
export async function driveSandboxTurn(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string,
  options: StreamSandboxPromptOptions & { sessionId: string },
): Promise<Outcome<PromptResult>> {
  const harness = options.harness ?? 'opencode'
  const model = resolveModel(shell.provider, {
    model: options.model,
    modelApiKey: options.modelApiKey,
  })
  if (model?.model) assertHarnessModelCompatible(harness, model.model)
  const prompt = flattenHistory(message, options.history)
  const appToolMcp = options.appToolMcp ?? {}
  const extraMcp = mergeExtraMcp(appToolMcp, options.baseProfileMcp ?? {}, options.extraMcp)
  const profile = attachReasoningEffort(
    shell.profile({ systemPrompt: options.systemPrompt, extraMcp }),
    harness,
    options.effort,
  )
  try {
    const result = await box.prompt(prompt, {
      sessionId: options.sessionId,
      ...(options.executionId ? { executionId: options.executionId } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      backend: { type: harness, profile, ...(model ? { model } : {}) },
    } as Parameters<SandboxInstance['prompt']>[1])
    if (!result.success) return fail(new Error(result.error ?? 'sandbox turn failed'))
    return ok(result)
  } catch (err) {
    return fail(err)
  }
}

// Severed-stream classifier. Generic to any router-backed harness: a final step
// that finished with error/other/unknown is a truncated turn, not a completed one.
const SEVERED_FINISH_REASONS = new Set(['error', 'other', 'unknown'])

export type SandboxStepTransition =
  | { kind: 'step-start' }
  | { kind: 'step-finish'; reason: string; severed: boolean }

function asPlainRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function classifySeveredStream(event: unknown): SandboxStepTransition | null {
  const root = asPlainRecord(event)
  if (!root || root.type !== 'message.part.updated') return null
  const body = asPlainRecord(root.properties) ?? asPlainRecord(root.data) ?? root
  const part = asPlainRecord(body.part)
  if (!part) return null
  if (part.type === 'step-start') return { kind: 'step-start' }
  if (part.type !== 'step-finish') return null
  const reason = typeof part.reason === 'string' && part.reason ? part.reason : 'unknown'
  return { kind: 'step-finish', reason, severed: SEVERED_FINISH_REASONS.has(reason) }
}

export function isTerminalPromptEvent(event: unknown): boolean {
  const t = asPlainRecord(event)?.type
  return t === 'result' || t === 'done'
}

// Interactive-question detector. Returns the question text or null. Used by
// streamSandboxPrompt when disallowQuestions is set.
export function detectInteractiveQuestion(event: unknown): string | null {
  const root = asPlainRecord(event)
  if (!root) return null
  const type = typeof root.type === 'string' ? root.type : undefined
  const data = asPlainRecord(root.data)
  const props = asPlainRecord(root.properties)
  const body = props ?? data ?? root
  if (type === 'question.asked' || type === 'question') return firstQuestionText(body)
  const part = asPlainRecord(data?.part) ?? asPlainRecord(body.part)
  const tool =
    (typeof part?.tool === 'string' && part.tool) ||
    (typeof part?.name === 'string' && part.name) ||
    (typeof body.tool === 'string' && body.tool) ||
    undefined
  const isQ =
    type === 'message.part.updated' &&
    (tool === 'question' || asPlainRecord(part)?.type === 'question')
  if (!isQ) return null
  const state = asPlainRecord(asPlainRecord(part)?.state)
  return firstQuestionText(asPlainRecord(state?.input) ?? state ?? part ?? body)
}

function firstQuestionText(value: Record<string, unknown> | null): string {
  const arr = Array.isArray(value?.questions)
    ? value!.questions
    : Array.isArray(asPlainRecord(value?.input)?.questions)
      ? (asPlainRecord(value!.input)!.questions as unknown[])
      : []
  const first = asPlainRecord(arr[0])
  const q =
    (typeof first?.question === 'string' && first.question) ||
    (typeof first?.prompt === 'string' && first.prompt) ||
    undefined
  return q ?? 'interactive question'
}
// Workspace sandbox terminal handlers: WebSocket upgrade proxy, connection
// + runtime-proxy handlers, and scoped terminal-token mint/verify.
export * from './terminal-proxy-token'
export * from './workspace-terminal'
