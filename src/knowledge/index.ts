/**
 * Declarative knowledge-requirement gate.
 *
 * Every agent product hand-rolls the same pair: a `buildXKnowledgeRequirements`
 * declaring the requirements that gate its control loop, and a
 * `deriveXRuntimeKnowledge` that scores each one from workspace state. Across
 * the fleet those derives are uniformly "is a config field set" / "are there
 * >= N rows in table T (optionally with a status filter)" / "any/all of the
 * above" — data, not logic. This module makes both DATA: a spec list with
 * declarative `satisfiedBy` rules, plus a per-spec `derive` escape hatch for
 * the rare rule a declarative form can't express (e.g. an aggregate over a
 * JSON column).
 *
 * Substrate-free: the only seam is `KnowledgeStateAccessor` (a config lookup +
 * a row count), which the consumer's backend — or `agent-app/preset-cloudflare`
 * — implements. Emits `@tangle-network/agent-eval`'s `KnowledgeRequirement[]`,
 * exactly what the agent-runtime control loop consumes.
 */

import type {
  KnowledgeAcquisitionMode,
  KnowledgeFreshness,
  KnowledgeImportance,
  KnowledgeRequirement,
  KnowledgeRequirementCategory,
  KnowledgeSensitivity,
} from '@tangle-network/agent-eval'

/** A declarative rule for satisfying a requirement from workspace state. */
export type SatisfiedByRule =
  /** A workspace-config field (dot-path) is set. `nonEmpty` requires a
   *  non-empty array/string rather than mere presence. */
  | { config: string; nonEmpty?: boolean }
  /** At least `minRows` (default 1) rows exist in `table` for the workspace,
   *  optionally filtered to `statusIn`. `where` names the workspace fk column
   *  the accessor scopes on (default: the accessor's convention). */
  | { table: string; where?: string; statusIn?: string[]; minRows?: number }
  | { anyOf: SatisfiedByRule[] }
  | { allOf: SatisfiedByRule[] }

/** Define the criteria and conditions required to satisfy a specific knowledge requirement */
export interface KnowledgeRequirementSpec {
  id: string
  description: string
  category: KnowledgeRequirementCategory
  acquisitionMode: KnowledgeAcquisitionMode
  importance?: KnowledgeImportance
  freshness?: KnowledgeFreshness
  sensitivity?: KnowledgeSensitivity
  confidenceNeeded?: number
  requiredFor?: string[]
  /** The data path — evaluated against the `KnowledgeStateAccessor`. */
  satisfiedBy?: SatisfiedByRule
  /** The escape hatch — a code derive for what a rule can't express. Wins
   *  over `satisfiedBy` when both are present. Returns confidence in [0, 1]. */
  derive?: (ctx: KnowledgeStateAccessor) => number | Promise<number>
  /** Evidence id attached when satisfied (default: a description of the rule). */
  evidence?: string
}

/** The single seam a backend implements. `preset-cloudflare` provides a D1
 *  implementation; a custom stack supplies its own. */
export interface KnowledgeStateAccessor {
  /** Resolve a workspace-config field value (dot-path), or undefined. */
  config: (path: string) => unknown
  /** Count rows in `table` for the active workspace, optionally status-filtered. */
  count: (query: { table: string; where?: string; statusIn?: string[] }) => number | Promise<number>
}

/** Define a signal representing knowledge with confidence level and optional supporting evidence */
export interface KnowledgeSignal {
  confidence: number
  evidence?: string
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Map specs -> the runtime's `KnowledgeRequirement[]`, folding in per-spec
 * confidence from `signals` (default 0). Pure + sync: an eval harness can pass
 * hand-authored signals; production passes the output of {@link deriveSignals}.
 */
export function buildKnowledgeRequirements(
  specs: KnowledgeRequirementSpec[],
  signals: Record<string, KnowledgeSignal> = {},
): KnowledgeRequirement[] {
  return specs.map((spec) => {
    const signal = signals[spec.id]
    return {
      id: spec.id,
      description: spec.description,
      requiredFor: spec.requiredFor ?? [],
      category: spec.category,
      acquisitionMode: spec.acquisitionMode,
      importance: spec.importance ?? 'blocking',
      freshness: spec.freshness ?? 'static',
      sensitivity: spec.sensitivity ?? 'private',
      confidenceNeeded: spec.confidenceNeeded ?? 1,
      currentConfidence: clamp(signal?.confidence ?? 0),
      evidenceIds: signal?.evidence ? [signal.evidence] : [],
      fallbackPolicy: spec.acquisitionMode === 'ask_user' ? 'ask' : 'block',
    }
  })
}

/**
 * Score every spec from workspace state. `derive` (code) wins; otherwise the
 * declarative `satisfiedBy` rule is evaluated through the accessor; a spec with
 * neither scores 0 (an acquisition gate, e.g. `search_web`).
 */
export async function deriveSignals(
  specs: KnowledgeRequirementSpec[],
  ctx: KnowledgeStateAccessor,
): Promise<Record<string, KnowledgeSignal>> {
  const out: Record<string, KnowledgeSignal> = {}
  for (const spec of specs) {
    if (spec.derive) {
      out[spec.id] = { confidence: clamp(await spec.derive(ctx)), evidence: spec.evidence }
    } else if (spec.satisfiedBy) {
      const ok = await evalRule(spec.satisfiedBy, ctx)
      out[spec.id] = ok
        ? { confidence: 1, evidence: spec.evidence ?? describeRule(spec.satisfiedBy) }
        : { confidence: 0 }
    } else {
      out[spec.id] = { confidence: 0 }
    }
  }
  return out
}

async function evalRule(rule: SatisfiedByRule, ctx: KnowledgeStateAccessor): Promise<boolean> {
  if ('anyOf' in rule) {
    for (const sub of rule.anyOf) if (await evalRule(sub, ctx)) return true
    return false
  }
  if ('allOf' in rule) {
    for (const sub of rule.allOf) if (!(await evalRule(sub, ctx))) return false
    return true
  }
  if ('config' in rule) {
    const value = ctx.config(rule.config)
    if (rule.nonEmpty) return Array.isArray(value) ? value.length > 0 : value != null && value !== ''
    return value != null && value !== '' && value !== false
  }
  const rows = await ctx.count({ table: rule.table, where: rule.where, statusIn: rule.statusIn })
  return rows >= (rule.minRows ?? 1)
}

function describeRule(rule: SatisfiedByRule): string {
  if ('anyOf' in rule) return `anyOf(${rule.anyOf.map(describeRule).join(',')})`
  if ('allOf' in rule) return `allOf(${rule.allOf.map(describeRule).join(',')})`
  if ('config' in rule) return `config:${rule.config}`
  return `${rule.table}${rule.statusIn ? `[${rule.statusIn.join('|')}]` : ''}>=${rule.minRows ?? 1}`
}
