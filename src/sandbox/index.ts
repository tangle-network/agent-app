import {
  Sandbox,
  type AgentProfile,
  type AgentProfileFileMount,
  type AgentProfileMcpServer,
  type ExecResult,
  type SandboxConnection,
  type SandboxInstance,
  type ScopedTokenScope,
  type StorageConfig,
  type TurnDriveResult,
  type ProvisionEvent,
} from '@tangle-network/sandbox'
import { createHash } from 'node:crypto'
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
export * from './binary-read'

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
  // Opt-in: a resolvable provider+model WITHOUT an api key still yields model
  // metadata (model/provider/baseUrl, no apiKey) instead of undefined. Keyless
  // metadata makes the sandbox platform mint its OWN per-user router key at
  // create (its requiresRouterKey gate), so turns bill the box's billing owner
  // instead of a product-baked shared key. Requires an explicit providerName —
  // provider inference from key presence cannot fire keyless. Default false:
  // a keyless config resolves to undefined exactly as before.
  allowKeylessModel?: boolean
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

export interface StoppedSandboxResumeFailure {
  box: SandboxInstance
  error: Error
  scope: SandboxScope
  boxKey: string
}

export interface StoppedSandboxResumeRecovery {
  // Used for both the replacement sandbox name and idempotency key.
  replacementBoxKey: string
  // undefined preserves the configured restore seam; null creates without one.
  restore?: SandboxRestoreSpec | null
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
  // Product-owned retention/recovery policy after a stopped box fails to resume.
  // Return ok(null) to preserve the original resume error. A replacement key is
  // required before this shell creates a new box, so it cannot resolve the
  // failed stopped box through the original idempotency identity.
  recoverStoppedSandbox?: (
    failure: StoppedSandboxResumeFailure,
  ) => Promise<Outcome<StoppedSandboxResumeRecovery | null>>
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
  // Real-time provisioning progress from the SDK's SSE stream, forwarded from
  // the `waitFor('running')` calls on the resume and cold-create paths. Callers
  // surface it as live "warming up" status. Only fires while a box is actually
  // being provisioned; a reused running box emits nothing.
  onProgress?: (event: ProvisionEvent) => void
  // Billing owner for the created box, forwarded VERBATIM on the create
  // payload. The sandbox platform honors it only when the create-auth
  // principal is a trusted first-party service; the box's usage then bills
  // this platform user's wallet (the platform's per-user router-key mint)
  // instead of the service account that authenticated the create. Omitted =>
  // platform default (billing owner = create-auth principal) — unchanged.
  billingOwnerId?: string
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

// gtm's corpus is ~135 small execs; on a cold box the runtime exec proxy
// hard-throttles (HTTP 429 after ~21 execs in ~34s) and, under sustained load,
// SILENTLY HANGS instead of returning 429 — one parked exec wedges the channel
// and `writeProfileFilesToBox` never returns, so `ensureWorkspaceSandbox`
// parks the worker (~140s, no exception). These failures plus sidecar exec-plane
// readiness/transport failures (5xx, reset, fetch/network errors) are transient:
// retry the SAME exec with exponential backoff before failing loud. A non-zero
// exit is a real command failure, never retried.
const PROFILE_WRITE_MAX_RETRIES = 4
const PROFILE_WRITE_RETRY_BASE_MS = 250
const PROFILE_WRITE_RETRY_MAX_MS = 2000

// Client-side hard ceiling per exec. The proxy's own 30s timeout is unreliable
// once the channel wedges (it can hang past it), so we race each exec against an
// independent timer we control: a wedged exec is abandoned here and retried as a
// transient transport error, never silently parked. We also pass timeoutMs to
// the SDK as defense-in-depth, but the race is the guarantee.
const PROFILE_WRITE_EXEC_TIMEOUT_MS = 30_000

// Pacing between execs to stay under the proxy throttle that triggers the hang.
// The drill saw throttling at ~0.6 exec/s bursts; ~150ms between ~135 execs
// adds well under a minute total and keeps the burst rate below the trip point.
// On by default for the deferred path; overridable for tests/tuning.
const PROFILE_WRITE_PACE_MS = 150

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A mount whose path sits in a bin directory is made executable. Shared so the
// file-API eligibility check and the exec branch agree on "executable by dir".
const PROFILE_BIN_DIR_RE = /(^|\/)(s?bin)\//

// Sentinel cause for a client-side per-exec timeout (a hung/wedged proxy exec).
// Carried as the `.cause` of the fail-loud Outcome so callers see the wedged
// command instead of an opaque infinite hang.
class ProfileWriteExecTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`exec exceeded ${timeoutMs}ms (proxy hang/wedge)`)
    this.name = 'ProfileWriteExecTimeoutError'
  }
}

// Run a box.exec, abandoning it if it does not settle within timeoutMs. The
// returned promise rejects with ProfileWriteExecTimeoutError on timeout so the
// retry loop treats a hang exactly like a transient transport error. We also
// forward timeoutMs to the SDK so the underlying request is cancelled when the
// SDK honors it; the race covers the case where it does not.
function execWithTimeout(
  box: SandboxInstance,
  cmd: string,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new ProfileWriteExecTimeoutError(timeoutMs))
    }, timeoutMs)
    box.exec(cmd, { timeoutMs }).then(
      (res) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(res)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

const TRANSIENT_EXEC_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const TRANSIENT_EXEC_CODE_RE = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ECONNABORTED)$/i
const TRANSIENT_EXEC_MESSAGE_RE =
  /\b(408|409|425|429|500|502|503|504)\b|rate.?limit|too many requests|\bfetch failed\b|network error|connection reset|socket hang up|timed? out|service unavailable|bad gateway|gateway timeout|internal server error|\b(?:sidecar|runtime|exec(?:ution)?|terminal|sandbox|service|command(?:s)?|proxy)\b.{0,80}\bnot ready\b|\bnot ready\b.{0,80}\b(?:sidecar|runtime|exec(?:ution)?|terminal|sandbox|service|command(?:s)?|proxy)\b/i
const RUNTIME_AUTH_REFRESH_SKEW_MS = 60_000

