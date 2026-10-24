import type { AgentProfile, ReasoningEffort, AgentProfileMcpServer } from '@tangle-network/agent-interface'
import type { Harness } from '../harness/index'
import type { ProfileFingerprint } from '../profile/fingerprint'
import type { SandboxSpendHooks } from './configuration'
import type { TurnTrace, TurnSpan } from '../turn-trace/recorder'

/** Define options for configuring and controlling a streaming sandbox prompt session */
export interface StreamSandboxPromptOptions {
  /** Complete server-owned profile for this turn. Skips the shell's default composer.
   * Credentials, admission, session identity, and interactions remain execution options.
   * Explicit turn selections override this profile; otherwise its model and harness win
   * over shell defaults. Never populate this field from an untrusted request body. */
  profile?: AgentProfile
  sessionId?: string
  executionId?: string
  /** Stable idempotency key for one logical dispatch. Reuse it with the same
   * `sessionId` when a caller may retry the initial request. */
  turnId?: string
  lastEventId?: string
  systemPrompt?: string
  model?: string
  modelApiKey?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  harness?: Harness
  effort?: 'auto' | ReasoningEffort
  /** Provider-enforced visible answer ceiling for this turn. */
  maxOutputTokens?: number
  /** Provider-enforced hidden reasoning ceiling for this turn. */
  maxReasoningTokens?: number
  /** Provider-enforced combined answer and reasoning ceiling for this turn. */
  maxTotalOutputTokens?: number
  appToolMcp?: Record<string, AgentProfileMcpServer>
  baseProfileMcp?: Record<string, AgentProfileMcpServer>
  extraMcp?: Record<string, AgentProfileMcpServer>
  /** Runtime-owned MCP tools for this turn, outside the authored profile. */
  runtimeAttachments?: { mcp: Record<string, AgentProfileMcpServer> }
  /** Per-turn secret values used by runtime attachments; never stored in the profile or sandbox environment. */
  runtimeSecrets?: Record<string, string>
  /** Mark a backend prepared for a secret-isolated native session. The caller creates
   * that session and prepares its exact backend before dispatch. */
  secretProfileIsolation?: true
  /** SDK-issued digest of the prepared public backend request. */
  expectedPublicProfileRequestDigest?: `sha256:${string}`
  /** SDK-issued receipt for the prepared secret native profile revision. */
  expectedSecretProfileReceipt?: `hmac-sha256:${string}`
  /** The send witness: called synchronously just before this execution is handed to the SDK, once per send
   * attempt and never for a `lastEventId` resume. It is the same in a shared and a secret-isolated session, so
   * never pass it only for one mode. A failure before its first call was never sent and holds no run on the box;
   * after it, the run may exist and is reconciled, not retried. */
  onDispatch?: () => void
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Execution time limit for this run, in milliseconds. Unset, the runtime
   * falls back to `timeoutMs`, then to its one-hour default, so a turn that
   * must run longer than an hour names it here. The runtime refuses a value
   * above its deployment maximum before the run starts. `timeoutMs` stays the
   * shorter first-output budget.
   */
  ttlMs?: number
  requireVisibleAssistantOutput?: boolean
  // When true, an interactive question event throws instead of yielding.
  // Use this for detached runs whose caller has no consumer to answer it.
  disallowQuestions?: boolean
  // Per-turn question/permission/plan channel toggles, forwarded VERBATIM into the
  // backend config. agent-app does not validate kinds per harness — the sidecar fails
  // session init loudly for unsupported ones; a local matrix would drift. Honored on
  // both streaming and driveTurn paths.
  interactions?: { question?: boolean; permission?: boolean; plan?: boolean }
  // Streaming helper only: detach the run from THIS stream's lifetime. When true, the helper admits the
  // run through `dispatchPrompt`, then reads its exact execution through the
  // SDK replay stream. A Worker restart or browser refresh therefore cannot
  // cancel the server-side run. Reuse `sessionId` + `executionId` + `turnId` on
  // retries; `lastEventId` resumes the same execution instead of dispatching
  // another one.
  // Omit for a run where closing the tab should stop burning tokens.
  detach?: boolean
  // Observe the EXACT profile handed to the sandbox SDK for this turn — after
  // the system-prompt override, the MCP merge, and reasoning-effort attachment
  // — as a ProfileFingerprint. This is the seam an eval/backtest uses to PROVE
  // it executed the shipped profile instead of re-deriving one and asserting
  // nothing. Invoked once, before the first event is yielded.
  onProfileResolved?: (fingerprint: ProfileFingerprint) => void
  // Optional spend-verification activity tap. Omitted, nothing changes. Takes
  // the SAME object `ensureWorkspaceSandbox` does, so a product builds one and
  // wires it in both places; only `onActivity` is read here.
  spend?: SandboxSpendHooks
  /**
   * The turn's trace (`@tangle-network/agent-app/turn-trace`). Its id is sent as `traceId`, the
   * `x-tangle-trace-id` the Sandbox API, orchestrator, sidecar and the Router's dispatch rows all record, and
   * the stream is recorded as a `sandbox.prompt` span: the sidecar's first-text phases, the generation and
   * each tool the box agent ran. Omitted, the SDK mints a trace id the app does not keep.
   */
  trace?: TurnTrace
  /** The span the prompt hangs from. Default: the trace's root. */
  traceParent?: TurnSpan
}

export interface SandboxPromptExecutionLimits {
  maxOutputTokens?: number
  maxReasoningTokens?: number
}

export function sandboxPromptExecutionOptions(
  limits: SandboxPromptExecutionLimits | undefined,
  effort: StreamSandboxPromptOptions['effort'],
): Pick<StreamSandboxPromptOptions, 'effort' | 'maxOutputTokens' | 'maxReasoningTokens' | 'maxTotalOutputTokens'> {
  return {
    effort: limits?.maxReasoningTokens === 0 ? 'none' : effort,
    ...(limits?.maxOutputTokens !== undefined ? {
      maxOutputTokens: limits.maxOutputTokens,
      maxTotalOutputTokens: limits.maxOutputTokens,
    } : {}),
    ...(limits?.maxReasoningTokens ? { maxReasoningTokens: limits.maxReasoningTokens } : {}),
  }
}
