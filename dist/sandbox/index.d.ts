import { Sandbox } from '@tangle-network/sandbox/core';
import type { EgressPolicy, MintScopedTokenOptions, SandboxInstance, ScopedTokenScope, StorageConfig, TurnDriveResult, ProvisionEvent } from '@tangle-network/sandbox';
import type { AgentProfile, AgentProfileFileMount, AgentProfileMcpServer, ReasoningEffort } from '@tangle-network/agent-interface';
import { type AppToolName, type AppToolContext, type ToolHeaderNames } from '../tools/index';
import { type Harness } from '../harness/index';
import { type TangleExecutionEnvironment } from '../runtime/model';
import { type Outcome } from './outcome';
import { type ProfileFingerprint } from '../profile/fingerprint';
import { type ComposeProfileBudget } from '../profile/budget';
import { resolveModel, resolveModelSelection, requireTransportableModel, SandboxModelResolutionError, type ProviderResolutionConfig, type ResolvedModel, type ModelSelection, type ModelSelectionFailure, type ModelSelectionError, type ModelSelectionSource } from './model';
export type { Outcome } from './outcome';
export * from './binary-read';
export { resolveModel, resolveModelSelection, requireTransportableModel, SandboxModelResolutionError, };
export type { ProviderResolutionConfig, ResolvedModel, ModelSelection, ModelSelectionFailure, ModelSelectionError, ModelSelectionSource, };
/** Define client credentials for accessing the sandbox environment with API key and base URL */
export interface SandboxClientCredentials {
    apiKey: string;
    baseUrl: string;
}
/**
 * Sandbox credential policy reuses the canonical execution-environment union
 * (development/test/staging/production) so env classification stays in one place
 * (see resolveTangleExecutionEnvironment in runtime/model).
 */
