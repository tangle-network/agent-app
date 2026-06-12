/**
 * Canonical shape for the per-step agent-activity lane — the delegated runs
 * (delegation MCP registry entries) a mission step spawned, journaled onto the
 * step so a live UI can render "what the agent is actually doing" under the
 * step row.
 *
 * CLIENT-SAFE, like everything in `./events`: pure data + a validator. The
 * server attaches `StepAgentActivity[]` when a step settles (and live via
 * `step.updated`); the client re-validates with {@link stepAgentActivity}
 * because the value rides loader/JSON boundaries as untyped metadata.
 */

export interface StepAgentActivity {
  taskId: string
  /** Delegation profile: coder | researcher | ui-auditor | product-defined. */
  tool: string
  status: string
  /** Title-ish excerpt of the delegation's args (goal / question / audit root). */
  detail: string
  costUsd?: number
  durationMs?: number
  /** ISO timestamp the delegation started. */
  startedAt: string
  /** Live loop progress (DelegationProgress.iteration) while the run is in flight. */
  iteration?: number
  /** Live loop progress (DelegationProgress.phase) while the run is in flight. */
  phase?: string
  /** 32-hex trace id when the delegation joined a mission trace (see `/trace`). */
  traceId?: string
  /** 16-hex span id of the delegation's span inside that trace. */
  spanId?: string
}

/** Step state extended with the activity lane a loader/seed route attaches. */
export type WithAgentActivity<Step> = Step & { agentActivity?: StepAgentActivity[] }

/**
 * Re-validate an `agentActivity` lane that crossed a JSON boundary. Entries
 * missing any required field are dropped (a torn row must not crash the lane);
 * optional fields are kept only when well-typed.
 */
export function stepAgentActivity(step: object): StepAgentActivity[] {
  const value = (step as { agentActivity?: unknown }).agentActivity
  if (!Array.isArray(value)) return []
  const items: StepAgentActivity[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.taskId !== 'string' ||
      typeof record.tool !== 'string' ||
      typeof record.status !== 'string' ||
      typeof record.detail !== 'string' ||
      typeof record.startedAt !== 'string'
    ) {
      continue
    }
    items.push({
      taskId: record.taskId,
      tool: record.tool,
      status: record.status,
      detail: record.detail,
      startedAt: record.startedAt,
      ...(typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) ? { costUsd: record.costUsd } : {}),
      ...(typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
      ...(typeof record.iteration === 'number' && Number.isFinite(record.iteration) ? { iteration: record.iteration } : {}),
      ...(typeof record.phase === 'string' ? { phase: record.phase } : {}),
      ...(typeof record.traceId === 'string' ? { traceId: record.traceId } : {}),
      ...(typeof record.spanId === 'string' ? { spanId: record.spanId } : {}),
    })
  }
  return items
}
