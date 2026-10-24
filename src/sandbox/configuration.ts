import type { SandboxInstance, EgressPolicy, StorageConfig, ProvisionEvent } from '@tangle-network/sandbox'
import type { SandboxExistingBoxStage } from './lifecycle-errors'
import type { AgentProfileFileMount, AgentProfileMcpServer, AgentProfile } from '@tangle-network/agent-interface'
import type { Harness } from '../harness/index'
import type { SandboxClientCredentials } from './credentials'
import type { SandboxPermissionLevel } from './access'
import type { ProviderResolutionConfig } from './model'
import type { ReuseStateStore } from './reuse-state'
import type { Outcome } from './outcome'
import type { ComposeProfileBudget } from '../profile/budget'
import type { TurnTrace, TurnSpan } from '../turn-trace/recorder'

/**
 * Configure sandbox resources and lifecycle limits.
 * Set `advisory` for application defaults that the Sandbox API may clamp to account limits.
 * Omit it when the requested allocation must be honored or rejected.
 */
export interface SandboxResourceConfig {
  image: string
  cpuCores: number
  memoryMB: number
  diskGB: number
  /** Let the Sandbox API clamp these resource defaults to the account's limits. */
  advisory?: boolean
  maxLifetimeSeconds: number
  idleTimeoutSeconds: number
}

/** Define the context for building a sandbox including workspace, integrations, and optional user ID */
export interface SandboxBuildContext {
  workspaceId: string
  connectedIntegrationIds: string[]
  userId?: string
}

// Scope handed to per-identity seams. workspaceId is always present; userId is
// present when the lifecycle op carries one. Workspace-keyed products ignore userId.
/** Define a scope containing workspace and optional user identifiers for sandbox environments */
export interface SandboxScope {
  workspaceId: string
  userId?: string
}

// Snapshot RESTORE-on-create. Returned alongside storage; undefined => fresh box.
/** Define the specification for restoring a sandbox from a snapshot or another sandbox ID */
export interface SandboxRestoreSpec {
  fromSnapshot: string
  fromSandboxId: string
}

/** Describe the failure details when resuming a stopped sandbox instance */
export interface StoppedSandboxResumeFailure {
  box: SandboxInstance
  error: Error
  scope: SandboxScope
  boxKey: string
}

/** Describe a sandbox that disappeared after the platform listed it. */
export interface MissingSandboxFailure extends StoppedSandboxResumeFailure {
  stage: SandboxExistingBoxStage
}

/** Define the structure for resuming a stopped sandbox with replacement key and optional restore options */
export interface StoppedSandboxResumeRecovery {
  // Used for both the replacement sandbox name and idempotency key.
  replacementBoxKey: string
  // undefined preserves the configured restore seam; null creates without one.
  restore?: SandboxRestoreSpec | null
}

/** Configure runtime exec verification before reusing a sandbox. */
export interface LivenessProbeConfig {
  /** Process timeout passed to the Sandbox SDK. Defaults to 5 seconds.
   * SDK readiness and transport deadlines also apply. */
  execTimeoutMs?: number
  /**
   * Reuse a successful liveness result for this many milliseconds for the
   * same box id and identity (start time and filesystem incarnation). Defaults to 10 minutes; set to 0 to probe on
   * every reuse.
   *
   * Only the exec probe is cached. Runtime readiness, deferred-file
   * materialization, and bootstrap still run on every reuse, and the egress
   * policy and runtime environment are checked as {@link SandboxRuntimeConfig.egressPolicy}
   * and {@link SandboxRuntimeConfig.runtimeEnv} describe. A box that dies during
   * this window is surfaced by the first call on it: a caller whose first call
   * fails passes the box to {@link dropTrustedBox} and ensures once more, which
   * probes it and restarts it in place. The cache never triggers box deletion.
   */
  cacheTtlMs?: number
}

/** Define options for composing a user profile including prompts, files, servers, and name */
export interface ProfileComposeOptions {
  systemPrompt?: string
  extraFiles?: AgentProfileFileMount[]
  extraMcp?: Record<string, AgentProfileMcpServer>
  name?: string
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
  harness: Harness
}