export type SandboxCredentialEnvironment = TangleExecutionEnvironment;
/** Resolve options for obtaining sandbox client credentials from environment variables and classification */
export interface ResolveSandboxClientCredentialsOptions {
    /**
     * Environment object to read from. Defaults to process.env when available.
     */
    env?: Record<string, string | undefined>;
    /**
     * Explicit environment classification. Defaults to APP_ENV/NODE_ENV derived
     * behavior: local/development/test use direct env credentials; staging/prod
     * require the provision callback unless allowDirectEnvCredentials opts in.
     */
    environment?: SandboxCredentialEnvironment;
    /**
     * Env names that may carry a sandbox-compatible bearer. The first non-empty
     * value wins when direct env credentials are allowed.
     */
    directKeyNames?: readonly string[];
    /**
     * Env names that may carry the sandbox gateway URL. The first non-empty value
     * wins, then defaultBaseUrl.
     */
    baseUrlNames?: readonly string[];
    /**
     * Base URL used when none of baseUrlNames are present.
     */
    defaultBaseUrl?: string;
    /**
     * Whether direct env credentials are allowed for this environment. Defaults
     * to true in development/test and false in staging/production.
     */
    allowDirectEnvCredentials?: boolean | ((environment: SandboxCredentialEnvironment) => boolean);
    /**
     * Product-owned provision path, usually minting a per-user sandbox key from a
     * linked platform account. Called before direct env credentials in
     * staging/production and after direct env credentials in development/test.
     */
    provision?: (context: {
        environment: SandboxCredentialEnvironment;
        env: Record<string, string | undefined>;
    }) => SandboxClientCredentials | null | undefined | Promise<SandboxClientCredentials | null | undefined>;
}
/** Resolve sandbox client credentials based on environment and provided options asynchronously */
export declare function resolveSandboxClientCredentials(options?: ResolveSandboxClientCredentialsOptions): Promise<SandboxClientCredentials>;
/** Define configuration parameters for sandbox resource allocation and lifecycle management */
export interface SandboxResourceConfig {
    image: string;
    cpuCores: number;
    memoryMB: number;
    diskGB: number;
    maxLifetimeSeconds: number;
    idleTimeoutSeconds: number;
}
/** Define the context for building a sandbox including workspace, integrations, and optional user ID */
export interface SandboxBuildContext {
    workspaceId: string;
    connectedIntegrationIds: string[];
    userId?: string;
}
/** Hosts required when a product installs its pinned Python tooling at boot. */
export declare const PYPI_EGRESS_DOMAINS: readonly ['pypi.org', 'files.pythonhosted.org', 'pypi.python.org'];
export declare function buildProductEgressPolicy(publicOrigin: string | URL, extraDomains?: readonly string[]): EgressPolicy;
export type { StorageConfig };
/** Define a scope containing workspace and optional user identifiers for sandbox environments */
export interface SandboxScope {
    workspaceId: string;
    userId?: string;
}
/** Define the specification for restoring a sandbox from a snapshot or another sandbox ID */
export interface SandboxRestoreSpec {
    fromSnapshot: string;
    fromSandboxId: string;
}
/** Describe the failure details when resuming a stopped sandbox instance */
export interface StoppedSandboxResumeFailure {
    box: SandboxInstance;
    error: Error;
    scope: SandboxScope;
    boxKey: string;
}
/** Describe a sandbox that disappeared after the platform listed it. */
export interface MissingSandboxFailure extends StoppedSandboxResumeFailure {
    stage: SandboxExistingBoxStage;
}
/** Define the structure for resuming a stopped sandbox with replacement key and optional restore options */
export interface StoppedSandboxResumeRecovery {
    replacementBoxKey: string;
    restore?: SandboxRestoreSpec | null;
}
/** Configure runtime exec verification before reusing a sandbox. */
export interface LivenessProbeConfig {
    /** Process timeout passed to the Sandbox SDK. Defaults to 5 seconds.
     * SDK readiness and transport deadlines also apply. */
    execTimeoutMs?: number;
    /**
     * Reuse a successful liveness result for this many milliseconds for the
     * same box id. Defaults to 5 seconds; set to 0 to probe on every reuse.
     *
     * Only the exec probe is cached. Runtime readiness, egress policy,
     * deferred-file materialization, and bootstrap still run on every reuse.
     * A box that dies during this window is surfaced by the next dispatch and
     * is probed again after the TTL; the cache never triggers box deletion.
     */
    cacheTtlMs?: number;
}
/** Define options for composing a user profile including prompts, files, servers, and name */
export interface ProfileComposeOptions {
    systemPrompt?: string;
    extraFiles?: AgentProfileFileMount[];
    extraMcp?: Record<string, AgentProfileMcpServer>;
    name?: string;
    /**
     * The harness this profile is being composed for.
     *
     * Where a resource lands is harness-specific — skills resolve to
     * `.opencode/skills/`, `.claude/skills/`, `.pi/skills/`, and so on
     * (`skillDirForHarness`), and some harnesses take no cwd skills at all.
     * Without this, an app composing a profile cannot place a harness-native
     * resource and is pushed into hardcoding one harness's path, which then
     * silently disagrees with the path its own prompt cites: the agent is told
     * to read a directory nothing was written to and its skills are invisible.
     * Prefer declaring `resources.skills` and letting the platform place them;
     * use this when composing paths directly.
     */
    harness: Harness;
}
/** Define runtime configuration methods for sandbox environments including credentials, metadata, and permissions */
export interface SandboxRuntimeConfig {
    credentials: (scope?: SandboxScope) => SandboxClientCredentials | null | Promise<SandboxClientCredentials | null>;
    name: (workspaceId: string) => string;
    metadata: (harness: Harness) => Record<string, unknown>;
    connectedIntegrationIds: (workspaceId: string) => Promise<string[]>;
    /**
     * Creation-only environment. Use runtimeEnv for expiring app credentials.
     * Values remain private; profiles reference their names through secret-ref.
     * Workspace-wide values cannot carry per-user or per-resource authority.
     */
    env: (ctx: SandboxBuildContext) => Promise<Record<string, string>>;
    /**
     * Workspace app credentials resolved on creation and before every reuse,
     * resume, or recovery. Fresh values override env in the creation payload.
     * The SDK updates retained runtimes before bootstrap and refuses runtime-managed keys.
     * Throw when required credentials cannot be minted; renewal failure preserves
     * the sandbox and prevents dispatch. Requires the matching Sandbox runtime.
     */
    runtimeEnv?: (scope: SandboxScope) => Promise<Record<string, string>>;
    files: (ctx: SandboxBuildContext) => Promise<AgentProfileFileMount[]>;
    secrets: (workspaceId: string) => Promise<string[]>;
    profile: (options: ProfileComposeOptions) => AgentProfile;
    permissionRole?: (workspaceRole: string) => SandboxPermissionLevel;
    resources?: SandboxResourceConfig;
    provider?: ProviderResolutionConfig;
    /**
     * Portable directory where the sandbox starts its agent processes.
     *
     * The value is relative to the sandbox workspace. The sandbox platform
     * validates it and applies it when the box is created.
     */
    cwd?: string;
    /**
     * Product-declared outbound network policy. Applied when a sandbox is
     * created. A reused or resumed sandbox is returned only when its explicit
     * policy already matches; existing mismatches are rejected without updating
     * or deleting the sandbox unless migration is explicitly enabled below.
     */
    egressPolicy?: EgressPolicy;
    /**
     * Update an existing box to {@link egressPolicy} before reuse when its
     * recorded policy is absent or different. This is an explicit fleet
     * migration switch: the updated policy is read back and must match before
     * the box is returned. It never deletes the box.
     */
    migrateEgressPolicy?: boolean;
    storage?: (ctx: SandboxBuildContext) => StorageConfig | undefined;
    restore?: (ctx: SandboxBuildContext) => SandboxRestoreSpec | undefined;
    boxKey?: (scope: SandboxScope) => string;
    childKeyMint?: (scope: SandboxScope) => Promise<Outcome<string>>;
    bootstrap?: (box: SandboxInstance, scope: SandboxScope) => Promise<Outcome<void>>;
    livenessProbe?: LivenessProbeConfig;
    webTerminalEnabled?: boolean;
    resumeStopped?: boolean;
    /**
     * How long to wait for a box to reach `running`, in ms. Default 120_000.
     *
     * Raise it when a cold create legitimately takes longer than that — a large
     * vault restore, a heavy image, a loaded fleet. The failure it prevents is
     * ugly: every attempt burns the full wait, times out, and the NEXT attempt
     * starts the same slow create from scratch, so a workspace whose provision
     * takes 130s never succeeds no matter how many times a user retries.
     */
    provisionTimeoutMs?: number;
    replaceUnbringableBox?: boolean;
    recoverStoppedSandbox?: (failure: StoppedSandboxResumeFailure) => Promise<Outcome<StoppedSandboxResumeRecovery | null>>;
    /**
     * Replace a sandbox resource or backing container that disappears after listing.
     *
     * The shell calls this for a sandbox resource 404 or an exact resume 500 that
     * wraps a host-agent container 404. It excludes runtime 404 and unrelated
     * reuse failures. Return a fresh key without deleting the stale sandbox record.
     */
    recoverMissingSandbox?: (failure: MissingSandboxFailure) => Promise<Outcome<StoppedSandboxResumeRecovery | null>>;
    backendModelAtCreate?: boolean;
    deferProfileFiles?: boolean;
    promptBudget?: ComposeProfileBudget;
}
/** Define default resource limits and settings for sandbox environments */
export declare const DEFAULT_SANDBOX_RESOURCES: SandboxResourceConfig;
/** Resolve a synchronous sandbox client from provided runtime configuration credentials */
export declare function getClient(shell: SandboxRuntimeConfig): Sandbox;
/** Reset the process-local sandbox client and liveness-verification caches. */
export declare function resetClientCache(): void;
/** Describe an application tool with its name, unique key, and description */
export interface AppToolDescriptor {
    tool: AppToolName;
    key: string;
    description: string;
}
/** Define options for building MCP server configurations in the app tool environment */
export interface BuildAppToolMcpServersOptions {
    tools: AppToolDescriptor[];
    baseUrl: string;
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
    tokenEnvKey: string;
    ctx: AppToolContext;
    headerNames?: ToolHeaderNames;
}
/** Build a mapping of MCP server profiles keyed by tool identifiers from provided options */
export declare function buildAppToolMcpServers(options: BuildAppToolMcpServersOptions): Record<string, AgentProfileMcpServer>;
/** Define options for ensuring a workspace sandbox with provisioning and progress handling */
export interface EnsureWorkspaceSandboxOptions {
    workspaceId: string;
    userId?: string;
    harness: Harness;
    forceNew?: boolean;
    onProgress?: (event: ProvisionEvent) => void;
    billingOwnerId?: string;
    spend?: SandboxSpendHooks;
}
/** What `/sandbox` reports once a box is provisioned, reused, or resumed. */
export interface SandboxProvisionedObservation {
    readonly workspaceId: string;
    readonly userId?: string;
    /** The platform's sandbox id — the join key to every settlement row. */
    readonly sandboxId: string;
    /** The deterministic box key this workspace resolves to. */
    readonly boxKey?: string | undefined;
    /** The idle timeout this box was asked to run with, seconds. */
    readonly idleTimeoutSeconds: number;
    /** The max lifetime it was asked to run with, seconds, when one was asked for. */
    readonly maxLifetimeSeconds?: number | undefined;
    readonly at: number;
}
/**
 * Optional spend-verification seam on `ensureWorkspaceSandbox`.
 *
 * The two halves have deliberately opposite failure contracts.
 * `beforeProvision` is a GATE: it runs before anything is created and its throw
 * propagates, because refusing to provision is the whole point of a budget cap.
 * `onProvisioned` is an OBSERVER: its failures are swallowed, because
 * bookkeeping must never take down the provisioning it is bookkeeping.
 */