function errorStatus(err: { status?: unknown; statusCode?: unknown; response?: unknown }): number | undefined {
  const rawStatus = err.status ?? err.statusCode ?? (
    err.response && typeof err.response === 'object'
      ? (err.response as { status?: unknown }).status
      : undefined
  )
  if (typeof rawStatus === 'number') return rawStatus
  if (typeof rawStatus === 'string' && /^\d+$/.test(rawStatus)) return Number(rawStatus)
  return undefined
}

function retryAfterMs(err: unknown, seen = new Set<object>()): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  if (seen.has(err)) return undefined
  seen.add(err)
  const e = err as { retryAfterMs?: unknown; cause?: unknown }
  if (typeof e.retryAfterMs === 'number') return e.retryAfterMs
  return retryAfterMs(e.cause, seen)
}

function isTransientExecError(err: unknown, seen = new Set<object>()): boolean {
  if (!err || typeof err !== 'object') return false
  if (seen.has(err)) return false
  seen.add(err)
  const e = err as {
    status?: unknown
    statusCode?: unknown
    response?: unknown
    code?: unknown
    message?: unknown
    cause?: unknown
  }
  const status = errorStatus(e)
  if (status !== undefined && TRANSIENT_EXEC_STATUS_CODES.has(status)) return true
  if (typeof e.code === 'string') {
    if (TRANSIENT_EXEC_CODE_RE.test(e.code)) return true
    if (/rate.?limit|too.?many.?requests|429|server.?error|service.?unavailable/i.test(e.code)) return true
  }
  if (typeof e.message === 'string' && TRANSIENT_EXEC_MESSAGE_RE.test(e.message)) return true
  return isTransientExecError(e.cause, seen)
}

function isRuntimeExecAuthError(err: unknown, seen = new Set<object>()): boolean {
  if (!err || typeof err !== 'object') return false
  if (seen.has(err)) return false
  seen.add(err)
  const e = err as {
    status?: unknown
    statusCode?: unknown
    response?: unknown
    code?: unknown
    name?: unknown
    message?: unknown
    cause?: unknown
  }
  if (errorStatus(e) === 401) return true
  if (
    typeof e.code === 'string' &&
    /^(AUTH_ERROR|AUTHENTICATION_ERROR|UNAUTHORIZED|UNAUTHENTICATED|ERR_UNAUTHORIZED|ERR_UNAUTHENTICATED|401)$/i.test(e.code)
  ) {
    return true
  }
  if (
    typeof e.name === 'string' &&
    /^(AuthError|AuthenticationError|UnauthorizedError|UnauthenticatedError|SandboxAuthError)$/i.test(e.name)
  ) {
    return true
  }
  return isRuntimeExecAuthError(e.cause, seen)
}

function isRuntimeAuthRefreshDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  return (
    isRuntimeExecAuthError(err) ||
    errorStatus(err as { status?: unknown; statusCode?: unknown; response?: unknown }) === 403
  )
}

// Classify an exec failure as transient-retryable. Retryable shapes share the
// same backoff path: rate-limit (HTTP 429 + retryAfterMs), client-side timeout,
// and transient sidecar/transport/readiness failures surfaced as SandboxError-
// shaped objects, fetch errors, network resets, or 5xx-ish messages. Everything
// else fails loud. Non-zero shell exits never reach this classifier.
function transientExecError(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (err instanceof ProfileWriteExecTimeoutError) return { retryable: true }
  if (isTransientExecError(err)) return { retryable: true, retryAfterMs: retryAfterMs(err) }
  return { retryable: false }
}

function deferredProfileWriteFailed(stage: 'new' | 'reused' | 'resumed', name: string, cause: Error): Error {
  return new Error(`deferred file write failed on ${stage} box ${name}: ${cause.message}`, { cause })
}

type ExistingBoxStage = 'reused' | 'resumed'

