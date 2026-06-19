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
import {
  resolveTangleExecutionEnvironment,
  trimOrNull,
  type TangleExecutionEnvironment,
} from '../runtime/model'
import { ok, fail, type Outcome } from './outcome'

export type { Outcome } from './outcome'

export interface SandboxClientCredentials {
  apiKey: string
  baseUrl: string
}

/**
 * Sandbox credential policy reuses the canonical execution-environment union
 * (development/test/staging/production) so env classification stays in one place
 * (see resolveTangleExecutionEnvironment in runtime/model).
 */
export type SandboxCredentialEnvironment = TangleExecutionEnvironment

export interface ResolveSandboxClientCredentialsOptions {
  /**
   * Environment object to read from. Defaults to process.env when available.
   */
  env?: Record<string, string | undefined>
  /**
   * Explicit environment classification. Defaults to APP_ENV/NODE_ENV derived
   * behavior: local/development/test use direct env credentials; staging/prod
   * require the provision callback unless allowDirectEnvCredentials opts in.
   */
  environment?: SandboxCredentialEnvironment
  /**
   * Env names that may carry a sandbox-compatible bearer. The first non-empty
   * value wins when direct env credentials are allowed.
   */
  directKeyNames?: readonly string[]
  /**
   * Env names that may carry the sandbox gateway URL. The first non-empty value
   * wins, then defaultBaseUrl.
   */
  baseUrlNames?: readonly string[]
  /**
   * Base URL used when none of baseUrlNames are present.
   */
  defaultBaseUrl?: string
  /**
   * Whether direct env credentials are allowed for this environment. Defaults
   * to true in development/test and false in staging/production.
   */
  allowDirectEnvCredentials?: boolean | ((environment: SandboxCredentialEnvironment) => boolean)
  /**
   * Product-owned provision path, usually minting a per-user sandbox key from a
   * linked platform account. Called before direct env credentials in
   * staging/production and after direct env credentials in development/test.
   */
  provision?: (
    context: {
      environment: SandboxCredentialEnvironment
      env: Record<string, string | undefined>
    },
  ) => SandboxClientCredentials | null | undefined | Promise<SandboxClientCredentials | null | undefined>
}

const DEFAULT_SANDBOX_DIRECT_KEY_NAMES = [
  'TCLOUD_SANDBOX_API_KEY',
  'SANDBOX_API_KEY',
  'TANGLE_API_KEY',
] as const
const DEFAULT_SANDBOX_BASE_URL_NAMES = ['SANDBOX_GATEWAY_URL', 'SANDBOX_API_URL'] as const

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/v1\/?$/, '').replace(/\/+$/, '')
}

function processEnv(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : process.env
}

function directEnvCredentialsAllowed(
  environment: SandboxCredentialEnvironment,
  allow: ResolveSandboxClientCredentialsOptions['allowDirectEnvCredentials'],
): boolean {
  if (typeof allow === 'function') return allow(environment)
  if (typeof allow === 'boolean') return allow
  return environment === 'development' || environment === 'test'
}

function resolveSandboxBaseUrl(
  env: Record<string, string | undefined>,
  names: readonly string[],
  defaultBaseUrl: string | undefined,
): string {
  for (const name of names) {
    const value = trimOrNull(env[name])
    if (value) return normalizeBaseUrl(value)
  }
  const value = trimOrNull(defaultBaseUrl)
  if (value) return normalizeBaseUrl(value)
  throw new Error(
    `Sandbox base URL is required (set one of ${names.join(', ')} or pass defaultBaseUrl).`,
  )
}

function resolveDirectSandboxCredentials(
  env: Record<string, string | undefined>,
  keyNames: readonly string[],
  baseUrlNames: readonly string[],
  defaultBaseUrl: string | undefined,
): SandboxClientCredentials | null {
  for (const name of keyNames) {
    const apiKey = trimOrNull(env[name])
    if (!apiKey) continue
    return {
      apiKey,
      baseUrl: resolveSandboxBaseUrl(env, baseUrlNames, defaultBaseUrl),
    }
  }
  return null
}