export interface SandboxSpendHooks {
    /** Runs before any create, resume, or reuse. Throw to refuse provisioning. */
    beforeProvision?(input: {
        workspaceId: string;
        userId?: string;
    }): Promise<void> | void;
    /** Runs after a box is available. Throwing here cannot fail the provision. */
    onProvisioned?(observation: SandboxProvisionedObservation): Promise<void> | void;
    /**
     * The box is doing work. Fired by the turn primitives at the start of a turn
     * and again when it settles.
     *
     * Deliberately SYNCHRONOUS and unawaited — this sits on the turn path, and a
     * store write must not add latency to it or hold a stream open. An
     * implementation that persists should enqueue and return; errors are
     * swallowed here as they are for `onProvisioned`.
     *
     * Wiring it is what keeps the expectation ceiling honest for long turns:
     * without it, `lastActivityAt` only advances when a box is provisioned, so a
     * three-hour turn leaves the ceiling three hours too tight and manufactures a
     * discrepancy out of the product's own silence.
     */
    onActivity?(input: {
        sandboxId: string;
        at: number;
    }): void;
}
/** Define the specification for a sandbox tool including its name, content, and optional executability */
export interface SandboxToolSpec {
    name: string;
    content: string;
    executable?: boolean;
}
/** Define options for resolving sandbox tool paths including appName, baseDir, and binDir */
export interface SandboxToolPathOptions {
    appName: string;
    baseDir?: string;
    binDir?: string;
}
/** Define options for building sandbox tool file mounts including tool specifications and paths */
export interface BuildSandboxToolFileMountsOptions extends SandboxToolPathOptions {
    tools: readonly SandboxToolSpec[];
}
/** Resolve the root directory path for a sandbox tool based on provided options */
export declare function sandboxToolRootDir(options: SandboxToolPathOptions): string;
/** Resolve the binary directory path for a sandbox tool based on provided options */
export declare function sandboxToolBinDir(options: SandboxToolPathOptions): string;
/** Resolve the file system path to a specified sandbox tool based on given options */
export declare function sandboxToolPath(options: SandboxToolPathOptions & {
    toolName: string;
}): string;
/** Build file mounts for sandbox tools based on provided options and tool configurations */
export declare function buildSandboxToolFileMounts(options: BuildSandboxToolFileMountsOptions): AgentProfileFileMount[];
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
 * The consuming half lives in agent-dev-container: `resolveSandboxToolBinDirs`
 * parses this value and every PATH builder appends it at the tail — sidecar
 * exec and PTY through `packages/shared/src/cache-env.ts`, an SSH session
 * through `packages/shared/src/ssh-bootstrap.ts`, and a spawned CLI through
 * `packages/sdk-cli-runner/src/cli-process.ts`, each with its own tests. This
 * package has no sandbox runtime, so tail placement is pinned there, not here.
 */
