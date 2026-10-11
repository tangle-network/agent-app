/**
 * Honest turn settlement, checked over a product's turn records.
 *
 * A turn ends in exactly one terminal state: an answer, a typed failure the
 * person can Retry, or a Stop the person chose, counted on its own. It gets
 * there within 15 minutes of its owner stopping. A failure belongs to the time
 * the turn was requested, not the time it was noticed, and how late it was
 * noticed is measured. A run that completed with a tool call the Sandbox
 * aborted stopped mid-work, so it is a failure.
 *
 * On 2026-10-10 GTM held turns in five places (turn status, admissions,
 * Workflows, Sandbox sessions and the sidecar tracker) and they disagreed:
 * 51 stream rows stayed `running` after their producers died, failure notices
 * arrived 8–11 hours late, and completions with aborted tools counted as
 * answers. {@link checkTurnSettlement} reads one normalized record per turn,
 * however the product derives it, and names every turn that breaks the rule.
 */
import { LAUNCH_BUDGETS, type InvariantVerdict } from './catalog.js'

export type TurnTerminalState = 'answered' | 'failed' | 'stopped'

/** One turn as its product records it, normalized. Times are Unix ms. */
export interface SettledTurnRecord {
  turnId: string
  /** When the request was accepted (the user message was saved). */
  requestedAt: number
  /** Every terminal state recorded for the turn, in order; exactly one is honest. */
  terminals: ReadonlyArray<{
    state: TurnTerminalState
    /** When the terminal state was recorded. */
    at: number
    /** A typed failure code, for `failed`. */
    code?: string
    /** Whether the person is offered Retry, for `failed`. */
    retryable?: boolean
    /** The time the failure is reported under; it must be the request time. */
    attributedTo?: number
  }>
  /** When the turn's owner stopped: for a leased stream, when its lease expired. Null while an owner holds it. */
  ownerEndedAt: number | null
  /** A completed run in which the Sandbox aborted a tool call. */
  abortedToolCall?: boolean
}

export interface TurnSettlementCounts {
  turns: number
  answered: number
  failed: number
  stopped: number
  open: number
  /** Most minutes between an owner stopping and its turn's terminal state. */
  maxDetectionLagMinutes: number
}

/**
 * Check turn records against honest settlement at `now`.
 * A turn still open whose owner has not stopped is fine; one whose owner stopped
 * more than {@link LAUNCH_BUDGETS.settleWithinMs} ago is not.
 */
export function checkTurnSettlement(
  turns: readonly SettledTurnRecord[],
  options: { now: number; settleWithinMs?: number; subject?: string },
): InvariantVerdict {
  const within = options.settleWithinMs ?? LAUNCH_BUDGETS.settleWithinMs
  const findings: string[] = []
  const counts: TurnSettlementCounts = { turns: turns.length, answered: 0, failed: 0, stopped: 0, open: 0, maxDetectionLagMinutes: 0 }
  for (const turn of turns) {
    const label = `turn ${turn.turnId}`
    if (turn.terminals.length > 1) {
      findings.push(`${label} has ${turn.terminals.length} terminal states (${turn.terminals.map((terminal) => terminal.state).join(' then ')}); a turn ends once`)
    }
    const terminal = turn.terminals[0]
    if (!terminal) {
      counts.open += 1
      if (turn.ownerEndedAt !== null && options.now - turn.ownerEndedAt > within) {
        findings.push(`${label} is still open ${minutes(options.now - turn.ownerEndedAt)} min after its owner stopped; the most is ${minutes(within)}`)
      }
      continue
    }
    counts[terminal.state] += 1
    if (turn.ownerEndedAt !== null) {
      const lag = terminal.at - turn.ownerEndedAt
      counts.maxDetectionLagMinutes = Math.max(counts.maxDetectionLagMinutes, minutes(lag))
      if (lag > within) findings.push(`${label} was settled ${minutes(lag)} min after its owner stopped; the most is ${minutes(within)}`)
    }
    if (terminal.state === 'answered' && turn.abortedToolCall) {
      findings.push(`${label} is counted as an answer, but the Sandbox aborted a tool call in it; it stopped mid-work and is a failure`)
    }
    if (terminal.state === 'failed') {
      if (!terminal.code) findings.push(`${label} failed without a typed failure code`)
      if (terminal.retryable !== true) findings.push(`${label} failed without offering Retry`)
      if (terminal.attributedTo !== undefined && terminal.attributedTo !== turn.requestedAt) {
        findings.push(`${label}'s failure is reported at ${new Date(terminal.attributedTo).toISOString()}, not its request time ${new Date(turn.requestedAt).toISOString()}`)
      }
    }
    if (terminal.state === 'stopped' && terminal.code && /fail|error/i.test(terminal.code)) {
      findings.push(`${label} was stopped by the person but carries failure code ${terminal.code}; a Stop is counted on its own`)
    }
  }
  return {
    invariant: 'honest-settlement',
    subject: options.subject ?? 'turns',
    pass: findings.length === 0,
    details: findings.length ? findings : [
      `${counts.turns} turns: ${counts.answered} answered, ${counts.failed} failed with Retry, ${counts.stopped} stopped, ${counts.open} held by a live owner`,
      `longest detection lag ${counts.maxDetectionLagMinutes} min`,
    ],
    data: { ...counts },
  }
}

