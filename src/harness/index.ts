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