export declare function buildSandboxToolBinDirsEnv(apps: readonly SandboxToolPathOptions[]): {
    SANDBOX_TOOL_BIN_DIRS: string;
};
/**
 * Build a shell script that creates the sandbox tool binary directory.
 * {@link buildSandboxToolBinDirsEnv}, not this script, puts that directory on a
 * sandbox PATH.
 *
 * The `mkdir -p` makes the directory exist before a tool mount lands in it.
 */
export declare function buildSandboxToolBinDirScript(options: SandboxToolPathOptions): string;
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
export declare function buildSandboxToolPathSetupScript(options: SandboxToolPathOptions): string;
/**
 * Create the sandbox tool binary directory in a running box.
 * {@link buildSandboxToolBinDirsEnv}, not this call, puts it on a sandbox PATH.
 */
export declare function ensureSandboxToolBinDir(box: SandboxInstance, options: SandboxToolPathOptions): Promise<Outcome<void>>;
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
export declare function runSandboxToolPathSetup(box: SandboxInstance, options: SandboxToolPathOptions): Promise<Outcome<void>>;
/** Split profile files into inline deferred files and a lean profile without them */
export declare function splitDeferredProfileFiles(profile: AgentProfile): {
    leanProfile: AgentProfile;
    deferredFiles: AgentProfileFileMount[];
};
export type SandboxExistingBoxStage = 'reused' | 'resumed';
export type SandboxEgressPolicySource = Awaited<ReturnType<SandboxInstance['egress']['get']>>['source'];
/**
 * Thrown when an existing sandbox cannot be proven to have the requested
 * outbound network policy. The sandbox is preserved and its policy is not
 * changed. The caller explicitly decides whether to preserve, migrate, or
 * replace the sandbox.
 */
