/**
 * Scorecard wiring: fold a benchmark's `RunRecord[]` into agent-eval's
 * `(scenarioId x profileHash)` scorecard timeline.
 *
 * The scorecard is an append-only JSONL log, one line per (cell, commit).
 * {@link recordScorecardAndDiff} appends a run and diffs the latest entries
 * against their predecessors, answering "did this commit regress any persona on
 * the same profile?", which a single run's pass/fail gate cannot. The app owns
 * the behaviour-only `AgentProfile` it keys the scorecard on.
 */

import {
  agentProfileHash,
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRunsToScorecard,
  type AgentProfile,
  type RunRecord,
  type ScorecardDiff,
} from '@tangle-network/agent-eval'

export interface ScorecardWiringInput {
  scorecardPath: string
  runs: RunRecord[]
  profile: AgentProfile
  commitSha: string
  /** Defaults to `new Date().toISOString()`. */
  timestamp?: string
}

export interface ScorecardWiringResult {
  /** Number of cell entries appended to the log this run (one per scenario). */
  appendedCells: number
  /** Profile hash this run keyed into. */
  profileHash: string
  /** Diff of the latest entries against their predecessors. */
  diff: ScorecardDiff
  /** Human-readable diff block, what a PR or CI run prints. */
  formatted: string
  /** True when any cell's verdict is `regressed`. */
  regressed: boolean
}

/**
 * Append the run to the scorecard, fold the log, diff, and surface a
 * regression flag. Pure I/O over the JSONL log, no LLM calls. Concurrent eval
 * campaigns are safe: appends are line-atomic and `loadScorecard` skips
 * malformed lines rather than failing closed.
 */
export function recordScorecardAndDiff(input: ScorecardWiringInput): ScorecardWiringResult {
  const lines = recordRunsToScorecard(input.scorecardPath, input.runs, {
    profile: input.profile,
    commitSha: input.commitSha,
    timestamp: input.timestamp,
  })
  const diff = diffScorecard(loadScorecard(input.scorecardPath))
  return {
    appendedCells: lines.length,
    profileHash: agentProfileHash(input.profile),
    diff,
    formatted: formatScorecardDiff(diff),
    regressed: diff.cells.some((c) => c.verdict === 'regressed'),
  }
}
