/**
 * The shared FlowSpan / FlowTrace data shapes — the LEAF both the trace barrel
 * (`./index`, which builds + renders them) and the delegation converters
 * (`./mission-flow`, which emit them) import, so neither has to reach back
 * through the barrel. The barrel re-exports these names unchanged.
 */

export interface FlowSpan {
  kind: 'pipeline' | 'model' | 'tool' | 'waiting' | 'handoff'
  /** Stable identity and parent identity for nested, incrementally updated traces. */
  id?: string
  parentId?: string
  /** Running spans extend from endMs to the viewer's observation time. */
  status?: 'running' | 'done' | 'failed'
  name: string
  startMs: number
  endMs: number
  approx?: boolean
  meta?: Record<string, unknown>
}

/** Describe the structure of a flow trace including spans, timing, tokens, cost, and tool calls */
export interface FlowTrace {
  spans: FlowSpan[]
  totalMs: number
  promptTokens: number
  completionTokens: number
  /** Computed when per-token pricing is supplied. */
  costUsd?: number
  toolCalls: number
  /** Authoritative LLM request count when supplied; absent means unknown. */
  modelCalls?: number
  errors?: number
}