export class SandboxRuntimeAuthRefreshError extends Error {
  constructor(stage: ExistingBoxStage, name: string, detail: string, cause?: unknown) {
    super(`${stage} sandbox auth refresh failed for ${name}: ${detail}`, { cause })
    this.name = 'SandboxRuntimeAuthRefreshError'
  }
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
//
// Each exec is bounded by a client-side hard timeout and retried with backoff
// on transient rate-limit/readiness/transport failures, so one wedged or early
// exec-plane request can never park the caller (and thus never park provisioning).
// A small pace between execs keeps the burst rate below the proxy throttle that
// triggers the hang.
export interface WriteProfileFilesOptions {
  // Hard ceiling per exec (ms). A hung/wedged exec is abandoned and retried.
  execTimeoutMs?: number
  // Delay between execs (ms) to stay under the proxy throttle. 0 disables it.
  paceMs?: number
  // Max retries for a transient exec before failing loud.
  maxRetries?: number
}

// The workspace-relative target for a deferred inline mount when it can be
// materialized through the sidecar file API (`box.fs.writeMany` — FILES rate
// group, 300/min, whole-file, auto-mkdir) instead of the chunked terminal-exec
// path (50/min); null when it must stay on exec. The file API resolves relative
// paths from the workspace root, so eligibility is: inline and a path that
// resolves under the workspace root with no `..`/`.sidecar` segment. `~/…` and
// `/home/agent/…` are home-relative; agent sandboxes set $HOME to the workspace
// root, so both map to the same relative target. Other absolute (`/…`) and bare
// `~`/`~user` mounts stay on exec.
function fileApiTarget(mount: AgentProfileFileMount): string | null {
  if (mount.resource.kind !== 'inline') return null
  let rel: string
  if (mount.path.startsWith('~/')) rel = mount.path.slice(2)
  else if (mount.path.startsWith('/home/agent/')) rel = mount.path.slice('/home/agent/'.length)
  else if (mount.path.startsWith('/') || mount.path.startsWith('~')) return null
  else rel = mount.path
  if (rel.length === 0 || rel.startsWith('/') || rel.split('/').some((seg) => seg === '..' || seg === '.sidecar')) {
    return null
  }
  return rel
}

function isExecutableProfileFile(mount: AgentProfileFileMount): boolean {
  return mount.executable ?? PROFILE_BIN_DIR_RE.test(mount.path)
}

function profileFileMode(mount: AgentProfileFileMount): number | undefined {
  return isExecutableProfileFile(mount) ? 0o755 : undefined
}

function fileApiSupportsMode(box: SandboxInstance): boolean {
  const fs = box.fs as (SandboxInstance['fs'] & { supportsWriteMode?: boolean }) | undefined
  return fs?.supportsWriteMode === true
}

export async function writeProfileFilesToBox(
  box: SandboxInstance,
  files: AgentProfileFileMount[],
  options: WriteProfileFilesOptions = {},
): Promise<Outcome<void>> {
  const execTimeoutMs = options.execTimeoutMs ?? PROFILE_WRITE_EXEC_TIMEOUT_MS
  const paceMs = options.paceMs ?? PROFILE_WRITE_PACE_MS
  const maxRetries = options.maxRetries ?? PROFILE_WRITE_MAX_RETRIES
  // The bulk of a profile corpus (skills, `~/.claude/skills/…`, config) is
  // inline and workspace-relative — write it in ONE paced,
  // retry-aware batch via the SDK's file API (`box.fs.writeMany`, FILES rate
  // group 300/min). The SDK owns the pacing + transient-retry this module used
  // to hand-roll. Absolute / bare-`~` paths can't use the file API
  // (prefix-restricted), so they stay on the chunked exec path.
  // Capability-guarded: SDKs without `writeMany` route everything through
  // exec; SDKs before @tangle-network/sandbox 0.9.4 keep executable files on
  // exec because they do not expose `supportsWriteMode` or forward file modes.
  const fileApiAvailable = typeof box.fs?.writeMany === 'function'
  const modeAwareFileApi = fileApiSupportsMode(box)
  const viaFileApi: { path: string; content: string; mode?: number }[] = []
  const viaExec: AgentProfileFileMount[] = []
  for (const mount of files) {
    if (mount.resource.kind !== 'inline') continue
    const fileApiPath = fileApiAvailable ? fileApiTarget(mount) : null
    const executable = isExecutableProfileFile(mount)
    if (fileApiPath !== null && (!executable || modeAwareFileApi)) {
      const mode = profileFileMode(mount)
      viaFileApi.push({
        path: fileApiPath,
        content: mount.resource.content ?? '',
        ...(mode !== undefined ? { mode } : {}),
      })
    }
    else viaExec.push(mount)
  }
  if (viaFileApi.length > 0) {
    // `writeMany` is fail-loud on the first file it can't write. Preserve the
    // cause so the runtime-auth-refresh wrapper still detects a 401 — it
    // recurses `.cause` for an AuthError/401 shape (see isRuntimeExecAuthError).
    try {
      await box.fs.writeMany(viaFileApi, { paceMs, maxRetries })
    } catch (err) {
      return fail(new Error('writeProfileFilesToBox: file-API batch write failed', { cause: err }))
    }
  }

  // Pace BETWEEN execs, not before the first or after the last. Shared across
  // the exec mounts so the (now smaller) executable/edge-case set stays paced.
  let execStarted = false

  // Pace + transient-retry ONE exec attempt: backoff/pace/fail-loud in one place.
  // `run` must be idempotent under unknown-outcome retries (exec writes
  // deterministic parts). A transient error retries with backoff up to
  // maxRetries (honoring a server Retry-After); anything else, or exhausting
  // retries, fails loud with the cause.
  const paceAndRetry = async <T>(run: () => Promise<T>, path: string): Promise<Outcome<T>> => {
    for (let attempt = 0; ; attempt++) {
      if (execStarted && paceMs > 0) await sleep(paceMs)
      execStarted = true
      try {
        return ok(await run())
      } catch (err) {
        const { retryable, retryAfterMs } = transientExecError(err)
        if (retryable && attempt < maxRetries) {
          const backoff = Math.min(PROFILE_WRITE_RETRY_BASE_MS * 2 ** attempt, PROFILE_WRITE_RETRY_MAX_MS)
          await sleep(retryAfterMs ?? backoff)
          continue
        }
        return fail(new Error(`writeProfileFilesToBox: exec failed for ${path}`, { cause: err }))
      }
    }
  }

  for (const mount of viaExec) {
    if (mount.resource.kind !== 'inline') continue // always true (viaExec is inline) — narrows for TS
    const content = mount.resource.content ?? ''
    const path = mount.path

    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const b64Chunks: string[] = []
    for (let i = 0; i < b64.length; i += PROFILE_WRITE_B64_CHUNK_CHARS) {
      b64Chunks.push(b64.slice(i, i + PROFILE_WRITE_B64_CHUNK_CHARS))
    }
    const expectedSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    const dir = path.replace(/\/[^/]*$/, '')
    const executable = isExecutableProfileFile(mount)
    const q = shellPath(path)
    const qb64 = shellPath(`${path}.b64`)
    const qtmp = shellPath(`${path}.tmp`)
    const qpartPrefix = shellPath(`${path}.b64.part.`)

    // Run one exec step. Transport errors (incl. a wedged-proxy timeout) are
    // paced + retried by paceAndRetry; a non-zero exit is a REAL command failure
    // — surfaced immediately, never retried.
    const step = async (cmd: string): Promise<Outcome<void>> => {
      const res = await paceAndRetry(() => execWithTimeout(box, cmd, execTimeoutMs), path)
      if (!res.succeeded) return res
      const exec = res.value
      if (exec.exitCode !== 0) {
        return fail(
          new Error(
            `writeProfileFilesToBox: failed to write ${path} (exit ${exec.exitCode}): ${exec.stderr.slice(0, 500)}`,
          ),
        )
      }
      return ok(undefined)
    }

    // Ensure the target directory exists. Chunk/final commands below are
    // idempotent under unknown-outcome transport retries; this no-op/mkdir is too.
    const mkdir = dir && dir !== path ? `mkdir -p ${shellPath(dir)}` : ':'
    let res = await step(mkdir)
    if (!res.succeeded) return res

    // Write each deterministic part with overwrite, not append. If the server
    // writes a part but the HTTP response is lost, retrying the same step lands
    // the same bytes instead of duplicating them.
    for (let i = 0; i < b64Chunks.length; i++) {
      const slice = b64Chunks[i]!
      res = await step(`printf '%s' '${slice}' > ${shellPath(`${path}.b64.part.${i}`)}`)
      if (!res.succeeded) return res
    }

    // Materialize from deterministic parts into a temp file, verify its content
    // hash, then atomically move into place. If the final exec succeeds but its
    // response is lost, a retry first accepts an already-correct target and only
    // re-runs idempotent chmod/cleanup. Parts are cleaned only after the target
    // hash is known-good, so a retried final step can always reconstruct.
    const chmod = executable ? `chmod +x ${q} || exit 1; ` : ''
    const checksumMismatch = shellSingleQuote(`writeProfileFilesToBox: checksum mismatch for ${path}`)
    const finalCmd =
      `expected='${expectedSha256}'; ` +
      `if [ -f ${q} ] && [ "$(sha256sum ${q} | awk '{print $1}')" = "$expected" ]; then ` +
      `${chmod}rm -f ${qb64} ${qtmp}; i=0; while [ "$i" -lt ${b64Chunks.length} ]; do rm -f ${qpartPrefix}$i; i=$((i+1)); done; exit 0; fi; ` +
      `: > ${qb64} && ` +
      `i=0; while [ "$i" -lt ${b64Chunks.length} ]; do cat ${qpartPrefix}$i >> ${qb64} || exit 1; i=$((i+1)); done && ` +
      `base64 -d ${qb64} > ${qtmp} && ` +
      `[ "$(sha256sum ${qtmp} | awk '{print $1}')" = "$expected" ] || { echo ${checksumMismatch} >&2; exit 1; }; ` +
      `mv ${qtmp} ${q} && ` +
      `${executable ? `chmod +x ${q} && ` : ''}` +
      `[ "$(sha256sum ${q} | awk '{print $1}')" = "$expected" ] || { echo ${checksumMismatch} >&2; exit 1; }; ` +
      `rm -f ${qb64} ${qtmp}; i=0; while [ "$i" -lt ${b64Chunks.length} ]; do rm -f ${qpartPrefix}$i; i=$((i+1)); done`
    res = await step(finalCmd)
    if (!res.succeeded) return res
  }
  return ok(undefined)
}

// Resolve the shell's deferred (inline) profile files and write them into a
// box that already exists (reuse/resume paths). No-op unless the shell opts
// into deferProfileFiles. Idempotent overwrite — a redeploy with new skills
// refreshes the corpus on the next ensure call.
// Box-metadata key holding the content hash of the deferred corpus that was
// written to the box at CREATE. On reuse, an unchanged hash means the skills are
// already on disk, so the (large, file-API) re-write can be skipped.
const DEFERRED_CORPUS_HASH_KEY = 'agentAppDeferredCorpusHash'

/** Stable content hash of the deferred file corpus (path + inline content).
 *  Unchanged corpus ⇒ same hash; a new/edited/removed skill ⇒ different hash.
 *  Exported for the reuse-skip test. */
export function deferredCorpusHash(files: AgentProfileFileMount[]): string {
  const norm = files
    .map((f) => ({
      p: f.path,
      c: f.resource.kind === 'inline' ? ((f.resource as { content?: string }).content ?? '') : `ref:${f.resource.kind}`,
    }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(norm), 'utf8').digest('hex')
}

async function materializeDeferredFilesForExistingBox(
  shell: SandboxRuntimeConfig,
  client: Sandbox,
  box: SandboxInstance,
  stage: ExistingBoxStage,
  name: string,
  workspaceId: string,
  userId: string | undefined,
): Promise<Outcome<SandboxInstance>> {
  if (!shell.deferProfileFiles) return ok(box)
  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId)
  const buildCtx: SandboxBuildContext = {
    workspaceId,
    connectedIntegrationIds,
    ...(userId ? { userId } : {}),
  }
  const files = await shell.files(buildCtx)
  const fullProfile = shell.profile({ extraFiles: files })
  const { deferredFiles } = splitDeferredProfileFiles(fullProfile)
  if (deferredFiles.length === 0) return ok(box)
  // Skip the whole re-write when the corpus is UNCHANGED since the box was
  // created with it. The skill corpus is large and the bulk goes through the
  // file API (writeMany) UNCONDITIONALLY, so re-writing it on every reuse adds
  // seconds of latency to each turn. The create payload stamps the corpus hash
  // into box metadata; a matching hash means the skills are already on disk.
  // Fail-safe: a missing or mismatched hash (e.g. a redeploy with new skills, or
  // a box created before this optimization) WRITES — a stale skip is never
  // risked. Reads metadata only, so no extra exec/round-trip.
  const stampedHash = (box.metadata as Record<string, unknown> | undefined)?.[DEFERRED_CORPUS_HASH_KEY]
  if (typeof stampedHash === 'string' && stampedHash === deferredCorpusHash(deferredFiles)) return ok(box)
  return writeDeferredFilesWithRuntimeAuthRefresh(client, box, deferredFiles, stage, name)
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

async function listStopped(
  client: Sandbox,
  name: string,
): Promise<Outcome<SandboxInstance | null>> {
  try {
    const stopped = await client.list({ status: 'stopped' })
    return ok(stopped.find((s) => s.name === name) ?? null)
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

// ---------------------------------------------------------------------------
// Provision-time S-cost gates. Both run immediately before `client.create` —
// each catches an input class that can NEVER produce a working sandbox, so
// failing at POST-time with actionable detail beats a platform 4xx (or a box
// that boots and then E2BIGs on every exec).

/** Gate on the provision body: the platform orchestrator caps the create
 *  payload at 256 KiB; 240 KB leaves headroom for transport framing. An
 *  over-cap payload fails provisioning 100% of the time (a 282 KB payload
 *  shipped once and no sandbox could ever be created). */
export const PROVISION_PAYLOAD_MAX_BYTES = 240_000

/** Per-variable env gate: the kernel rejects any single `NAME=value` env entry
 *  over MAX_ARG_STRLEN (131072 bytes) with E2BIG, killing every exec inside
 *  the box. 120 KB leaves headroom for the name and framing. */
export const ENV_VALUE_MAX_BYTES = 120_000

/** Total env gate: the whole environment block shares the payload budget with
 *  the profile; past 200 KB the provision body cannot stay under the cap. */
export const ENV_TOTAL_MAX_BYTES = 200_000

function utf8ByteLength(value: unknown): number {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value ?? null))
    .byteLength
}

/** Structural slice of the profile the payload gate reads: it only measures
 *  the profile's serialized size and names `resources.files` in the breakdown,
 *  so callers composing a payload outside the SDK (products, tests) can pass a
 *  plain object without casting through `AgentProfile`. */
export interface ProvisionProfileSection {
  resources?: { files?: readonly unknown[] }
}

/** The provision-payload sections the size gates need to see. Structural so
 *  the gate is testable without the SDK's (unexported) create-payload type. */
export interface ProvisionPayloadSections {
  env?: Record<string, string>
  secrets?: readonly string[]
  /** `profile` may also be a named-profile string ref (the SDK's
   *  `BackendConfig` union) — a string ref is tiny and has no files channel. */
  backend?: { profile?: string | ProvisionProfileSection }
}

/**
 * Throw when the serialized provision payload exceeds
 * {@link PROVISION_PAYLOAD_MAX_BYTES}. The error carries a per-section byte
 * breakdown (profile/files/env/secrets) so the offending channel is named, not
 * guessed.
 */
export function assertProvisionPayloadWithinCap(payload: ProvisionPayloadSections): void {
  const total = utf8ByteLength(payload)
  if (total <= PROVISION_PAYLOAD_MAX_BYTES) return
  const profile = payload.backend?.profile
  const files = (typeof profile === 'string' ? undefined : profile?.resources?.files) ?? []
  const breakdown =
    `profile=${utf8ByteLength(profile ?? null)}B ` +
    `(files=${utf8ByteLength(files)}B), ` +
    `env=${utf8ByteLength(payload.env ?? {})}B, ` +
    `secrets=${utf8ByteLength(payload.secrets ?? [])}B`
  throw new Error(
    `sandbox provision payload is ${total} bytes — over the ${PROVISION_PAYLOAD_MAX_BYTES}-byte gate ` +
      `(the platform caps the create body at 256 KiB; an over-cap payload can never create a sandbox). ` +
      `Breakdown: ${breakdown}. ` +
      `Hint: set deferProfileFiles: true or move content to resources.`,
  )
}

/**
 * Throw when any single env value exceeds {@link ENV_VALUE_MAX_BYTES} or the
 * whole env block exceeds {@link ENV_TOTAL_MAX_BYTES}, naming the offending
 * variable. This is the E2BIG incident class: the box may even provision, but
 * every exec inside it dies on the oversized entry.
 */
export function assertEnvWithinLimits(env: Record<string, string>): void {
  let total = 0
  let largest: { name: string; bytes: number } | null = null
  for (const [name, value] of Object.entries(env)) {
    const bytes = utf8ByteLength(`${name}=${value}`)
    total += bytes
    if (!largest || bytes > largest.bytes) largest = { name, bytes }
    if (bytes > ENV_VALUE_MAX_BYTES) {
      throw new Error(
        `sandbox env var ${name} is ${bytes} bytes — over the ${ENV_VALUE_MAX_BYTES}-byte gate ` +
          `(kernel MAX_ARG_STRLEN is 131072 bytes per env entry; anything larger E2BIGs every exec). ` +
          `Write large content to a file mount or resource instead of an env var.`,
      )
    }
  }
  if (total > ENV_TOTAL_MAX_BYTES) {
    const worst = largest ? ` Largest: ${largest.name} (${largest.bytes}B).` : ''
    throw new Error(
      `sandbox env block is ${total} bytes total — over the ${ENV_TOTAL_MAX_BYTES}-byte gate.${worst} ` +
        `Write large content to a file mount or resource instead of env vars.`,
    )
  }
}

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
type RuntimeConnectionFields = SandboxConnection & {
  sidecarUrl?: string
  authToken?: string
  sidecarToken?: string
  authTokenExpiresAt?: string | number | Date
  sidecarTokenExpiresAt?: string | number | Date
}

function sandboxRuntimeUrl(box: SandboxInstance): string | undefined {
  const connection: RuntimeConnectionFields | undefined = box.connection
  return connection?.sidecarUrl ?? connection?.runtimeUrl
}

function runtimeAuthExpiresAtMs(value: string | number | Date | undefined): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function hasFreshRuntimeExecAuth(box: SandboxInstance, now = Date.now()): boolean {
  const connection: RuntimeConnectionFields | undefined = box.connection
  const token = connection?.authToken ?? connection?.sidecarToken
  if (!sandboxRuntimeUrl(box) || !token) return false
  const expiresAt = runtimeAuthExpiresAtMs(
    connection?.authTokenExpiresAt ?? connection?.sidecarTokenExpiresAt,
  )
  return expiresAt === undefined || expiresAt > now + RUNTIME_AUTH_REFRESH_SKEW_MS
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

async function bestEffortRefreshRuntimeExecAuth(
  client: Sandbox,
  box: SandboxInstance,
  stage: ExistingBoxStage,
  name: string,
): Promise<Outcome<SandboxInstance>> {
  let current = box

  try {
    await current.refresh()
    if (hasFreshRuntimeExecAuth(current)) return ok(current)
  } catch (err) {
    if (isRuntimeAuthRefreshDenied(err)) {
      return fail(
        new SandboxRuntimeAuthRefreshError(
          stage,
          name,
          'runtime exec auth refresh was unauthorized',
          err,
        ),
      )
    }
  }

  try {
    const latest = await client.get(current.id)
    if (latest) current = latest
    if (hasFreshRuntimeExecAuth(current)) return ok(current)
  } catch (err) {
    if (isRuntimeAuthRefreshDenied(err)) {
      return fail(
        new SandboxRuntimeAuthRefreshError(
          stage,
          name,
          'runtime exec auth re-fetch was unauthorized',
          err,
        ),
      )
    }
  }

  return ok(current)
}

async function refreshRuntimeExecAuth(
  client: Sandbox,
  box: SandboxInstance,
  stage: ExistingBoxStage,
  name: string,
): Promise<Outcome<SandboxInstance>> {
  let current = box
  let lastError: unknown
  const deadline = Date.now() + RUNTIME_CONNECTION_WAIT_MS

  while (Date.now() < deadline) {
    try {
      await current.refresh()
      if (hasFreshRuntimeExecAuth(current)) return ok(current)

      const latest = await client.get(current.id)
      if (latest) current = latest
      if (hasFreshRuntimeExecAuth(current)) return ok(current)
    } catch (err) {
      lastError = err
    }

    await new Promise((resolve) => setTimeout(resolve, RUNTIME_CONNECTION_POLL_MS))
  }

  const detail = sandboxRuntimeUrl(current)
    ? 'runtime exec credentials are missing or expired after refresh'
    : 'runtime connection is missing after refresh'
  return fail(new SandboxRuntimeAuthRefreshError(stage, name, detail, lastError))
}

async function writeDeferredFilesWithRuntimeAuthRefresh(
  client: Sandbox,
  box: SandboxInstance,
  files: AgentProfileFileMount[],
  stage: ExistingBoxStage,
  name: string,
): Promise<Outcome<SandboxInstance>> {
  let writeBox = box

  if (!hasFreshRuntimeExecAuth(writeBox)) {
    const refreshed = await bestEffortRefreshRuntimeExecAuth(client, writeBox, stage, name)
    if (!refreshed.succeeded) return fail(refreshed.error)
    writeBox = refreshed.value
  }

  const first = await writeProfileFilesToBox(writeBox, files)
  if (first.succeeded) return ok(writeBox)
  if (!isRuntimeExecAuthError(first.error)) return fail(first.error)

  const refreshed = await refreshRuntimeExecAuth(client, writeBox, stage, name)
  if (!refreshed.succeeded) return fail(refreshed.error)

  const second = await writeProfileFilesToBox(refreshed.value, files)
  if (second.succeeded) return ok(refreshed.value)
  if (!isRuntimeExecAuthError(second.error)) return fail(second.error)

  return fail(
    new SandboxRuntimeAuthRefreshError(
      stage,
      name,
      'runtime exec remained unauthorized after auth refresh',
      second.error,
    ),
  )
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

// Resume a stopped box and wait for it to reach running.
async function resumeStoppedBox(
  box: SandboxInstance,
  timeoutMs: number,
  onProgress?: (event: ProvisionEvent) => void,
): Promise<Outcome<SandboxInstance>> {
  try {
    await box.resume()
    await box.waitFor('running', { timeoutMs, ...(onProgress ? { onProgress } : {}) })
    return ok(box)
  } catch (err) {
    return fail(err)
  }
}

/** Scope + the client and box key every workspace-scoped sandbox call needs.
 *  One place resolves credentials and derives the box name, so the ensure and
 *  peek paths cannot drift on which key a workspace's box lives under. */
async function resolveWorkspaceSandboxClient(
  shell: SandboxRuntimeConfig,
  workspaceId: string,
  userId: string | undefined,
): Promise<{ scope: SandboxScope; client: Sandbox; name: string }> {
  const scope: SandboxScope = { workspaceId, ...(userId ? { userId } : {}) }
  const creds = await shell.credentials(scope)
  if (!creds) throw new Error('sandbox credentials are required (apiKey/baseUrl)')
  return {
    scope,
    client: getClientFromCreds(creds),
    name: shell.boxKey ? shell.boxKey(scope) : shell.name(workspaceId),
  }
}

/** What a peek can find. `not-running` carries the platform's own state string
 *  (`stopped`, `starting`, `failed`, …) — narrowing it to a union here would
 *  drop states the platform adds later, and every caller wants it for a log. */
export type PeekWorkspaceSandboxOutcome =
  | { status: 'running'; box: SandboxInstance }
  | { status: 'not-running'; state: string; box: SandboxInstance }
  | { status: 'absent' }

/**
 * Read-only twin of {@link ensureWorkspaceSandbox}: report whether a
 * workspace's box exists and is running, WITHOUT provisioning, resuming, or
 * bootstrapping anything.
 *
 * This is what a read-mostly path needs — a file-index route's `authorize`
 * seam, a stale-lock reconciliation, a status badge. Calling `ensure` from one
 * of those spins a box up as a side effect of a read (legal-agent #509), and
 * costs the caller a cold start it never asked for.
 *
 * Matching is on BOTH the box key and the display name, IN THAT ORDER.
 * `client.get(id)` keys on the platform's opaque sandbox id, not the
 * deterministic key a product derives from a workspace, and is itself a
 * `list().find` underneath — so a lookup by identity has to list and match.
 * Provisioning here always stamps `name` with the box key, so the key is the
 * authoritative match; the display-name pass exists only to adopt boxes on a
 * host that predates that convention. The order matters: a single unordered
 * `find` returns whichever the platform happens to list first, so a stopped
 * display-name box could shadow a running box-key one and report
 * `not-running` for a live workspace.
 *
 * Unlike `ensure`, this lists ALL statuses in one call: distinguishing "no box"
 * from "box is stopped" is the whole point, and a status-filtered list cannot.
 *
 * A `client.list()` rejection propagates RAW, unlike the `Outcome`-wrapping
 * helpers `ensure` uses internally. That is deliberate: there is no honest
 * outcome to map a listing failure onto — it is not `absent` and not
 * `not-running`, and inventing one would have callers act on a status the
 * platform never reported. Callers that must tolerate it say so explicitly
 * (the stale-turn-lock policy documents "a throw is treated as unreachable").
 */
export async function peekWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: { workspaceId: string; userId?: string },
): Promise<PeekWorkspaceSandboxOutcome> {
  const { client, name } = await resolveWorkspaceSandboxClient(shell, options.workspaceId, options.userId)
  const displayName = shell.name(options.workspaceId)
  const boxes = await client.list()
  const match = boxes.find((box) => box.name === name) ?? boxes.find((box) => box.name === displayName)
  if (!match) return { status: 'absent' }
  if (match.status !== 'running') return { status: 'not-running', state: match.status, box: match }
  return { status: 'running', box: match }
}

export async function ensureWorkspaceSandbox(
  shell: SandboxRuntimeConfig,
  options: EnsureWorkspaceSandboxOptions,
): Promise<SandboxInstance> {
  const { workspaceId, userId, harness, forceNew, onProgress, billingOwnerId } = options
  const resolved = await resolveWorkspaceSandboxClient(shell, workspaceId, userId)
  const { scope, client } = resolved
  let name = resolved.name
  let recoveryRestore: SandboxRestoreSpec | null | undefined
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
        const written = await materializeDeferredFilesForExistingBox(
          shell,
          client,
          ready,
          'reused',
          name,
          workspaceId,
          userId,
        )
        if (!written.succeeded) {
          throw deferredProfileWriteFailed('reused', name, written.error)
        }
        const reusedBox = written.value
        if (shell.bootstrap) {
          const boot = await shell.bootstrap(reusedBox, scope)
          if (!boot.succeeded) {
            throw new Error(`bootstrap failed on reused box ${name}`, { cause: boot.error })
          }
        }
        return reusedBox
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
    const stopped = await listStopped(client, name)
    if (!stopped.succeeded) throw stopped.error
    if (stopped.value) {
      const resumed = await resumeStoppedBox(stopped.value, resumeTimeout, onProgress)
      if (!resumed.succeeded) {
        if (!shell.recoverStoppedSandbox) throw resumed.error
        const recovery = await shell.recoverStoppedSandbox({
          box: stopped.value,
          error: resumed.error,
          scope,
          boxKey: name,
        })
        if (!recovery.succeeded) throw recovery.error
        if (!recovery.value) throw resumed.error
        const replacementBoxKey = recovery.value.replacementBoxKey.trim()
        if (!replacementBoxKey || replacementBoxKey === name) {
          throw new Error(
            `stopped sandbox recovery must return a fresh replacement box key for ${name}`,
            { cause: resumed.error },
          )
        }
        name = replacementBoxKey
        recoveryRestore = recovery.value.restore
      } else {
        const box = await refreshRuntimeConnection(client, resumed.value)
        if (await isReusableBox(box, harness, shell.livenessProbe)) {
          const written = await materializeDeferredFilesForExistingBox(
            shell,
            client,
            box,
            'resumed',
            name,
            workspaceId,
            userId,
          )
          if (!written.succeeded) {
            throw deferredProfileWriteFailed('resumed', name, written.error)
          }
          const resumedBox = written.value
          if (shell.bootstrap) {
            const boot = await shell.bootstrap(resumedBox, scope)
            if (!boot.succeeded) {
              throw new Error(`bootstrap failed on resumed box ${name}`, { cause: boot.error })
            }
          }
          return resumedBox
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
  const restore = recoveryRestore === undefined ? shell.restore?.(buildCtx) : recoveryRestore

  const payload = {
    name,
    image: resources.image,
    // Stamp the deferred-corpus hash so a later REUSE can skip re-writing an
    // unchanged skill corpus (materializeDeferredFilesForExistingBox reads it).
    metadata: {
      ...shell.metadata(harness),
      ...(deferredFiles.length > 0 ? { [DEFERRED_CORPUS_HASH_KEY]: deferredCorpusHash(deferredFiles) } : {}),
    },
    idempotencyKey: name,
    // Passed through untyped (the SDK payload type predates it); the platform
    // authz-gates it server-side and ignores it when unsupported.
    ...(billingOwnerId ? { billingOwnerId } : {}),
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

  // S-cost gates: an oversized env entry (E2BIG class) or an over-cap
  // provision body can never produce a working sandbox — fail loud here,
  // before the POST, with the offending section named.
  assertEnvWithinLimits(env)
  // `?? {}` only narrows the SDK parameter's `| undefined`; the literal above
  // is always defined. The structural sections type needs no cast.
  assertProvisionPayloadWithinCap(payload ?? {})

  let box = await client.create(payload)

  await box.waitFor('running', { timeoutMs: 120_000, ...(onProgress ? { onProgress } : {}) })
  box = await refreshRuntimeConnection(client, box)

  if (deferredFiles.length > 0) {
    const written = await writeProfileFilesToBox(box, deferredFiles)
    if (!written.succeeded) {
      throw deferredProfileWriteFailed('new', name, written.error)
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
  // Omitted only under `allowKeylessModel` — keyless metadata tells the
  // sandbox platform to mint its own per-user router key for the box.
  apiKey?: string
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
  if (!provider || !modelName) return undefined
  if (!apiKey && !c.allowKeylessModel) return undefined
  return {
    model: modelName,
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
  }
}

// The SDK's SandboxInstance.streamPrompt/.prompt accept `string | PromptInputPart[]`
// but the published package does not re-export the PromptInputPart type by name from
// any of its entry points, so it's derived structurally off the method signature
// itself — this stays in lockstep with the SDK's actual accepted shape.
export type PromptInputPart = Extract<
  Parameters<SandboxInstance['streamPrompt']>[0],
  readonly unknown[]
>[number]

function historyTranscript(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  return history
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content}`)
    .join('\n\n')
}

export function flattenHistory(
  message: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  if (!history?.length) return message
  return `${historyTranscript(history)}\n\nUser: ${message}`
}

/**
 * History-aware equivalent of flattenHistory for multimodal prompt parts: the
 * transcript is folded into the first text part (image/file parts carry no
 * text to prepend to) rather than replacing the message wholesale.
 */
export function mergeHistoryIntoParts(
  parts: PromptInputPart[],
  history?: Array<{ role: 'user' | 'assistant'; content: string }>,
): PromptInputPart[] {
  if (!history?.length) return parts
  const textIndex = parts.findIndex((part) => part.type === 'text')
  if (textIndex === -1) {
    throw new Error('mergeHistoryIntoParts requires at least one text part to carry the history')
  }
  const textPart = parts[textIndex] as Extract<PromptInputPart, { type: 'text' }>
  const merged = [...parts]
  merged[textIndex] = { ...textPart, text: `${historyTranscript(history)}\n\nUser: ${textPart.text}` }
  return merged
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
  requireVisibleAssistantOutput?: boolean
  // When true, an interactive question event throws instead of yielding —
  // detached (cron/mission-step) runs have no consumer to answer it.
  disallowQuestions?: boolean
  // Per-turn question/permission/plan channel toggles, forwarded VERBATIM into the
  // backend config. agent-app does not validate kinds per harness — the sidecar fails
  // session init loudly for unsupported ones; a local matrix would drift. Only honored
  // on the streaming path; the detached driveTurn path (driveSandboxTurn) never sets it.
  interactions?: { question?: boolean; permission?: boolean; plan?: boolean }
  // Detach the run from THIS stream's lifetime. When true, dropping the stream —
  // a Worker/isolate restart, a browser refresh, a network blip — does NOT cancel
  // the run: the platform keeps executing it server-side and buffers its events,
  // so a later reconnect (same `sessionId` + `lastEventId`) replays the tail and
  // the run's result survives. This is what makes a WATCHED interactive turn
  // durable — the run no longer dies with the Worker that opened it — while still
  // streaming live (unlike the fire-and-forget `dispatchPrompt`/`driveTurn` path).
  // Omit for a run where closing the tab should stop burning tokens.
  detach?: boolean
}

type StreamPromptOptions = Parameters<SandboxInstance['streamPrompt']>[1]

export async function* streamSandboxPrompt(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string | PromptInputPart[],
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

  const prompt =
    typeof message === 'string'
      ? flattenHistory(message, options?.history)
      : mergeHistoryIntoParts(message, options?.history)

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
    ...(options?.requireVisibleAssistantOutput !== undefined
      ? { requireVisibleAssistantOutput: options.requireVisibleAssistantOutput }
      : {}),
    ...(options?.detach ? { detach: true } : {}),
    backend: {
      type: harness,
      profile: profileWithEffort,
      ...(model ? { model } : {}),
      ...(options?.interactions ? { interactions: options.interactions } : {}),
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
  message: string | PromptInputPart[],
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

export interface DriveSandboxTurnOptions extends StreamSandboxPromptOptions {
  /** Deterministic resume key — required. Every tick for the same logical turn
   * MUST reuse it so a crash + re-drive finds the in-flight session instead of
   * starting a second agent run. */
  sessionId: string
  /** Turn idempotency key for the platform's completed-turn cache. Defaults to
   * `sessionId` (correct for the one-turn-per-session shape detached drivers use). */
  turnId?: string
  /** Wall-clock cap in ms from the session's start. A still-running session past
   * the cap is cancelled and reported `failed` — bounds an unattended run (e.g. a
   * turn that stalled on an interactive question nothing will answer). Omit for no cap. */
  wallCapMs?: number
}

// One settle → poll → dispatch pass over a detached turn. Delegates to the SDK's
// `box.driveTurn` (@tangle-network/sandbox ≥ 0.10.5) — the turn runs
// fire-and-detached server-side and ONE invocation returns immediately with where
// it stands. It never awaits the whole turn in-process, so it does not hold the
// worker alive for the run's duration (the durability trap the older box.prompt
// implementation quietly caused).
//
// This is the durable path for cron / mission-step / queue callers: re-invoke on
// your own schedule (Workflow step, DO alarm, queue tick) with the SAME
// `sessionId`. Dispatch is idempotent on it, so a crash + re-drive is a lookup,
// not a second agent run.
//
// The Outcome boundary separates a retryable transport failure from a settled
// turn: `fail` means the drive call itself threw (network blip — retry the tick);
// `ok` carries the SDK's discriminated `TurnDriveResult` — inspect `.state`:
//   - `running`   → the turn is still executing; re-tick after a delay of your choosing.
//   - `completed` → terminal; `.text` / `.result` hold the payload.
//   - `failed`    → terminal and deterministic; re-invoking will not change it (do not retry).
export async function driveSandboxTurn(
  shell: SandboxRuntimeConfig,
  box: SandboxInstance,
  message: string | PromptInputPart[],
  options: DriveSandboxTurnOptions,
): Promise<Outcome<TurnDriveResult>> {
  const harness = options.harness ?? 'opencode'
  const model = resolveModel(shell.provider, {
    model: options.model,
    modelApiKey: options.modelApiKey,
  })
  if (model?.model) assertHarnessModelCompatible(harness, model.model)
  const prompt =
    typeof message === 'string'
      ? flattenHistory(message, options.history)
      : mergeHistoryIntoParts(message, options.history)
  const appToolMcp = options.appToolMcp ?? {}
  const extraMcp = mergeExtraMcp(appToolMcp, options.baseProfileMcp ?? {}, options.extraMcp)
  const profile = attachReasoningEffort(
    shell.profile({ systemPrompt: options.systemPrompt, extraMcp }),
    harness,
    options.effort,
  )
  try {
    const drive = await box.driveTurn(prompt, {
      sessionId: options.sessionId,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      ...(options.wallCapMs !== undefined ? { wallCapMs: options.wallCapMs } : {}),
      ...(options.executionId ? { executionId: options.executionId } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      // Deliberately NO `interactions` here: detached turns (cron / mission steps) have
      // no consumer to answer a question. Interactive Q&A is streaming-path only.
      backend: { type: harness, profile, ...(model ? { model } : {}) },
    } as Parameters<SandboxInstance['driveTurn']>[1])
    return ok(drive)
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
  // Generic structured-interaction event (BackendConfig.interactions kinds surface as
  // `interaction` events with a `kind` discriminator); treat kind:"question" as a question.
  if (type === 'interaction' && body.kind === 'question') return firstQuestionText(body)
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