export async function resolveSandboxClientCredentials(
  options: ResolveSandboxClientCredentialsOptions = {},
): Promise<SandboxClientCredentials> {
  const env = options.env ?? processEnv()
  const environment = options.environment ?? resolveTangleExecutionEnvironment(env)
  const keyNames = options.directKeyNames ?? DEFAULT_SANDBOX_DIRECT_KEY_NAMES
  const baseUrlNames = options.baseUrlNames ?? DEFAULT_SANDBOX_BASE_URL_NAMES
  const directAllowed = directEnvCredentialsAllowed(environment, options.allowDirectEnvCredentials)
  const direct = () =>
    directAllowed
      ? resolveDirectSandboxCredentials(env, keyNames, baseUrlNames, options.defaultBaseUrl)
      : null

  if (environment === 'development' || environment === 'test') {
    const credentials = direct()
    if (credentials) return credentials
  }

  const provisioned = await options.provision?.({ environment, env })
  if (provisioned) {
    return {
      apiKey: provisioned.apiKey,
      baseUrl: normalizeBaseUrl(provisioned.baseUrl),
    }
  }

  const credentials = direct()
  if (credentials) return credentials

  const directHint = directAllowed
    ? ` or set one of ${keyNames.join(', ')}`
    : ''
  throw new Error(
    `Sandbox credentials are required for ${environment} (provide a provision callback${directHint}).`,
  )
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

export interface SandboxToolSpec {
  name: string
  content: string
  executable?: boolean
}

export interface SandboxToolPathOptions {
  appName: string
  baseDir?: string
  binDir?: string
}

export interface BuildSandboxToolFileMountsOptions extends SandboxToolPathOptions {
  tools: readonly SandboxToolSpec[]
}

const DEFAULT_SANDBOX_TOOL_BASE_DIR = '/home/agent/tools'
const SAFE_TOOL_SEGMENT = /^[A-Za-z0-9._-]+$/

function normalizeSandboxToolSegment(value: string, label: string): string {
  const segment = value.trim()
  if (!segment || segment === '.' || segment === '..' || !SAFE_TOOL_SEGMENT.test(segment)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, or hyphens.`)
  }
  return segment
}

function normalizeSandboxToolDir(value: string, label: string): string {
  const dir = value.trim().replace(/\/+$/, '')
  if (!dir || !dir.startsWith('/') || dir.includes('\0') || dir.includes('\n')) {
    throw new Error(`${label} must be an absolute sandbox path.`)
  }
  return dir === '' ? '/' : dir
}

export function sandboxToolRootDir(options: SandboxToolPathOptions): string {
  const appName = normalizeSandboxToolSegment(options.appName, 'sandbox tool appName')
  const baseDir = normalizeSandboxToolDir(
    options.baseDir ?? DEFAULT_SANDBOX_TOOL_BASE_DIR,
    'sandbox tool baseDir',
  )
  return `${baseDir}/${appName}`
}

export function sandboxToolBinDir(options: SandboxToolPathOptions): string {
  normalizeSandboxToolSegment(options.appName, 'sandbox tool appName')
  if (options.binDir) return normalizeSandboxToolDir(options.binDir, 'sandbox tool binDir')
  return `${sandboxToolRootDir(options)}/bin`
}

export function sandboxToolPath(options: SandboxToolPathOptions & { toolName: string }): string {
  const toolName = normalizeSandboxToolSegment(options.toolName, 'sandbox tool name')
  return `${sandboxToolBinDir(options)}/${toolName}`
}

export function buildSandboxToolFileMounts(
  options: BuildSandboxToolFileMountsOptions,
): AgentProfileFileMount[] {
  return options.tools.map((tool) => {
    const name = normalizeSandboxToolSegment(tool.name, 'sandbox tool name')
    return {
      path: sandboxToolPath({ ...options, toolName: name }),
      resource: { kind: 'inline' as const, name, content: tool.content },
      executable: tool.executable ?? true,
    }
  })
}

export function buildSandboxToolPathSetupScript(options: SandboxToolPathOptions): string {
  const binDir = sandboxToolBinDir(options)
  const exportLine = `export PATH=${binDir}:$PATH`
  return [
    'set -eu',
    `mkdir -p ${shellSingleQuote(binDir)}`,
    `PATH=${shellSingleQuote(binDir)}:$PATH`,
    'export PATH',
    'for profile in "${HOME:-/home/agent}/.profile" "${HOME:-/home/agent}/.bashrc" "${HOME:-/home/agent}/.zshrc"; do',
    '  mkdir -p "$(dirname "$profile")"',
    '  touch "$profile"',
    `  grep -Fqx ${shellSingleQuote(exportLine)} "$profile" || printf '\\n%s\\n' ${shellSingleQuote(exportLine)} >> "$profile"`,
    'done',
  ].join('\n')
}

export async function runSandboxToolPathSetup(
  box: SandboxInstance,
  options: SandboxToolPathOptions,
): Promise<Outcome<void>> {
  try {
    const res = await box.exec(buildSandboxToolPathSetupScript(options))
    if (res.exitCode !== 0) {
      return fail(
        new Error(
          `runSandboxToolPathSetup: failed to configure PATH for ${sandboxToolBinDir(options)} ` +
            `(exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
        ),
      )
    }
    return ok(undefined)
  } catch (err) {
    return fail(new Error('runSandboxToolPathSetup: exec failed', { cause: err }))
  }
}

// Build a shell-safe path token that preserves tilde-home semantics. A path
// beginning `~/` (or a bare `~`) must resolve to the box user's real `$HOME`,
// but single-quoting the whole path suppresses shell `~` expansion and lands
// the file in a literal directory named `~`. Expand the leading `~` to an
// UNQUOTED `"$HOME"` (so the shell expands it) and single-quote only the
// remainder. Absolute and relative paths are single-quoted unchanged.
function shellPath(path: string): string {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) {
    const rest = path.slice(2)
    return rest ? `"$HOME"/${shellSingleQuote(rest)}` : '"$HOME"'
  }
  return shellSingleQuote(path)
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