export declare class SandboxEgressPolicyMismatchError extends Error {
    readonly stage: SandboxExistingBoxStage;
    readonly boxName: string;
    readonly currentPolicy: EgressPolicy;
    readonly currentSource: SandboxEgressPolicySource;
    readonly desiredPolicy: EgressPolicy;
    constructor(stage: SandboxExistingBoxStage, boxName: string, currentPolicy: EgressPolicy, currentSource: SandboxEgressPolicySource, desiredPolicy: EgressPolicy);
}
export * from './recovery';
export { serializeSandboxProvisioningError, formatSandboxProvisioningSupportDetails, formatSandboxProvisioningUserMessage, isSandboxAuthFailure, isSandboxApiBearerAuthFailure, isSandboxApiSandboxMissingFailure, SANDBOX_BACKING_CONTAINER_MISSING_CODE, isSandboxHostCapacityFailure, type SafeSandboxErrorCause, type SafeSandboxErrorDiagnostics, } from './diagnostics';
/** Represent an error thrown when sandbox runtime authentication refresh fails for a specific stage and name */
export declare class SandboxRuntimeAuthRefreshError extends Error {
    constructor(stage: SandboxExistingBoxStage, name: string, detail: string, cause?: unknown);
}
/** Which step of the state-preserving stop→resume recovery failed. `stop` with a
 *  driver-unsupported cause means the platform cannot restart this box (the
 *  `tangle` driver exposes create/delete only); `probe` means the box restarted
 *  but is still unresponsive. */
export type SandboxRecoveryPhase = 'stop' | 'resume' | 'probe';
/**
 * Thrown when an unresponsive box could not be recovered by a state-preserving
 * restart. Contract: this error is only ever thrown with the workspace intact —
 * recovery never deletes. The caller decides what to do next (retry, surface to
 * the user, or explicitly replace via `forceNew`).
 */
export declare class SandboxRecoveryFailedError extends Error {
    readonly boxKey: string;
    readonly stage: SandboxExistingBoxStage;
    readonly phase: SandboxRecoveryPhase;
    constructor(stage: SandboxExistingBoxStage, boxKey: string, phase: SandboxRecoveryPhase, detail: string, cause?: unknown);
}
/** Define options to control execution timeout, pacing, and retry behavior when writing profile files */
export interface WriteProfileFilesOptions {
    execTimeoutMs?: number;
    paceMs?: number;
    maxRetries?: number;
}
/** Write profile files to a sandbox with pacing, retries, and optional execution timeout handling */
export declare function writeProfileFilesToBox(box: SandboxInstance, files: AgentProfileFileMount[], options?: WriteProfileFilesOptions): Promise<Outcome<void>>;
/** Stable content hash of the deferred file corpus (path + inline content).
 *  Unchanged corpus ⇒ same hash; a new/edited/removed skill ⇒ different hash.
 *  Exported for the reuse-skip test. */
export declare function deferredCorpusHash(files: AgentProfileFileMount[]): string;
/** Gate on the provision body: the platform orchestrator caps the create
 *  payload at 256 KiB; 240 KB leaves headroom for transport framing. An
 *  over-cap payload fails provisioning 100% of the time (a 282 KB payload
 *  shipped once and no sandbox could ever be created). */
export declare const PROVISION_PAYLOAD_MAX_BYTES = 240000;
/** Per-variable env gate: the kernel rejects any single `NAME=value` env entry
 *  over MAX_ARG_STRLEN (131072 bytes) with E2BIG, killing every exec inside
 *  the box. 120 KB leaves headroom for the name and framing. */
export declare const ENV_VALUE_MAX_BYTES = 120000;
/** Default wait for a box to reach `running`. Overridable per shell via
 *  {@link SandboxRuntimeConfig.provisionTimeoutMs}. */
export declare const DEFAULT_PROVISION_TIMEOUT_MS = 120000;
/** Total env gate: the whole environment block shares the payload budget with
 *  the profile; past 200 KB the provision body cannot stay under the cap. */
export declare const ENV_TOTAL_MAX_BYTES = 200000;
/** Structural slice of the profile the payload gate reads: it only measures
 *  the profile's serialized size and names `resources.files` in the breakdown,
 *  so callers composing a payload outside the SDK (products, tests) can pass a
 *  plain object without casting through `AgentProfile`. */
export interface ProvisionProfileSection {
    resources?: {
        files?: readonly unknown[];
    };
}
/** The provision-payload sections the size gates need to see. Structural so
 *  the gate is testable without the SDK's (unexported) create-payload type. */
export interface ProvisionPayloadSections {
    env?: Record<string, string>;
    secrets?: readonly string[] | 'all';
    /** `profile` may also be a named-profile string ref (the SDK's
     *  `BackendConfig` union) — a string ref is tiny and has no files channel. */
    backend?: {
        profile?: string | ProvisionProfileSection;
    };
}
/**
 * Throw when the serialized provision payload exceeds
 * {@link PROVISION_PAYLOAD_MAX_BYTES}. The error carries a per-section byte
 * breakdown (profile/files/env/secrets) so the offending channel is named, not
 * guessed.
 */
