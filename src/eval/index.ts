/**
 * Completion-gate primitives for evaluating an app-agent turn.
 *
 * The reusable, domain-agnostic core every product's eval hand-rolls: turn the
 * `AppToolProducedEvent`s a turn emitted (from `../tools`) into produced items,
 * then verify each expected deliverable was actually produced — a regulated
 * deliverable needs a real `proposal`, a view/note needs an `artifact`; fluent
 * prose satisfies neither. This is the per-turn GATE used inline.
 *
 * Scope: this is intentionally lightweight and substrate-free. For full eval
 * campaigns — adversarial persona simulation, trace capture, LLM-judge rubrics,
 * held-out promotion — use `@tangle-network/agent-eval`; this gate composes with
 * it (feed the same produced items), it does not replace it.
 */
import type { AppToolProducedEvent } from '../tools/types'

export type ProducedKind = 'proposal' | 'artifact'

export interface ProducedItem {
  kind: ProducedKind
  /** Proposal title or artifact path — what a requirement matches against. */
  title: string
  /** The deliverable body a content check inspects (artifact content; a
   *  proposal carries only its title, so `content` is the title). */
  content: string
}

/** Normalize the produced events a turn emitted (via the `/tools` executor's
 *  `onProduced`) into checkable items. */
export function producedFromToolEvents(events: readonly AppToolProducedEvent[]): ProducedItem[] {
  return events.map((e) =>
    e.type === 'proposal_created'
      ? { kind: 'proposal' as const, title: e.title, content: e.title }
      : { kind: 'artifact' as const, title: e.path, content: e.content },
  )
}

/** Which produced kind satisfies a requirement. `any` = a proposal OR artifact. */
export type SatisfiedBy = ProducedKind | 'any'

export interface CompletionRequirement {
  reqId: string
  title: string
  satisfiedBy?: SatisfiedBy
}

/** Decides whether a produced item's content actually fulfils a requirement
 *  (not just that something of the right kind exists). */
export type ContentChecker = (requirement: CompletionRequirement, item: ProducedItem) => boolean

export interface CompletionVerdict {
  complete: boolean
  satisfied: Array<{ reqId: string; by: ProducedItem }>
  missing: Array<{ reqId: string; title: string; reason: 'no_matching_kind' | 'no_content_match' }>
}

/**
 * Gate a turn: every requirement must be satisfied by a produced item of the
 * allowed kind whose content the checker accepts. An empty requirement set is a
 * misconfiguration (nothing to gate on) — throws, so a hallucinated turn that
 * produced nothing can't pass vacuously.
 */
export function verifyCompletion(
  requirements: readonly CompletionRequirement[],
  produced: readonly ProducedItem[],
  checkContent: ContentChecker = tokenRecallChecker(),
): CompletionVerdict {
  if (requirements.length === 0) {
    throw new Error('verifyCompletion: empty requirement set — declare expected deliverables to gate on.')
  }
  const satisfied: CompletionVerdict['satisfied'] = []
  const missing: CompletionVerdict['missing'] = []

  for (const req of requirements) {
    const want = req.satisfiedBy ?? 'any'
    const candidates = produced.filter((p) => want === 'any' || p.kind === want)
    if (candidates.length === 0) {
      missing.push({ reqId: req.reqId, title: req.title, reason: 'no_matching_kind' })
      continue
    }
    const match = candidates.find((p) => checkContent(req, p))
    if (match) satisfied.push({ reqId: req.reqId, by: match })
    else missing.push({ reqId: req.reqId, title: req.title, reason: 'no_content_match' })
  }

  return { complete: missing.length === 0, satisfied, missing }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'review', 'update', 'new', 'proposed',
])

/**
 * Deterministic content checker: the produced item recalls at least `minRecall`
 * of the requirement title's significant tokens, and is substantive. No LLM —
 * the same heuristic products use as a network-free default. For semantic
 * judging, pass an LLM-backed `ContentChecker` instead.
 */
export function tokenRecallChecker(minRecall = 0.5, minContentLength = 8): ContentChecker {
  return (req, item) => {
    if (item.content.trim().length < minContentLength) return false
    const tokens = req.title.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
    if (tokens.length === 0) return true
    const lower = item.content.toLowerCase()
    const hits = tokens.filter((t) => lower.includes(t)).length
    return hits / tokens.length >= minRecall
  }
}

/**
 * Clamped weighted composite of named dimension scores (each 0..1). Weights need
 * not sum to 1 — the result is normalized by the total weight of the scored
 * dimensions, so a missing dimension doesn't silently drag the score to 0.
 */
export function weightedScore(scores: Record<string, number>, weights: Record<string, number>): number {
  let weighted = 0
  let totalWeight = 0
  for (const [dim, w] of Object.entries(weights)) {
    if (!(dim in scores)) continue
    const s = Math.max(0, Math.min(1, scores[dim] ?? 0))
    weighted += s * w
    totalWeight += w
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight
}