// The runtime exec proxy (`box.exec` → /terminals/commands) hangs (30s
// timeout) on any request whose body crosses ~4096 bytes, and one oversized
// exec wedges the channel so every later exec on the box hangs too. We slice
// each file's base64 into appends whose full command string stays well under
// that cap. 3000 chars of base64 leaves ~1000 bytes of headroom for the
// surrounding `printf '%s' '<slice>' >> <path>.b64` command plus the proxy's
// JSON request envelope — comfortably below 4096.
const PROFILE_WRITE_B64_CHUNK_CHARS = 3000

// gtm's corpus is ~45 small execs; on a cold box the runtime exec proxy can
// return HTTP 429 (rate limit) mid-batch. A 429 is transient, so retry it with
// exponential backoff before failing loud. Non-429 errors are NOT retried.
const PROFILE_WRITE_MAX_429_RETRIES = 4
const PROFILE_WRITE_RETRY_BASE_MS = 250
const PROFILE_WRITE_RETRY_MAX_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Detect a rate-limit (HTTP 429) surfaced by the exec proxy, regardless of
// whether it arrives as a SandboxError-shaped object (status/code/retryAfterMs)
// or as a generic thrown error whose message carries the 429.
function rateLimit(err: unknown): { is429: boolean; retryAfterMs?: number } {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; code?: unknown; message?: unknown; retryAfterMs?: unknown }
    const retryAfterMs = typeof e.retryAfterMs === 'number' ? e.retryAfterMs : undefined
    if (e.status === 429) return { is429: true, retryAfterMs }
    if (typeof e.code === 'string' && /rate.?limit|too.?many.?requests|429/i.test(e.code)) {
      return { is429: true, retryAfterMs }
    }
    if (typeof e.message === 'string' && /\b429\b|rate.?limit|too many requests/i.test(e.message)) {
      return { is429: true, retryAfterMs }
    }
  }
  return { is429: false }
}

// Materialize inline profile files into a running box via `box.exec`. Uses a
// base64 pipe so arbitrary content (scripts, unicode, special chars) lands
// byte-exact, and writes to ANY absolute path (e.g. /usr/local/bin) or a
// `~`-relative path — the exec runs as the sidecar, which is not bound by the
// safe-prefix allow-list the /files/write API enforces. Sets the executable
// bit when the mount declares it OR the target is a bin directory.
//
// Each file is written in several small execs (mkdir, one append per base64
// chunk, then a decode+cleanup) so no single exec request body trips the
// ~4 KiB proxy cap. Writes are sequential; a single bad mount stops the batch
// and the first failure is returned (fail-loud), the rest are not attempted.
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
    const q = shellPath(path)
    const qb64 = shellPath(`${path}.b64`)

    // Run one exec step, surfacing a non-zero exit or transport error as a
    // fail-loud Outcome with the underlying NetworkError/TimeoutError as cause.
    // A 429 (rate limit) from the proxy is transient: retry with exponential
    // backoff up to PROFILE_WRITE_MAX_429_RETRIES. Any non-429 error fails loud
    // immediately. A non-zero exit is a real command failure, not retried.
    const step = async (cmd: string): Promise<Outcome<void>> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await box.exec(cmd)
          if (res.exitCode !== 0) {
            return fail(
              new Error(
                `writeProfileFilesToBox: failed to write ${path} (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
              ),
            )
          }
          return ok(undefined)
        } catch (err) {
          const { is429, retryAfterMs } = rateLimit(err)
          if (is429 && attempt < PROFILE_WRITE_MAX_429_RETRIES) {
            const backoff = Math.min(
              PROFILE_WRITE_RETRY_BASE_MS * 2 ** attempt,
              PROFILE_WRITE_RETRY_MAX_MS,
            )
            await sleep(retryAfterMs ?? backoff)
            continue
          }
          return fail(new Error(`writeProfileFilesToBox: exec failed for ${path}`, { cause: err }))
        }
      }
    }

    // Start the staging file empty so re-runs (redeploy with new skills)
    // overwrite rather than append. mkdir -p creates the target directory;
    // shellPath keeps `~/...` resolving to the box user's real $HOME.
    const mkdir = dir && dir !== path ? `mkdir -p ${shellPath(dir)} && ` : ''
    let res = await step(`${mkdir}: > ${qb64}`)
    if (!res.succeeded) return res

    // Append the base64 in capped slices; the base64 alphabet has no single
    // quotes, so single-quoting each slice is safe. printf '%s' adds no newline.
    for (let i = 0; i < b64.length; i += PROFILE_WRITE_B64_CHUNK_CHARS) {
      const slice = b64.slice(i, i + PROFILE_WRITE_B64_CHUNK_CHARS)
      res = await step(`printf '%s' '${slice}' >> ${qb64}`)
      if (!res.succeeded) return res
    }

    // Decode the staged base64 to the real path, drop the staging file, and set
    // the executable bit when required. base64 -d reconstructs the exact bytes.
    const chmod = executable ? ` && chmod +x ${q}` : ''
    res = await step(`base64 -d ${qb64} > ${q} && rm -f ${qb64}${chmod}`)
    if (!res.succeeded) return res
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
