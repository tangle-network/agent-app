/**
 * Turn-level plan-mode resolution for the durable-plan shell. Client-safe.
 *
 * Enabling `backend.interactions: { plan: true }` makes the planning turn run
 * read-only and finish after committing a plan for a later control-plane
 * decision.
 */

const PLAN_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex', 'opencode'])

export type PlanModeFormValue =
  | { succeeded: true; value: boolean | undefined }
  | { succeeded: false; error: string }

/** Parse the new-thread form field without treating malformed input as false. */
export function parsePlanModeFormValue(value: FormDataEntryValue | null): PlanModeFormValue {
  if (value === null) return { succeeded: true, value: undefined }
  if (value === 'true') return { succeeded: true, value: true }
  if (value === 'false') return { succeeded: true, value: false }
  return { succeeded: false, error: 'planMode must be "true" or "false"' }
}

/**
 * Whether a harness can submit durable plans. When the caller has the live
 * capability list from the sandbox registry (GET /v1/backends, each backend
 * advertises `capabilities.interactions`), that list is authoritative; the
 * hardcoded set above is only the fallback for deployments where the registry
 * is unreachable (e.g. the local SDK sandbox stack, which does not serve the
 * route). Keep it conservative: a harness listed here but absent from a
 * reachable registry is treated as NOT capable.
 */
export function harnessSupportsPlanMode(
  harness: string | null | undefined,
  planCapableHarnesses?: readonly string[],
): boolean {
  if (typeof harness !== 'string' || !harness) return false
  if (planCapableHarnesses) return planCapableHarnesses.includes(harness)
  return PLAN_CAPABLE_HARNESSES.has(harness)
}

/**
 * Effective plan mode for one chat turn. Precedence: the send body's explicit
 * value (what the composer showed the user when they hit send) wins over the
 * thread's persisted toggle, which wins over the workspace default — and the
 * result only holds on a plan-capable harness. `threadPlanMode` null/undefined
 * means the thread never set its own toggle (legacy threads, viewer-only
 * threads) and keeps following the workspace default.
 */
export function resolveTurnPlanMode(input: {
  requested: boolean | undefined
  threadPlanMode: boolean | null | undefined
  workspaceDefault: boolean
  harness: string | null | undefined
  /** Live registry capability list; omitted = hardcoded fallback. */
  planCapableHarnesses?: readonly string[]
}): boolean {
  const effective = input.requested ?? input.threadPlanMode ?? input.workspaceDefault
  return effective === true && harnessSupportsPlanMode(input.harness, input.planCapableHarnesses)
}
