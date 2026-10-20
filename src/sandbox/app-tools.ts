import { type AppToolName, type AppToolContext, type ToolHeaderNames, buildAppToolMcpServer } from '../tools/index'
import type { AgentProfileMcpServer, AgentProfileFileMount } from '@tangle-network/agent-interface'
import { shellSingleQuote } from './shell-path'
import type { SandboxInstance } from '@tangle-network/sandbox'
import { type Outcome, fail, ok } from './outcome'

/** Describe an application tool with its name, unique key, and description */
export interface AppToolDescriptor {
  tool: AppToolName
  key: string
  description: string
}

/** Define options for building MCP server configurations in the app tool environment */
export interface BuildAppToolMcpServersOptions {
  tools: AppToolDescriptor[]
  baseUrl: string
  /**
   * NAME of the box-environment variable holding the capability token — never
   * the token itself. Every emitted `Authorization` header is a `secret-ref` to
   * this key, which the sandbox resolves privately; see
   * `BuildHttpMcpServerOptions.tokenEnvKey` in `../tools/mcp`.
   *
   * The key must name a variable the box carries — placed by
   * {@link SandboxRuntimeConfig.env} at creation, refreshed by
   * {@link SandboxRuntimeConfig.runtimeEnv} before retained-box bootstrap, or
   * injected from the platform secret store via
   * {@link SandboxRuntimeConfig.secrets}.
   */
  tokenEnvKey: string
  ctx: AppToolContext
  headerNames?: ToolHeaderNames
}

/** Build a mapping of MCP server profiles keyed by tool identifiers from provided options */
export function buildAppToolMcpServers(
  options: BuildAppToolMcpServersOptions,
): Record<string, AgentProfileMcpServer> {
  const entries: Record<string, AgentProfileMcpServer> = {}
  for (const { tool, key, description } of options.tools) {
    // No cast: since the tagged-config contract (agent-interface 0.38.0) the
    // builder's own return type IS an AgentProfileMcpServer. The cast that used
    // to sit here is what let the pre-0.38.0 plain-string shape ship.
    entries[key] = buildAppToolMcpServer({
      tool,
      baseUrl: options.baseUrl,
      tokenEnvKey: options.tokenEnvKey,
      ctx: options.ctx,
      description,
      headerNames: options.headerNames,
    })
  }
  return entries
}

/** Define the specification for a sandbox tool including its name, content, and optional executability */
export interface SandboxToolSpec {
  name: string
  content: string
  executable?: boolean
}

/** Define options for resolving sandbox tool paths including appName, baseDir, and binDir */
export interface SandboxToolPathOptions {
  appName: string
  baseDir?: string
  binDir?: string
}

/** Define options for building sandbox tool file mounts including tool specifications and paths */
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

/** Resolve the root directory path for a sandbox tool based on provided options */
export function sandboxToolRootDir(options: SandboxToolPathOptions): string {
  const appName = normalizeSandboxToolSegment(options.appName, 'sandbox tool appName')
  const baseDir = normalizeSandboxToolDir(
    options.baseDir ?? DEFAULT_SANDBOX_TOOL_BASE_DIR,
    'sandbox tool baseDir',
  )
  return `${baseDir}/${appName}`
}

/** Resolve the binary directory path for a sandbox tool based on provided options */
export function sandboxToolBinDir(options: SandboxToolPathOptions): string {
  normalizeSandboxToolSegment(options.appName, 'sandbox tool appName')
  if (options.binDir) return normalizeSandboxToolDir(options.binDir, 'sandbox tool binDir')
  return `${sandboxToolRootDir(options)}/bin`
}

/** Resolve the file system path to a specified sandbox tool based on given options */
export function sandboxToolPath(options: SandboxToolPathOptions & { toolName: string }): string {
  const toolName = normalizeSandboxToolSegment(options.toolName, 'sandbox tool name')
  return `${sandboxToolBinDir(options)}/${toolName}`
}

/** Build file mounts for sandbox tools based on provided options and tool configurations */
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