export declare function assertProvisionPayloadWithinCap(payload: ProvisionPayloadSections): void;
/**
 * Throw when any single env value exceeds {@link ENV_VALUE_MAX_BYTES} or the
 * whole env block exceeds {@link ENV_TOTAL_MAX_BYTES}, naming the offending
 * variable. This is the E2BIG incident class: the box may even provision, but
 * every exec inside it dies on the oversized entry.
 */
export declare function assertEnvWithinLimits(env: Record<string, string>): void;
/** What a peek can find. `warming` means the control plane is running while
 *  the filesystem incarnation is still transitioning. `not-running` carries
 *  the platform's own state string (`stopped`, `starting`, `failed`, …) —
 *  narrowing it to a union here would drop states the platform adds later,
 *  and every caller wants it for a log. */
export type PeekWorkspaceSandboxOutcome = {
    status: 'running';
    box: SandboxInstance;
} | {
    status: 'warming';
    readiness: 'transitioning';
    box: SandboxInstance;
} | {
    status: 'not-running';
    state: string;
    box: SandboxInstance;
} | {
    status: 'absent';
};
/**
 * Read-only twin of {@link ensureWorkspaceSandbox}: report whether a
 * workspace's box exists and is fully ready, WITHOUT provisioning, resuming,
 * or bootstrapping anything.
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
export declare function peekWorkspaceSandbox(shell: SandboxRuntimeConfig, options: {
    workspaceId: string;
    userId?: string;
}): Promise<PeekWorkspaceSandboxOutcome>;
/** Reuse a workspace sandbox, or remove its previous runtime before provisioning a replacement. */
export declare function ensureWorkspaceSandbox(shell: SandboxRuntimeConfig, options: EnsureWorkspaceSandboxOptions): Promise<SandboxInstance>;
/** Extract a single element type from the array parameter of SandboxInstance's streamPrompt method */
export type PromptInputPart = Extract<Parameters<SandboxInstance['streamPrompt']>[0], readonly unknown[]>[number];
/** Build a single string combining conversation history and the current user message */
export declare function flattenHistory(message: string, history?: Array<{
    role: 'user' | 'assistant';
    content: string;
}>): string;
/**
 * History-aware equivalent of flattenHistory for multimodal prompt parts: the
 * transcript is folded into the first text part (image/file parts carry no
 * text to prepend to) rather than replacing the message wholesale.
 */
export declare function mergeHistoryIntoParts(parts: PromptInputPart[], history?: Array<{
    role: 'user' | 'assistant';
    content: string;
}>): PromptInputPart[];
/** Resolve conflicts and merge extra MCP profiles into the app tool MCP without overwriting existing keys */
export declare function mergeExtraMcp(appToolMcp: Record<string, AgentProfileMcpServer>, baseProfileMcp: Record<string, AgentProfileMcpServer>, extra: Record<string, AgentProfileMcpServer> | undefined): Record<string, AgentProfileMcpServer>;
/** Attach explicit effort through the portable model contract consumed by providers. */
export declare function attachReasoningEffort(profile: AgentProfile, _harness: Harness, effort: 'auto' | ReasoningEffort | undefined): AgentProfile;
export interface SandboxPromptTokenLimits {
    maxVisibleOutputTokens?: number;
    maxReasoningTokens?: number;
    maxTotalOutputTokens?: number;
}
/** Tighten the profile's provider-enforced token ceilings for one prompt. */
export declare function applyPromptTokenLimits(profile: AgentProfile, limits: SandboxPromptTokenLimits): AgentProfile;
/** Define options for configuring and controlling a streaming sandbox prompt session */
export interface StreamSandboxPromptOptions {
    /** Complete server-owned profile for this turn. Skips the shell's default composer.
     * Credentials, admission, session identity, and interactions remain execution options.
     * Explicit turn selections override this profile; otherwise its model and harness win
     * over shell defaults. Never populate this field from an untrusted request body. */
    profile?: AgentProfile;
    sessionId?: string;
    executionId?: string;
    /** Stable idempotency key for one logical dispatch. Reuse it with the same
     * `sessionId` when a caller may retry the initial request. */
    turnId?: string;
    lastEventId?: string;
    systemPrompt?: string;
    model?: string;
    modelApiKey?: string;
    history?: Array<{
        role: 'user' | 'assistant';
        content: string;
    }>;
    harness?: Harness;
    effort?: 'auto' | ReasoningEffort;
    /** Provider-enforced visible answer ceiling for this turn. */
    maxOutputTokens?: number;
    /** Provider-enforced hidden reasoning ceiling for this turn. */
    maxReasoningTokens?: number;
    /** Provider-enforced combined answer and reasoning ceiling for this turn. */
    maxTotalOutputTokens?: number;
    appToolMcp?: Record<string, AgentProfileMcpServer>;
    baseProfileMcp?: Record<string, AgentProfileMcpServer>;
    extraMcp?: Record<string, AgentProfileMcpServer>;
    signal?: AbortSignal;
    timeoutMs?: number;
    requireVisibleAssistantOutput?: boolean;
    disallowQuestions?: boolean;
    interactions?: {
        question?: boolean;
        permission?: boolean;
        plan?: boolean;
    };
    detach?: boolean;
    onProfileResolved?: (fingerprint: ProfileFingerprint) => void;
    spend?: SandboxSpendHooks;
}
/**
 * The small event shape consumed by agent-gateway's streaming adapters.
 *
 * Sandbox providers can add fields to their event payloads over time. This
 * adapter deliberately copies only the fields the gateway understands so
 * consumers do not each have to maintain a provider-to-gateway cast.
 */
