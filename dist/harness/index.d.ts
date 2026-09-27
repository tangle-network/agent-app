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
 * session lock, and its server assertion also checks resolved transport-provider evidence.
 */
import { modelProvider, type HarnessType } from '@tangle-network/agent-interface';
/**
 * Canonical harnesses that are NOT sandbox backends. Each value in `KNOWN_HARNESSES` is dispatched
 * as `backend.type`, so a harness the platform ships no provider adapter for must stay out —
 * offering it would resolve a session onto a runner that cannot start.
 */
declare const NON_BACKEND_HARNESSES: readonly ["gemini"];
/** A coding-agent backend this shell can dispatch a session onto. */
export type Harness = Exclude<HarnessType, (typeof NON_BACKEND_HARNESSES)[number]>;
/**
 * The known coding-agent backends: the canonical harness set minus what has no provider adapter,
 * Derived from `harnessTypeSchema.options` so a harness added upstream reaches this shell without
 * an edit here, and kept structural so this module still needs no sandbox dependency.
 */
export declare const KNOWN_HARNESSES: readonly Harness[];
/** Define the default harness to use for code execution and testing environments */
export declare const DEFAULT_HARNESS: Harness;
/** Determine if a value is a recognized harness string identifier */
export declare function isHarness(value: unknown): value is Harness;
/** Coerce an arbitrary value to a known harness, falling back (default `opencode`). */
export declare function coerceHarness(value: unknown, fallback?: Harness): Harness;
/** Resolve input options to determine the appropriate session harness to use */
export interface ResolveSessionHarnessInput {
    /** The harness already locked to this session (recorded at its first turn). */
    sessionHarness?: unknown;
    /** The harness requested now — a new session's choice, or a turn's attempt to switch. */
    requested?: unknown;
    /** The workspace's default harness, used only when starting a fresh session. */
    workspaceDefault?: unknown;
    /** Final fallback when nothing else resolves (default `opencode`). */
    fallback?: Harness;
}
/** Represent resolved session state including harness, lock status, and swap attempt flag */
export interface ResolvedSessionHarness {
    /** The harness to actually run — the locked one when the session already has it. */
    harness: Harness;
    /** True when the session already had a locked harness (this turn did not pick it). */
    locked: boolean;
    /** True when `requested` differs from the locked harness — a forbidden mid-session
     *  swap the caller should reject or warn on. The lock always wins regardless. */
    swapAttempted: boolean;
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
export declare function resolveSessionHarness(input?: ResolveSessionHarnessInput): ResolvedSessionHarness;
/**
 * Harness ↔ model compatibility + snapping — delegated to `@tangle-network/agent-interface`.
 *
 * `Harness` is the dispatchable subset of `HarnessType`: this shell drops only canonical harnesses
 * for which the platform has no backend. Compatibility therefore comes entirely from Interface;
 * this package keeps no second harness taxonomy.
 */
export { modelProvider };
/** A resolved model and the transport provider that will execute it. */
export interface HarnessModelSelection {
    model: string;
    provider?: string;
}
/** Provider-less ids (sentinels like "default", or a session's own config) are
 *  compatible everywhere — every harness honors its own configuration. */
export declare function isModelCompatibleWithHarness(harness: Harness, modelId: string): boolean;
/** Keep `modelId` when the harness can run it; else the harness's best compatible
 *  catalog id (preferred patterns in order, highest version). When nothing in the
 *  catalog fits, return the original so the caller sees the incompatibility. */
export declare function snapModelToHarness(harness: Harness, modelId: string, canonicalIds: readonly string[]): string;
/** Keep the harness when it can run `modelId`; else the model's native harness
 *  (anthropic → claude-code, openai → codex, moonshot → kimi-code), falling back to opencode. */
export declare function snapHarnessToModel(harness: Harness, modelId: string): Harness;
/** Fail-loud server guard: throw when a harness is asked to run a model it can't.
 *  A resolved model tuple supplies provider evidence when its id is unqualified.
 *  Call before dispatching a sandbox turn so a bypassed UI cannot reach the
 *  sidecar with an incompatible or unproven pair. */
export declare function assertHarnessModelCompatible(harness: Harness, selection: string | HarnessModelSelection): void;