/** Define runtime configuration methods for sandbox environments including credentials, metadata, and permissions */
export interface SandboxRuntimeConfig {
  // Widened to accept an optional scope and be async so a per-user key can be
  // minted. The sync, no-arg form still satisfies the type (back-compat).
  credentials: (
    scope?: SandboxScope,
  ) => SandboxClientCredentials | null | Promise<SandboxClientCredentials | null>
  name: (workspaceId: string) => string
  metadata: (harness: Harness) => Record<string, unknown>
  connectedIntegrationIds: (workspaceId: string) => Promise<string[]>
  /**
   * Creation-only environment. Use runtimeEnv for expiring app credentials.
   * Values remain private; profiles reference their names through secret-ref.
   * Workspace-wide values cannot carry per-user or per-resource authority.
   */
  env: (ctx: SandboxBuildContext) => Promise<Record<string, string>>
  /**
   * Workspace app credentials resolved on creation and before every reuse,
   * resume, or recovery. Fresh values override env in the creation payload.
   * The SDK updates retained runtimes before bootstrap and refuses runtime-managed keys.
   * A resume receives only the keys the platform names as required to rebuild a runtime.
   * Throw when required credentials cannot be minted; renewal failure preserves
   * the sandbox and prevents dispatch. Requires the matching Sandbox runtime.
   * Values equal to the last ones delivered to the same box identity, within
   * 10 minutes, are resolved again but not sent again.
   */
  runtimeEnv?: (scope: SandboxScope) => Promise<Record<string, string>>
  files: (ctx: SandboxBuildContext) => Promise<AgentProfileFileMount[]>
  secrets: (workspaceId: string) => Promise<string[]>
  profile: (options: ProfileComposeOptions) => AgentProfile
  permissionRole?: (workspaceRole: string) => SandboxPermissionLevel
  resources?: SandboxResourceConfig
  provider?: ProviderResolutionConfig

  /**
   * Portable directory where the sandbox starts its agent processes.
   *
   * The value is relative to the sandbox workspace. The sandbox platform
   * validates it and applies it when the box is created.
   */
  cwd?: string

  /**
   * Product-declared outbound network policy. Applied when a sandbox is
   * created. A reused or resumed sandbox is returned only when its explicit
   * policy already matches; existing mismatches are rejected without updating
   * or deleting the sandbox unless migration is explicitly enabled below.
   * A match read within 10 minutes stands for the same box identity, except
   * that a `strict` or `blocked` policy is read again whenever a reuse would send
   * the box credentials (a changed {@link runtimeEnv}, or a {@link bootstrap}).
   */
  egressPolicy?: EgressPolicy
  /**
   * Update an existing box to {@link egressPolicy} before reuse when its
   * recorded policy is absent or different. This is an explicit fleet
   * migration switch: the updated policy is read back and must match before
   * the box is returned. It never deletes the box.
   */
  migrateEgressPolicy?: boolean

  /**
   * Where Worker isolates share what a reuse last checked on a box (its id, the
   * exec probe, the egress read, the runtime environment delivered). A request is
   * not promised the isolate that served the last one, so without a shared store
   * a reuse often finds nothing to trust. Default: the runtime's Cache API when
   * it has one; `null` keeps the state in the isolate. Holds ids, times and
   * digests only.
   */
  reuseState?: ReuseStateStore | null
  // BYOS3/R2 snapshot storage. Returns undefined => key omitted entirely
  // (fail-closed when creds absent). Product owns bucket/endpoint/credentials/prefix.
  storage?: (ctx: SandboxBuildContext) => StorageConfig | undefined
  // Snapshot RESTORE-on-create. undefined => fresh box. Called only when a box
  // is about to be created, so a product can resolve the restore point lazily
  // (listing snapshots is a Sandbox API round trip a reused box never needs).
  restore?: (ctx: SandboxBuildContext) => SandboxRestoreSpec | undefined | Promise<SandboxRestoreSpec | undefined>
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
  /**
   * How long to wait for a box to reach `running`, in ms. Default 120_000.
   *
   * Raise it when a cold create legitimately takes longer than that — a large
   * vault restore, a heavy image, a loaded fleet. The failure it prevents is
   * ugly: every attempt burns the full wait, times out, and the NEXT attempt
   * starts the same slow create from scratch, so a workspace whose provision
   * takes 130s never succeeds no matter how many times a user retries.
   */
  provisionTimeoutMs?: number
  // Opt in to replacing a box the platform cannot bring up.
  //
  // Default false, and the default is the conservative one on purpose: a
  // replacement is a delete, and delete DEPROVISIONS the persistent workspace
  // (#299). An app whose durable state lives in the box's filesystem must not
  // set this — losing the box loses the user's work.
  //
  // Set it when the box is a CACHE of state held elsewhere (a vault, a DB, an
  // object store) and can be rebuilt. Then a box that cannot be started is
  // abandoned and re-created once, instead of leaving the workspace unable to
  // run for as long as the box stays unbringable — which, without this, is
  // forever: the box key is derived from the workspace, so every later attempt
  // resumes the same dead box and fails identically.
  replaceUnbringableBox?: boolean
  // Product-owned retention/recovery policy after a stopped box fails to resume.
  // Return ok(null) to preserve the original resume error. A replacement key is
  // required before this shell creates a new box, so it cannot resolve the
  // failed stopped box through the original idempotency identity.
  recoverStoppedSandbox?: (
    failure: StoppedSandboxResumeFailure,
  ) => Promise<Outcome<StoppedSandboxResumeRecovery | null>>
  /**
   * Replace a sandbox resource or backing container that disappears after listing.
   *
   * The shell calls this for a sandbox resource 404 or an exact resume 500 that
   * wraps a host-agent container 404. It excludes runtime 404 and unrelated
   * reuse failures. Return a fresh key without deleting the stale sandbox record.
   */
  recoverMissingSandbox?: (
    failure: MissingSandboxFailure,
  ) => Promise<Outcome<StoppedSandboxResumeRecovery | null>>
  // default false: bake resolveModel() into the backend's model fields at create.
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
  // Removed from create and per-turn profiles; the deferred writer owns them.
  deferProfileFiles?: boolean
  // Byte budget on the system prompt of the profile this shell actually SENDS
  // (provision + every turn). Defaults to the same 40 KB cap
  // `composeAgentProfile` applies; set `warnOnly` + `overBudgetReason` to
  // downgrade it. Wired here because the composer is opt-in: a product may
  // hand-build its profile, or carry its real prompt only on the PER-TURN
  // backend, and then the compose-time gate never runs on the bytes the model
  // sees. An over-budget prompt degrades toward empty answers, which is
  // indistinguishable from a broken stream — so it fails loud instead.
  promptBudget?: ComposeProfileBudget
}

