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
 * Substrate-free: the harness list is derived from `@tangle-network/agent-interface`'s canonical
 * harness enum and mirrors the sandbox SDK's `BackendType` (no sandbox dependency). The consumer
 * owns storage — which harness a workspace defaults to, which one a session locked — and maps the
 * resolved value onto the SDK's `backend.type`.
 *
 * Harness↔model COMPATIBILITY (which models a harness can run, snapping) is NOT defined here — it
 * comes from `@tangle-network/agent-interface`, the single source of truth shared with the
 * sandbox-ui pickers and the cli-bridge backends. This module owns the harness TAXONOMY + the
 * session lock.
 */

import {
  harnessSupportsModel,
  harnessTypeSchema,
  modelProvider,
  preferredHarnessForModel,
  snapHarnessToModel as aiSnapHarnessToModel,
  snapModelToHarness as aiSnapModelToHarness,
  type HarnessType,
} from '@tangle-network/agent-interface'

/**
 * Canonical harnesses that are NOT sandbox backends. `KNOWN_HARNESSES` is dispatched as
 * `backend.type`, so a harness the platform ships no provider adapter for must stay out —
 * offering it would resolve a session onto a runner that cannot start.
 */
const NON_BACKEND_HARNESSES = ['gemini'] as const satisfies readonly HarnessType[]

/**
 * Backends the platform runs that the canonical enum does not carry yet. The guard below turns
 * their adoption upstream into a compile error, so this list is emptied rather than duplicating a
 * canonical id.
 */
const EXTRA_HARNESSES = ['forge', 'cursor'] as const

type ExtrasAlreadyCanonical = Extract<HarnessType, (typeof EXTRA_HARNESSES)[number]>
const _extrasAreNotYetCanonical: ExtrasAlreadyCanonical extends never ? true : never = true
void _extrasAreNotYetCanonical

const nonBackendHarnesses = new Set<string>(NON_BACKEND_HARNESSES)

/** A coding-agent backend this shell can dispatch a session onto. */
export type Harness =
  | Exclude<HarnessType, (typeof NON_BACKEND_HARNESSES)[number]>
  | (typeof EXTRA_HARNESSES)[number]

/**
 * The known coding-agent backends: the canonical harness set minus what has no provider adapter,
 * plus adapters the canonical set has yet to adopt. Derived from `harnessTypeSchema.options` so a
 * harness added upstream reaches this shell without an edit here, and kept structural so this
 * module still needs no sandbox dependency.
 */
export const KNOWN_HARNESSES: readonly Harness[] = [
  ...harnessTypeSchema.options.filter(
    (harness): harness is Exclude<HarnessType, (typeof NON_BACKEND_HARNESSES)[number]> =>
      !nonBackendHarnesses.has(harness),
  ),
  ...EXTRA_HARNESSES,
]

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
 * `Harness` and `HarnessType` OVERLAP rather than nest: this shell drops canonical harnesses the
 * platform has no backend for, and carries backends the canonical enum has yet to adopt. So a
 * harness is narrowed to a canonical id before any capability lookup, and the non-canonical
 * remainder is answered here — those runners are multi-provider CLIs with no vendor lock, so they
 * run any model and never snap. As the canonical enum adopts them, `canonicalHarness` starts
 * returning them and the lookup below takes over with no change at these call sites.
 */

const canonicalHarnesses: ReadonlySet<string> = new Set(harnessTypeSchema.options)

/** The canonical id for a harness, or `null` for a backend the canonical enum does not list. */
function canonicalHarness(harness: Harness): HarnessType | null {
  return canonicalHarnesses.has(harness) ? (harness as HarnessType) : null
}

export { modelProvider }

/** Provider-less ids (sentinels like "default", or a session's own config) are
 *  compatible everywhere — every harness honors its own configuration. */
export function isModelCompatibleWithHarness(harness: Harness, modelId: string): boolean {
  const canonical = canonicalHarness(harness)
  if (!canonical) return true
  return harnessSupportsModel(canonical, modelId)
}

/** Keep `modelId` when the harness can run it; else the harness's best compatible
 *  catalog id (preferred patterns in order, highest version). When nothing in the
 *  catalog fits, return the original so the caller sees the incompatibility. */
export function snapModelToHarness(harness: Harness, modelId: string, canonicalIds: readonly string[]): string {
  const canonical = canonicalHarness(harness)
  if (!canonical) return modelId
  return aiSnapModelToHarness(canonical, modelId, canonicalIds)
}

/** Keep the harness when it can run `modelId`; else the model's native harness
 *  (anthropic → claude-code, openai → codex, moonshot → kimi-code), falling back to opencode. */
export function snapHarnessToModel(harness: Harness, modelId: string): Harness {
  const canonical = canonicalHarness(harness)
  if (!canonical) return harness
  const snapped = aiSnapHarnessToModel(canonical, modelId)
  if (!isHarness(snapped)) {
    throw new Error(
      `Harness "${harness}" snapped to "${snapped}" for model "${modelId}", which this platform has no backend for.`,
    )
  }
  return snapped
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