export interface SandboxStreamEvent {
    type?: string;
    data?: {
        part?: {
            type?: string;
            text?: string;
        };
        delta?: string;
        finalText?: string;
        code?: string;
        message?: string;
        details?: Record<string, unknown>;
        inputRequired?: {
            prompt?: string;
        };
        usage?: {
            inputTokens?: number;
            outputTokens?: number;
            reasoningTokens?: number;
            toolTokens?: number;
            toolCallCount?: number;
            providerCostUsd?: number;
            budgetEnforced?: boolean;
        };
        tool?: {
            name?: string;
            inputTokens?: number;
            outputTokens?: number;
        };
        reasoning?: {
            tokens?: number;
        };
    };
}
/** Normalize raw sandbox events for shared agent-gateway consumers. */
export declare function adaptSandboxStream(events: AsyncIterable<unknown>): AsyncGenerator<SandboxStreamEvent>;
/** Configuration needed to prepare a turn without provisioning a workspace. */
export type SandboxPromptConfig = Pick<SandboxRuntimeConfig, 'provider' | 'deferProfileFiles' | 'promptBudget'> & Partial<Pick<SandboxRuntimeConfig, 'profile'>>;
/** Prepare one effective backend for SDK dispatch or product-specific transport.
 * Supply a server-owned profile, or a shell composer for the default profile.
 * Reuse the returned backend for preflight and dispatch so they inspect identical configuration.
 */
export declare function resolveSandboxPromptBackend(shell: SandboxPromptConfig, options: StreamSandboxPromptOptions, operation?: string): Promise<{
    type: Harness;
    profile: AgentProfile;
    model?: ResolvedModel | undefined;
    interactions?: {
        question?: boolean;
        permission?: boolean;
        plan?: boolean;
    } | undefined;
}>;
/** Resolve and stream AI-generated responses from a sandboxed environment based on input messages and options */
export declare function streamSandboxPrompt(shell: SandboxRuntimeConfig, box: SandboxInstance, message: string | PromptInputPart[], options?: StreamSandboxPromptOptions): AsyncGenerator<unknown>;
/**
 * Aggregate a sandbox prompt event stream down to the turn's one final answer.
 *
 * Exported SEPARATELY from `runSandboxPrompt` because the aggregation is pure —
 * `AsyncIterable<event> -> string` — while the streaming half is not: a product
 * that mounts per-turn MCP servers or resolves its harness per workspace wraps
 * `streamSandboxPrompt` in its own generator. Binding this logic to one stream
 * function is exactly what pushed three products into forking the whole thing,
 * bug and all. Take this over a local copy no matter whose generator you drive.
 *
 * Two rules earn their keep, and both were learned from the naive version:
 *
 * - Text accumulates PER PART ID, never into one running buffer, so two
 *   concurrent text parts cannot overwrite each other.
 * - A prompt echo is identified by CONTENT, never by arrival position. The
 *   "skip whichever text part arrives first" shortcut is wrong on both sandbox
 *   lanes: on the delta lane (`box.streamPrompt`, explicit deltas) the first
 *   part is the answer's opening token, so the answer silently loses it; and
 *   when the echo arrives AFTER the answer, the function returns the caller's
 *   own prompt as the agent's reply. Both failures produce a plausible-looking
 *   string, the worst shape for the unattended cron/judge turns this exists for.
 *
 * A blank-but-present `result.finalText` is ignored in favour of the streamed
 * text rather than overwriting a real answer with whitespace.
 *
 * @param events raw sandbox turn events, in order
 * @param message the prompt as handed to the stream, so an echo of it is dropped
 * @param history folded into the dispatched prompt by `streamSandboxPrompt`;
 *        pass whatever was passed there, since the echo replays the FOLDED text
 */
