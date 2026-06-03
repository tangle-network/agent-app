/**
 * Eval — the app-shell BRIDGE to `@tangle-network/agent-eval`, not a reimpl.
 *
 * The completion/scoring ENGINE lives in agent-eval (a peer dependency):
 * `verifyCompletion`, `extractProducedState`, `weightedComposite`,
 * `createLlmCorrectnessChecker`, and the `CompletionRequirement` / `TaskGold` /
 * `ProducedState` types — all re-exported here so a consumer has one import
 * root. This module adds only what agent-eval doesn't have and what is
 * app-shell-specific:
 *
 *   1. {@link producedFromToolEvents} — the bridge: turn the structured app-tool
 *      side channel's `AppToolProducedEvent`s (from a tool runtime executor's
 *      `onProduced`) into the `RuntimeEventLike`s agent-eval's
 *      `extractProducedState` consumes. This is the one piece that knows about
 *      the app-tool channel, so it belongs here, not in the engine.
 *   2. {@link createTokenRecallChecker} — a deterministic, no-LLM
 *      `CorrectnessChecker` (agent-eval ships only the LLM one). For apps/tests
 *      that gate completion without a judge call.
 *
 * Full campaigns (persona simulation, traces, scorecards, held-out gates) are
 * agent-eval's `runEvalCampaign` / `AgentDriver` / `BenchmarkRunner` — use them
 * directly; this module composes with them.
 */
import type { RuntimeEventLike, CompletionRequirement } from '@tangle-network/agent-eval'
import type { AppToolProducedEvent } from '../tools/types'

// Re-export the engine so consumers import completion + scoring from one place.
export { verifyCompletion, extractProducedState, weightedComposite, createLlmCorrectnessChecker } from '@tangle-network/agent-eval'
export type {
  CompletionRequirement,
  TaskGold,
  ProducedState,
  SatisfiedBy,
  CompletionVerdict,
  CorrectnessChecker,
  RuntimeEventLike,
} from '@tangle-network/agent-eval'

/**
 * Bridge the app-tool side channel's produced events into the runtime-event
 * shape agent-eval's `extractProducedState` reads. Pipe it:
 *   `verifyCompletion(taskGold, extractProducedState(producedFromToolEvents(events)), checker)`
 */
export function producedFromToolEvents(events: readonly AppToolProducedEvent[]): RuntimeEventLike[] {
  return events.map((e) =>
    e.type === 'proposal_created'
      ? { type: 'proposal_created', proposalId: e.proposalId, title: e.title, status: e.status }
      : { type: 'artifact', artifactId: `vault:${e.path}`, name: e.path, uri: `vault://${e.path}`, mimeType: 'text/markdown', content: e.content },
  )
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'review', 'update', 'new', 'proposed'])

/**
 * A deterministic `CorrectnessChecker` (agent-eval exports only
 * `createLlmCorrectnessChecker`). A produced item fulfils a requirement when
 * its content is substantive and recalls ≥ `minRecall` of the requirement
 * title's significant tokens. No network — the default gate for apps/tests
 * without an LLM judge. Pass to `verifyCompletion` as the checker.
 */
export function createTokenRecallChecker(opts: { minRecall?: number; minContentLength?: number } = {}): (
  requirement: CompletionRequirement,
  content: string,
) => Promise<{ correct: boolean; reason: string }> {
  const minRecall = opts.minRecall ?? 0.5
  const minLen = opts.minContentLength ?? 120
  return async (requirement, content) => {
    const body = content.trim()
    if (body.length < minLen) return { correct: false, reason: `content too thin (${body.length} chars) to be the deliverable` }
    const tokens = requirement.title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
    if (tokens.length === 0) return { correct: true, reason: 'requirement title has no significant tokens — structural match accepted' }
    const lower = body.toLowerCase()
    const hits = tokens.filter((t) => lower.includes(t)).length
    const recall = hits / tokens.length
    return recall >= minRecall
      ? { correct: true, reason: `content recalls ${hits}/${tokens.length} requirement tokens` }
      : { correct: false, reason: `content recalls only ${hits}/${tokens.length} requirement tokens` }
  }
}