function minutes(ms: number): number {
  return Math.round((ms / 60_000) * 10) / 10
}

/**
 * The failure shapes GTM shipped on 2026-10-10, as scenarios a product seeds
 * into its own storage, settles with its own scheduled jobs, and reads back as
 * {@link SettledTurnRecord}s. `expect` is the one honest terminal state.
 */
export interface SettlementScenario {
  id: string
  /** What happened to the turn, for the product's seed step. */
  story: string
  /** Minutes before the check's `now` that the request was accepted. */
  requestedMinutesAgo: number
  /**
   * Minutes before `now` that the owner stopped (for a stream, its lease
   * expired), or null for a live owner. Every scenario that stopped did so 12
   * minutes ago, so an app that settles within 15 minutes has settled it by `now`.
   */
  ownerEndedMinutesAgo: number | null
  expect: TurnTerminalState | 'open'
}

export const SETTLEMENT_SCENARIOS: readonly SettlementScenario[] = [
  {
    id: 'orphaned-stream',
    story: 'The Worker streaming the turn died; its stream row is still running, no admission or Workflow holds it, and its 5-minute lease expired 12 minutes ago.',
    requestedMinutesAgo: 30,
    ownerEndedMinutesAgo: 12,
    expect: 'failed',
  },
  {
    id: 'abandoned-before-admission',
    story: 'The user message was saved 12 minutes ago, then the request died before any completion owner admitted the turn: no reply, no stream, no admission.',
    requestedMinutesAgo: 12,
    ownerEndedMinutesAgo: 12,
    expect: 'failed',
  },
  {
    id: 'runtime-restarted',
    story: 'The admitted run\'s runtime restarted mid-turn 12 minutes ago: the session still reports running while its execution ledger failed the run (terminal event interrupted-done).',
    requestedMinutesAgo: 40,
    ownerEndedMinutesAgo: 12,
    expect: 'failed',
  },
  {
    id: 'completed-with-aborted-tool',
    story: 'The run reported completed 12 minutes ago, but a tool part ended with "Tool execution aborted".',
    requestedMinutesAgo: 20,
    ownerEndedMinutesAgo: 12,
    expect: 'failed',
  },
  {
    id: 'user-stop',
    story: 'The person pressed Stop 12 minutes ago while the turn ran.',
    requestedMinutesAgo: 20,
    ownerEndedMinutesAgo: 12,
    expect: 'stopped',
  },
  {
    id: 'answered',
    story: 'The turn answered normally 12 minutes ago.',
    requestedMinutesAgo: 20,
    ownerEndedMinutesAgo: 12,
    expect: 'answered',
  },
  {
    id: 'live-long-turn',
    story: 'A long turn is still running under an owner that renews its lease.',
    requestedMinutesAgo: 90,
    ownerEndedMinutesAgo: null,
    expect: 'open',
  },
]

/**
 * Check a product's settlement of {@link SETTLEMENT_SCENARIOS}: each scenario's
 * record ends in its expected state, and all of them settle honestly. The
 * product seeds each scenario at `now`, runs its own recovery and settlement
 * jobs at `now`, and reads the records back keyed by scenario id.
 */
export function checkSettlementScenarios(
  records: Readonly<Record<string, SettledTurnRecord | undefined>>,
  options: { now: number; scenarios?: readonly SettlementScenario[] },
): InvariantVerdict {
  const scenarios = options.scenarios ?? SETTLEMENT_SCENARIOS
  const findings: string[] = []
  const present: SettledTurnRecord[] = []
  for (const scenario of scenarios) {
    const record = records[scenario.id]
    if (!record) {
      findings.push(`scenario ${scenario.id}: no turn record was read back`)
      continue
    }
    present.push(record)
    const state = record.terminals[0]?.state ?? 'open'
    if (state !== scenario.expect) findings.push(`scenario ${scenario.id}: ended ${state}, expected ${scenario.expect} (${scenario.story})`)
  }
  const honest = checkTurnSettlement(present, { now: options.now, subject: 'settlement scenarios' })
  if (!honest.pass) findings.push(...honest.details)
  return {
    invariant: 'honest-settlement',
    subject: 'settlement scenarios',
    pass: findings.length === 0,
    details: findings.length ? findings : [`${scenarios.length} failure scenarios settle to their honest state`, ...honest.details],
    data: honest.data,
  }
}