export declare function collectSandboxPromptText(events: AsyncIterable<unknown>, message: string | PromptInputPart[], history?: StreamSandboxPromptOptions['history']): Promise<string>;
/**
 * Resolve a sandbox prompt by streaming it and aggregating the turn down to one
 * final string. The shell's profile / model / MCP resolution and severed-stream
 * fail-loud come from `streamSandboxPrompt`; the aggregation is
 * `collectSandboxPromptText`, which products driving their own generator should
 * import directly.
 */
export declare function runSandboxPrompt(shell: SandboxRuntimeConfig, box: SandboxInstance, message: string | PromptInputPart[], options?: StreamSandboxPromptOptions): Promise<string>;
/** Define permission levels for sandbox access and control */
export type SandboxPermissionLevel = 'owner' | 'admin' | 'developer' | 'viewer';
/** Map workspace roles to corresponding sandbox permission levels */
export interface MemberSyncSeam {
    roleToSandboxRole: (workspaceRole: string) => SandboxPermissionLevel;
}
/** Resolve adding a user with a specific role to a sandbox and return the operation outcome */
export declare function syncSandboxMemberAdd(box: SandboxInstance, seam: MemberSyncSeam, userId: string, role: string): Promise<Outcome<void>>;
/** Remove a member from the sandbox while preserving their home directory and handle the outcome */
export declare function syncSandboxMemberRemove(box: SandboxInstance, userId: string): Promise<Outcome<void>>;
/** Synchronize a sandbox member's role by updating permissions based on the provided role mapping */
export declare function syncSandboxMemberRole(box: SandboxInstance, seam: MemberSyncSeam, userId: string, role: string): Promise<Outcome<void>>;
/**
 * Write-only secret port: create, replace, and delete a secret by name.
 *
 * There is no read method. The platform's secrets API returns names and
 * timestamps only — a stored value is never served back, it is injected into
 * the sandbox as an environment variable. A `get` here could only ever return
 * a value this process already held, so the port does not offer one.
 */
export interface SecretStore {
    create: (name: string, value: string) => Promise<void>;
    update: (name: string, value: string) => Promise<void>;
    delete: (name: string) => Promise<void>;
}
/** Resolve a SecretStore interface using the provided SandboxRuntimeConfig shell */
export declare function secretStoreFromClient(shell: SandboxRuntimeConfig): SecretStore;
/** Resolve storing a secret by creating it, or replacing it when it exists */
export declare function storeSecret(store: SecretStore, name: string, value: string): Promise<Outcome<void>>;
/** Delete a secret by name from the given secret store and return the operation outcome */
export declare function deleteSecret(store: SecretStore, name: string): Promise<Outcome<void>>;
/** Represent a token with its expiration date and associated scope */
export interface ScopedTokenResult {
    token: string;
    expiresAt: Date;
    scope: ScopedTokenScope;
}
/**
 * Mint a scoped token for an already-provisioned box (e.g. to hand a terminal
 * proxy a narrowed credential). Uses the SDK's native `box.mintScopedToken`,
 * which normalizes `expiresAt` to a Date — no hand-rolled wire call.
 */
export declare function mintSandboxScopedToken(box: SandboxInstance, options: MintScopedTokenOptions): Promise<Outcome<ScopedTokenResult>>;
/** Define options to manage deterministic session resumption and turn idempotency in sandboxed drive turns */
export interface DriveSandboxTurnOptions extends StreamSandboxPromptOptions {
    /** Deterministic resume key — required. Every tick for the same logical turn
     * MUST reuse it so a crash + re-drive finds the in-flight session instead of
     * starting a second agent run. */
    sessionId: string;
    /** Wall-clock cap in ms from the session's start. A still-running session past
     * the cap is cancelled and reported `failed` — bounds an unattended run, such as
     * a turn stalled on an interactive question with no consumer. Omit for no cap. */
    wallCapMs?: number;
}
/** Resolve a sandbox turn by processing a message with given configuration and options */
export declare function driveSandboxTurn(shell: SandboxRuntimeConfig, box: SandboxInstance, message: string | PromptInputPart[], options: DriveSandboxTurnOptions): Promise<Outcome<TurnDriveResult>>;
/** Define transitions marking the start or finish of a sandbox step with associated details */
export type SandboxStepTransition = {
    kind: 'step-start';
} | {
    kind: 'step-finish';
    reason: string;
    severed: boolean;
};
/** Resolve the severed stream event to a corresponding sandbox step transition or null */
export declare function classifySeveredStream(event: unknown): SandboxStepTransition | null;
/** Determine if an event is a terminal prompt event with type 'result' or 'done */
export declare function isTerminalPromptEvent(event: unknown): boolean;
/** Resolve the interactive question text from a structured event or return null if none found */
export declare function detectInteractiveQuestion(event: unknown): string | null;
export * from './workspace-sandbox-manager';
export * from './terminal-connection';
export * from './prewarm';
export * from './prewarm-claim-d1';
export * from './foreground-single-flight';