/** Define default resource limits and settings for sandbox environments */
export const DEFAULT_SANDBOX_RESOURCES: SandboxResourceConfig = {
  image: 'universal',
  cpuCores: 2,
  memoryMB: 4096,
  diskGB: 10,
  maxLifetimeSeconds: 86400,
  idleTimeoutSeconds: 3600,
}

/** Define options for ensuring a workspace sandbox with provisioning and progress handling */
export interface EnsureWorkspaceSandboxOptions {
  workspaceId: string
  /** This caller's lifetime. A cancellation aborts SDK transport and forbids
   * further lifecycle/recovery steps; it does not prove a remote create absent. */
  signal?: AbortSignal
  userId?: string
  harness: Harness
  // When set, both the running-reuse and stopped-resume short-circuits are
  // skipped and any name-matched box is removed before create. Replacement
  // fails if removal remains pending after the SDK's bounded wait. This is the
  // ONLY way a liveness-failed box is discarded: a failed probe triggers a
  // state-preserving stop→resume recovery (or a SandboxRecoveryFailedError),
  // never a delete — delete deprovisions the persistent workspace (#299).
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
  // Optional consumer-side spend verification. Omitted, nothing here changes:
  // no extra call, no extra await, no behavior difference. Wired, it is the one
  // seam where a product both refuses to provision past a compute cap and
  // records that a box is now billable against it.
  //
  // Structural on purpose. `@tangle-network/agent-app/spend` supplies an
  // implementation (`createSandboxSpendHooks`), but this module takes no
  // dependency on it — /spend composes /sandbox, and importing back the other
  // way would invert the layering.
  spend?: SandboxSpendHooks
  /** Optional stage timing for the steps of an ensure (`sandbox.ensure.*`), so a
   *  product can see which round trip a slow acquisition spent its time in.
   *  Omitted, nothing is measured. */
  measure?: <T>(stage: string, operation: () => Promise<T>) => Promise<T>
  /**
   * The turn's trace. The ensure is recorded as one `sandbox.claim` span whose children are the
   * `sandbox.ensure.*` steps (`credentials`, `get_running` or `list_running`, `finalize` for a reused box,
   * with `egress` and `liveness` unless a recent check stood in for them; `list_stopped`,
   * `resume` for a stopped one; `create`, `wait_running`, `bootstrap` for a new one), so a slow claim names
   * the step it waited on. The spend seam's two calls are recorded beside the claim as
   * `sandbox.spend.before_provision` and `sandbox.spend.observe`. Omitted, nothing is recorded;
   * `measure` is unchanged and still called.
   */
  trace?: TurnTrace
  /** The span the claim hangs from. Default: the trace's root. */
  traceParent?: TurnSpan
}

/** What `/sandbox` reports once a box is provisioned, reused, or resumed. */
export interface SandboxProvisionedObservation {
  readonly workspaceId: string
  readonly userId?: string
  /** The platform's sandbox id — the join key to every settlement row. */
  readonly sandboxId: string
  /** The deterministic box key this workspace resolves to. */
  readonly boxKey?: string | undefined
  /** The idle timeout this box was asked to run with, seconds. */
  readonly idleTimeoutSeconds: number
  /** The max lifetime it was asked to run with, seconds, when one was asked for. */
  readonly maxLifetimeSeconds?: number | undefined
  readonly at: number
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
  /**
   * Runs before any create, resume, restart or deletion of a box, and before a
   * reuse unless this isolate probed that box recently (10 minutes by default,
   * {@link LivenessProbeConfig.cacheTtlMs}): a reuse of a box it has been using
   * is gated when its probe expires, not on every turn. Throw to refuse provisioning.
   */
  beforeProvision?(input: { workspaceId: string; userId?: string }): Promise<void> | void
  /**
   * Runs after a box is available, except for a reuse that trusted a recent
   * probe: the ensure that ran that probe reported the box, and `onActivity`
   * carries its use since. Throwing here cannot fail the provision.
   */
  onProvisioned?(observation: SandboxProvisionedObservation): Promise<void> | void
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
  onActivity?(input: { sandboxId: string; at: number }): void
}
