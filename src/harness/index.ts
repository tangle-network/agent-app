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
 *
 * Harness↔model COMPATIBILITY (which models a harness can run, snapping) is NOT defined here — it
 * comes from `@tangle-network/agent-interface`, the single source of truth shared with the
 * sandbox-ui pickers and the cli-bridge backends. This module owns the harness TAXONOMY + the
 * session lock.
 */

import {
  harnessSupportsModel,
  modelProvider,
  preferredHarnessForModel,
  snapHarnessToModel as aiSnapHarnessToModel,
  snapModelToHarness as aiSnapModelToHarness,
  type HarnessType,
} from '@tangle-network/agent-interface'

/** The known coding-agent backends. Mirrors `@tangle-network/sandbox`'s
 *  `BackendType`; kept structural so this module needs no sandbox dependency. */
export const KNOWN_HARNESSES = [
  'opencode',
  'claude-code',
  'nanoclaw',
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

/** Resolve a valid harness identifier from the predefined KNOWN_HARNESSES array */
export type Harness = (typeof KNOWN_HARNESSES)[number]

/** Define the default harness to use for code execution and testing environments */
export const DEFAULT_HARNESS: Harness = 'opencode'

const HARNESS_SET: ReadonlySet<string> = new Set(KNOWN_HARNESSES)

/** Determine if a value is a recognized harness string identifier */
export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_SET.has(value)
}

/** Coerce an arbitrary value to a known harness, falling back (default `opencode`). */
export function coerceHarness(value: unknown, fallback: Harness = DEFAULT_HARNESS): Harness {
  return isHarness(value) ? value : fallback
}

/** Resolve input options to determine the appropriate session harness to use */
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

/** Represent resolved session state including harness, lock status, and swap attempt flag */
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
 * Harness ↔ model compatibility + snapping — delegated to `@tangle-network/agent-interface`.
 *
 * agent-app's `Harness` taxonomy is a superset of agent-interface's `HarnessType` (it carries
 * `forge`/`cursor`, which agent-interface doesn't list). Those extra runners have no provider lock
 * there, so they resolve as router-backed (any model) — the correct behavior — which makes the
 * `as HarnessType` casts safe. The snap helpers only ever return a vendor-locked harness or
 * `opencode`, all of which are valid `Harness` values.
 */

export { modelProvider }

/** Provider-less ids (sentinels like "default", or a session's own config) are
 *  compatible everywhere — every harness honors its own configuration. */
export function isModelCompatibleWithHarness(harness: Harness, modelId: string): boolean {
  return harnessSupportsModel(harness as HarnessType, modelId)
}

/** Keep `modelId` when the harness can run it; else the harness's best compatible
 *  catalog id (preferred patterns in order, highest version). When nothing in the
 *  catalog fits, return the original so the caller sees the incompatibility. */
export function snapModelToHarness(harness: Harness, modelId: string, canonicalIds: readonly string[]): string {
  return aiSnapModelToHarness(harness as HarnessType, modelId, canonicalIds)
}

/** Keep the harness when it can run `modelId`; else the model's native harness
 *  (anthropic → claude-code, openai → codex, moonshot → kimi-code), falling back to opencode. */
export function snapHarnessToModel(harness: Harness, modelId: string): Harness {
  return aiSnapHarnessToModel(harness as HarnessType, modelId) as Harness
}

/** Fail-loud server guard: throw when a harness is asked to run a model it can't.
 *  Call before dispatching a sandbox turn so a bypassed UI can't reach the sidecar
 *  with an incompatible pair. */
export function assertHarnessModelCompatible(harness: Harness, modelId: string): void {
  if (!isModelCompatibleWithHarness(harness, modelId)) {
    const provider = modelProvider(modelId)
    const native = preferredHarnessForModel(modelId)
    throw new Error(
      `Harness "${harness}" cannot run model "${modelId}" (provider "${provider}"). ` +
        `Use ${native ?? 'a router-backed harness (opencode)'} or an allowed model.`,
    )
  }
}
