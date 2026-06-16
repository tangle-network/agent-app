/**
 * Coding-agent harness selection — taxonomy, coercion, and the session-lock invariant.
 *
 * A "harness" is the coding-agent CLI a sandbox drives (opencode / codex /
 * claude-code / …). The shell governs WHICH harness a chat session uses and
 * enforces that a session is LOCKED to the harness it started with — the model
 * may change mid-session, the harness may not (swapping it mid-session would
 * orphan the session's running agent state). Every product otherwise hand-rolls
 * this and hard-codes a single harness; this is the one place the rule lives.
 *
 * Substrate-free: the harness list mirrors the sandbox SDK's `BackendType` as a
 * plain string union (no sandbox dependency). The consumer owns storage — which
 * harness a workspace defaults to, which one a session locked — and maps the
 * resolved value onto the SDK's `backend.type`.
 */

/** The known coding-agent backends. Mirrors `@tangle-network/sandbox`'s
 *  `BackendType`; kept structural so this module needs no sandbox dependency. */
export const KNOWN_HARNESSES = [
  'opencode',
  'claude-code',
  'kimi-code',
  'codex',
  'amp',
  'factory-droids',
  'pi',
  'hermes',
  'forge',
  'openclaw',
  'acp',
  'cursor',
  'cli-base',
] as const

export type Harness = (typeof KNOWN_HARNESSES)[number]

export const DEFAULT_HARNESS: Harness = 'opencode'

const HARNESS_SET: ReadonlySet<string> = new Set(KNOWN_HARNESSES)

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_SET.has(value)
}

/** Coerce an arbitrary value to a known harness, falling back (default `opencode`). */
export function coerceHarness(value: unknown, fallback: Harness = DEFAULT_HARNESS): Harness {
  return isHarness(value) ? value : fallback
}

export interface ResolveSessionHarnessInput {
  /** The harness already locked to this session (recorded at its first turn). */
  sessionHarness?: unknown
  /** The harness requested now — a new session's choice, or a turn's attempt to switch. */
  requested?: unknown
  /** The workspace's default harness, used only when starting a fresh session. */
  workspaceDefault?: unknown
  /** Final fallback when nothing else resolves (default `opencode`). */
  fallback?: Harness
}

export interface ResolvedSessionHarness {
  /** The harness to actually run — the locked one when the session already has it. */
  harness: Harness
  /** True when the session already had a locked harness (this turn did not pick it). */
  locked: boolean
  /** True when `requested` differs from the locked harness — a forbidden mid-session
   *  swap the caller should reject or warn on. The lock always wins regardless. */
  swapAttempted: boolean
}

/**
 * Resolve the harness for a turn, enforcing the session lock.
 *
 * - **Session already started** (`sessionHarness` is a known harness): that harness
 *   wins (`locked: true`); a differing `requested` sets `swapAttempted` so the caller
 *   can reject the swap. The model is a separate per-turn concern and is unaffected.
 * - **Fresh session**: pick `requested → workspaceDefault → fallback`. The caller
 *   persists the result as the session's lock for every subsequent turn.
 */
export function resolveSessionHarness(input: ResolveSessionHarnessInput = {}): ResolvedSessionHarness {
  const fallback = input.fallback ?? DEFAULT_HARNESS
  if (isHarness(input.sessionHarness)) {
    const locked = input.sessionHarness
    const swapAttempted = isHarness(input.requested) && input.requested !== locked
    return { harness: locked, locked: true, swapAttempted }
  }
  const harness = coerceHarness(input.requested, coerceHarness(input.workspaceDefault, fallback))
  return { harness, locked: false, swapAttempted: false }
}

/**
 * Harness ↔ model compatibility policy — the ONE source of truth, server-side.
 *
 * Native CLI harnesses are vendor-locked: claude-code only drives Anthropic
 * models, codex only OpenAI, kimi-code only Moonshot. Router-backed harnesses
 * (opencode, etc.) accept any catalog model (`providers: null`). The pickers in
 * sandbox-ui keep the pair coherent in the UI; this is the same policy the SHELL
 * enforces so a bypassed/forged request can't pair claude-code with a gpt model
 * and fail at the sidecar. Operates on plain canonical ids ("provider/model") so
 * it stays substrate-free — no model-catalog or UI dependency.
 */