/**
 * Build the `SANDBOX_TOOL_BIN_DIRS` entry that puts these apps' tool bin dirs on
 * a sandbox PATH. Declare it in the same box env as the mounts from
 * {@link buildSandboxToolFileMounts}: the mounts place the executables, this
 * places the directory that makes a bare tool name resolve.
 *
 * Every sandbox PATH builder appends these directories at the TAIL, after the
 * Nix, npm, and image entries, so a tool never shadows a platform or system
 * binary of the same name. That placement is identical for a non-interactive
 * exec, a sidecar-spawned CLI, and an SSH shell, which is why this variable and
 * not a shell rc file is the mechanism: an exec reads no rc file, and the SSH
 * shell environment assigns PATH absolutely.
 *
 * Entries come from {@link sandboxToolBinDir}, so the value can never name a
 * directory the mounts did not use — a caller that hand-writes the literal
 * instead drifts silently the moment a base dir changes. Order is preserved,
 * and two apps that resolve to one directory collapse to the FIRST position it
 * appeared in.
 *
 * A `:` in a resolved bin dir throws here. The character separates entries both
 * in this variable and in PATH itself, so such a directory is unrepresentable
 * rather than merely awkward: joining it would split one absolute path into a
 * leading path and a relative remainder, and the runtime rejects a relative
 * segment by failing the whole box. Throwing names the offending directory
 * instead.
 *
 * The consuming half lives in agent-container: `resolveSandboxToolBinDirs`
 * parses this value and every PATH builder appends it at the tail — sidecar
 * exec and PTY through `packages/shared/src/cache-env.ts`, an SSH session
 * through `packages/shared/src/ssh-bootstrap.ts`, and a spawned CLI through
 * `packages/sdk-cli-runner/src/cli-process.ts`, each with its own tests. This
 * package has no sandbox runtime, so tail placement is pinned there, not here.
 */
export function buildSandboxToolBinDirsEnv(
  apps: readonly SandboxToolPathOptions[],
): { SANDBOX_TOOL_BIN_DIRS: string } {
  if (apps.length === 0) {
    throw new Error(
      'buildSandboxToolBinDirsEnv: name at least one app whose tool bin dir belongs on PATH.',
    )
  }
  const binDirs = new Set<string>()
  for (const app of apps) {
    const binDir = sandboxToolBinDir(app)
    if (binDir.includes(':')) {
      throw new Error(
        `sandbox tool bin dir ${binDir} contains ':', which separates entries in ` +
          'SANDBOX_TOOL_BIN_DIRS and in PATH. Place the tools under a colon-free directory.',
      )
    }
    binDirs.add(binDir)
  }
  return { SANDBOX_TOOL_BIN_DIRS: [...binDirs].join(':') }
}

/**
 * Build a shell script that creates the sandbox tool binary directory.
 * {@link buildSandboxToolBinDirsEnv}, not this script, puts that directory on a
 * sandbox PATH.
 *
 * The `mkdir -p` makes the directory exist before a tool mount lands in it.
 */
export function buildSandboxToolBinDirScript(options: SandboxToolPathOptions): string {
  return ['set -eu', `mkdir -p ${shellSingleQuote(sandboxToolBinDir(options))}`].join('\n')
}

/** Build a shell script that creates the sandbox tool binary directory.
 *
 *  @deprecated Renamed to {@link buildSandboxToolBinDirScript}, and the script
 *  no longer appends the bin dir to PATH in `~/.profile`, `~/.bashrc` and
 *  `~/.zshrc`. Those edits never reached the contexts that run a tool: an exec
 *  and a spawned CLI read no rc file, and the SSH shell assigns PATH
 *  absolutely, which discards an appended entry. Put the directory on PATH with
 *  {@link buildSandboxToolBinDirsEnv} instead. This name forwards to the new
 *  one so an existing import keeps resolving; removal is a major.
 */
export function buildSandboxToolPathSetupScript(options: SandboxToolPathOptions): string {
  return buildSandboxToolBinDirScript(options)
}

/**
 * Create the sandbox tool binary directory in a running box.
 * {@link buildSandboxToolBinDirsEnv}, not this call, puts it on a sandbox PATH.
 */
export async function ensureSandboxToolBinDir(
  box: SandboxInstance,
  options: SandboxToolPathOptions,
): Promise<Outcome<void>> {
  try {
    const res = await box.exec(buildSandboxToolBinDirScript(options))
    if (res.exitCode !== 0) {
      return fail(
        new Error(
          `ensureSandboxToolBinDir: failed to create the tool bin dir ${sandboxToolBinDir(options)} ` +
            `(exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`,
        ),
      )
    }
    return ok(undefined)
  } catch (err) {
    return fail(new Error('ensureSandboxToolBinDir: exec failed', { cause: err }))
  }
}

/** Create the sandbox tool binary directory in a running box.
 *
 *  @deprecated Renamed to {@link ensureSandboxToolBinDir}, and the call no
 *  longer appends the bin dir to PATH in `~/.profile`, `~/.bashrc` and
 *  `~/.zshrc`. Those edits never reached the contexts that run a tool: an exec
 *  and a spawned CLI read no rc file, and the SSH shell assigns PATH
 *  absolutely, which discards an appended entry. Put the directory on PATH with
 *  {@link buildSandboxToolBinDirsEnv} instead. This name forwards to the new
 *  one so an existing import keeps resolving; removal is a major.
 */
export async function runSandboxToolPathSetup(
  box: SandboxInstance,
  options: SandboxToolPathOptions,
): Promise<Outcome<void>> {
  return ensureSandboxToolBinDir(box, options)
}
