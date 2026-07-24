/**
 * Execution-mode dispatch — the shell entry that infers *how* to run an agent
 * from its profile's harness, so a product hands over one profile and the
 * framework routes to the router tool loop or a sandbox without separate wiring.
 *
 * The discriminator is the harness: absent / null / 'router' => the router tool
 * agent (`@tangle-network/agent-app/runtime`); any member of `KNOWN_HARNESSES`
 * (opencode, claude-code, …) => a sandbox (`@tangle-network/agent-app/sandbox`).
 * `KNOWN_HARNESSES` is exactly the set of sandbox backends; the *absence* of a
 * harness is the router signal.
 *
 * `runAgent` owns the inference + routing; the two branch runners are injected,
 * because their inputs and event shapes legitimately differ (the router loop
 * yields `LoopEvent`s, the sandbox yields its own events). A product supplies a
 * `router`/`sandbox` thunk and can lazy-import the sandbox driver inside its own
 * thunk, so a router-only app never resolves `@tangle-network/sandbox`.
 */

import { KNOWN_HARNESSES, type Harness } from '../harness/index'

/** Define execution mode as either router or sandbox */
export type ExecutionMode = 'router' | 'sandbox'

/** The router pseudo-harness — the absence of a sandbox backend. Not a member
 *  of `KNOWN_HARNESSES`; callers may pass it explicitly instead of null. */
export const ROUTER_HARNESS = 'router' as const
/** Provide a type alias for the ROUTER_HARNESS constant to enable consistent router harness usage */
export type RouterHarness = typeof ROUTER_HARNESS

/** Resolve a ProfileHarness as a Harness, RouterHarness, null, or undefined value */
export type ProfileHarness = Harness | RouterHarness | null | undefined

/**
 * Infer the execution mode from a profile's harness. Absent / null / 'router'
 * => 'router'; a known sandbox harness => 'sandbox'. An unrecognized non-null
 * string is treated as a sandbox backend (the box installs all harnesses, so an
 * unknown id is a sandbox the runtime resolves, not a router) — callers that
 * want strictness can validate against `KNOWN_HARNESSES` first.
 */
export function resolveExecutionMode(harness: ProfileHarness): ExecutionMode {
  if (harness == null || harness === ROUTER_HARNESS) return 'router'
  return 'sandbox'
}

/** True when `harness` names a sandbox backend the SDK knows about. */
export function isKnownSandboxHarness(harness: ProfileHarness): harness is Harness {
  return harness != null && harness !== ROUTER_HARNESS && (KNOWN_HARNESSES as readonly string[]).includes(harness)
}

/**
 * The superset the dispatch reads: the SDK `AgentProfile` plus the harness
 * discriminator. Intentionally pins only `harness` — the rest of the profile is
 * carried opaquely so this module stays free of the SDK type (router-only apps
 * import it without `@tangle-network/sandbox`).
 */
export interface ShellProfile {
  harness?: ProfileHarness
}

/** Execution mode for a profile — `harness` omitted/null => router. */
export function executionModeForProfile(profile: ShellProfile): ExecutionMode {
  return resolveExecutionMode(profile.harness)
}

/** The two branch runners. Each returns (or resolves to) an async iterable of
 *  the product's own event type — the shapes differ, so the product owns them.
 *  A `sandbox` thunk can `await import('@tangle-network/agent-app/sandbox')`
 *  internally so the SDK is pulled only on the sandbox path. */
export interface RunAgentBranches<T> {
  router: () => AsyncIterable<T> | Promise<AsyncIterable<T>>
  sandbox: () => AsyncIterable<T> | Promise<AsyncIterable<T>>
}

/**
 * Route a turn to the branch the harness selects and stream its events through.
 * The shell does the inference; the product supplies how each branch runs. The
 * unselected branch's thunk is never invoked — so its dependencies (e.g. the
 * sandbox SDK) are never loaded on the other path.
 */
export async function* runAgent<T>(
  harness: ProfileHarness,
  branches: RunAgentBranches<T>,
): AsyncGenerator<T> {
  const mode = resolveExecutionMode(harness)
  const source = mode === 'sandbox' ? branches.sandbox() : branches.router()
  const iterable = await source
  for await (const event of iterable) yield event
}