export interface HarnessModelPolicy {
  /** Canonical-id provider prefixes the harness can run; null = any. */
  providers: readonly string[] | null
  /** Snap-target patterns, best first; highest version within a pattern wins. */
  preferred: readonly RegExp[]
}

export const HARNESS_MODEL_POLICIES: Partial<Record<Harness, HarnessModelPolicy>> = {
  'claude-code': {
    providers: ['anthropic'],
    preferred: [/^anthropic\/claude-opus-[\d.-]+$/, /^anthropic\/claude-sonnet-[\d.-]+$/, /^anthropic\//],
  },
  codex: {
    providers: ['openai'],
    preferred: [/^openai\/gpt-\d+(\.\d+)?$/, /^openai\/gpt/, /^openai\//],
  },
  'kimi-code': { providers: ['moonshot'], preferred: [/^moonshot\//] },
}

/** Native harness for a model's provider (anthropic → claude-code, …). */
export const PROVIDER_PREFERRED_HARNESS: Record<string, Harness> = {
  anthropic: 'claude-code',
  openai: 'codex',
  moonshot: 'kimi-code',
}

/** Provider prefix of a canonical id ("anthropic/claude-…" → "anthropic"). */
export function modelProvider(modelId: string): string | null {
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : null
}

/** Provider-less ids (sentinels like "default", or a session's own config) are
 *  compatible everywhere — every harness honors its own configuration. */
export function isModelCompatibleWithHarness(harness: Harness, modelId: string): boolean {
  const policy = HARNESS_MODEL_POLICIES[harness]
  if (!policy || policy.providers === null) return true
  const provider = modelProvider(modelId)
  if (!provider) return true
  return policy.providers.includes(provider)
}

const numericDesc = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Keep `modelId` when the harness can run it; else the harness's best compatible
 *  catalog id (preferred patterns in order, highest version). When nothing in the
 *  catalog fits, return the original so the caller sees the incompatibility. */
export function snapModelToHarness(harness: Harness, modelId: string, canonicalIds: readonly string[]): string {
  if (isModelCompatibleWithHarness(harness, modelId)) return modelId
  const policy = HARNESS_MODEL_POLICIES[harness]
  if (!policy) return modelId
  for (const pattern of policy.preferred) {
    const matches = canonicalIds.filter((id) => pattern.test(id)).sort((a, b) => numericDesc.compare(b, a))
    if (matches.length > 0) return matches[0]!
  }
  return canonicalIds.find((id) => isModelCompatibleWithHarness(harness, id)) ?? modelId
}

/** Keep the harness when it can run `modelId`; else the model's native harness
 *  (anthropic → claude-code, openai → codex), falling back to opencode. */
export function snapHarnessToModel(harness: Harness, modelId: string): Harness {
  if (isModelCompatibleWithHarness(harness, modelId)) return harness
  const provider = modelProvider(modelId)
  return (provider && PROVIDER_PREFERRED_HARNESS[provider]) || 'opencode'
}

/** Fail-loud server guard: throw when a harness is asked to run a model it can't.
 *  Call before dispatching a sandbox turn so a bypassed UI can't reach the sidecar
 *  with an incompatible pair. */
export function assertHarnessModelCompatible(harness: Harness, modelId: string): void {
  if (!isModelCompatibleWithHarness(harness, modelId)) {
    const provider = modelProvider(modelId)
    throw new Error(
      `Harness "${harness}" cannot run model "${modelId}" (provider "${provider}"). ` +
        `Use ${PROVIDER_PREFERRED_HARNESS[provider ?? ''] ?? 'a router-backed harness (opencode)'} or an allowed model.`,
    )
  }
}
