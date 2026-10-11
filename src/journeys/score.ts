/**
 * Whether a recorded chat turn worked, decided from what the person saw.
 *
 * On 2026-10-11 the GTM journey harness scored 6 of 6 failed turns "completed":
 * it read failure only from `role="alert"` and from the tail of the assistant's
 * markdown, and the red failure card a person saw carried neither. One caption
 * read "Turn complete after 159.6 s" over "The agent stopped before finishing".
 * This module is the replacement rule, pure so every case is a unit test:
 *
 * - failure evidence is read from the WHOLE transcript region (failure-marked
 *   elements, failure lines in plain text, and a Retry control that appeared),
 *   not from the reply alone;
 * - only evidence that appeared during the turn counts, so an earlier failure in
 *   the same thread cannot fail a later turn, and a card that Retry replaced
 *   with a new failure still counts;
 * - a turn that ends with no new reply text is `empty`, never `completed`;
 * - a turn the person stopped is `stopped`, not a success and not a crash.
 */

/** What one poll of the page returns. Collected in the page, judged here. */
export interface TranscriptSnapshot {
  /** Visible lines of the transcript region, trimmed, empty lines dropped. */
  readonly lines: readonly string[]
  /** Text of every failure-marked element (including hidden details). */
  readonly failureNodes: readonly string[]
  /** Retry controls inside the transcript region. */
  readonly retryButtons: number
}

export interface FailurePatterns {
  /** A line matching one of these is failure evidence. */
  readonly failure: readonly RegExp[]
  /** A line matching one of these means the person stopped the turn. */
  readonly stopped: readonly RegExp[]
}

/**
 * Failure text any agent app can show: typed failure codes, provider errors and
 * this package's own sandbox-stream copy. An app adds its own card copy through
 * `chat.failureText` in its journeys config.
 *
 * Matched as substrings of whole lines. A reply that QUOTES one of these fails
 * the turn too; that direction is deliberate, because missing a failure passes a
 * broken product while over-matching only costs a rerun.
 */
export const DEFAULT_FAILURE_TEXT: readonly RegExp[] = [
  /\b[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*_(?:failed|unavailable|timeout)\b/,
  /\bAPIError \d{3}\b/,
  /stopped before a clean completion/i,
  /Failed to connect to Sandbox API/i,
  /\bbilling\.balance_required\b|Add balance or upgrade your plan/i,
  /Internal Server Error/,
  /\bECONNREFUSED\b/,
  /Something went wrong/i,
  // agent-app's own sandbox failure copy (`formatSandboxProvisioningUserMessage`),
  // which every app on the shared runtime can render as a reply. Tests drive the
  // formatter's every branch through these, so the copy and the scorer cannot drift.
  /unable to (?:re)?connect to the sandbox/i,
  /sandbox service didn.t answer/i,
  /Sandbox recovery is required before chat can continue/i,
  /couldn.t (?:finish copying|copy) your Vault into the sandbox/i,
  /too large (?:for the sandbox to accept|to copy into the sandbox)/i,
  /attachment data is staged in the sandbox/i,
]

/** Runtime wording for a turn the person stopped. Apps add their own copy. */
export const DEFAULT_STOPPED_TEXT: readonly RegExp[] = [
  /interrupted by the user/i,
  /cancell?ed by (?:the )?user/i,
  /stopped by (?:the )?user/i,
]

function normalize(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/** Every keyed item of a snapshot that can count as failure evidence. */
function evidenceKeys(snapshot: TranscriptSnapshot, patterns: FailurePatterns, ignore: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>()
  const add = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const raw of snapshot.lines) {
    const line = normalize(raw)
    if (!line || ignore.has(line)) continue
    if (patterns.stopped.some((p) => p.test(line))) add(`stopped:${line}`)
    else if (patterns.failure.some((p) => p.test(line))) add(`text:${line}`)
  }
  for (const raw of snapshot.failureNodes) {
    const text = normalize(raw)
    if (text && !ignore.has(text)) add(`node:${text.slice(0, 300)}`)
  }
  for (let i = 0; i < snapshot.retryButtons; i += 1) add('retry')
  return counts
}

/**
 * Failure evidence that appeared after the turn was sent.
 *
 * `begin` takes the snapshot from just before Send. Every later `observe`
 * lowers each item's floor to the fewest copies seen so far: when Retry removes
 * the old card and a new failure renders the same words, the count dips to zero
 * and climbs back to one, and that one is new. Anything that rose above its
 * floor at any point counts, even if the page later replaced it: on 2026-10-11
 * GTM showed "The sandbox model stream stopped before a clean completion …
 * Hub credential source is revoked or expired" five minutes into a turn, then
 * swapped it for a different card six minutes later.
 */
export class TurnEvidence {
  private floor = new Map<string, number>()
  private peak = new Map<string, number>()
  private readonly ignore: Set<string>

  constructor(private readonly patterns: FailurePatterns, prompt: string) {
    // The person's own prompt is on the page too; a prompt that mentions an
    // error must not fail its own turn.
    this.ignore = new Set(prompt.split('\n').map(normalize).filter(Boolean))
    this.ignore.add(normalize(prompt))
  }

  begin(snapshot: TranscriptSnapshot): void {
    this.floor = evidenceKeys(snapshot, this.patterns, this.ignore)
    this.peak = new Map()
  }

  /** Read one snapshot. Returns the evidence that appeared for the first time, as display text. */
  observe(snapshot: TranscriptSnapshot): string[] {
    const now = evidenceKeys(snapshot, this.patterns, this.ignore)
    for (const [key, floor] of this.floor) {
      const count = now.get(key) ?? 0
      if (count < floor) this.floor.set(key, count)
    }
    const fresh: string[] = []
    for (const [key, count] of now) {
      const extra = count - (this.floor.get(key) ?? 0)
      if (extra <= (this.peak.get(key) ?? 0)) continue
      if (!this.peak.has(key)) fresh.push(display(key))
      this.peak.set(key, extra)
    }
    return fresh
  }

  /** Everything that rose above its floor during the turn, in the order it appeared. */
  added(): { failures: string[]; stopped: string[]; retryAppeared: boolean } {
    const failures: string[] = []
    const stopped: string[] = []
    let retryAppeared = false
    for (const key of this.peak.keys()) {
      if (key === 'retry') retryAppeared = true
      else if (key.startsWith('stopped:')) stopped.push(key.slice('stopped:'.length))
      else failures.push(key.slice(key.indexOf(':') + 1))
    }
    return { failures, stopped, retryAppeared }
  }
}

function display(key: string): string {
  return key === 'retry' ? 'a Retry control appeared in the transcript' : key.slice(key.indexOf(':') + 1)
}

/**
 * Whether a turn is still going, from what the page shows. A status line is
 * progress while it changes; one left unchanged for {@link STATUS_STALE_MS}
 * with no Stop control is a notice left behind (GTM's "Request was
 * interrupted by the user. Send a new message to continue." is a lasting
 * `role="status"`), and treating it as progress held a stopped turn open until
 * its 15-minute timeout.
 */
export const STATUS_STALE_MS = 20_000

export function turnLooksActive(page: { stopVisible: boolean; statusLines: number; msSinceStatusChanged: number }): boolean {
  return page.stopVisible || (page.statusLines > 0 && page.msSinceStatusChanged < STATUS_STALE_MS)
}

export type TurnOutcome = 'completed' | 'failed' | 'stopped' | 'empty' | 'timeout' | 'not-sent'

export interface TurnVerdict {
  outcome: TurnOutcome
  /** Plain words for a caption: the first failure line, or why the turn is not a pass. */
  error: string | null
  /** Every piece of failure evidence the turn added, for the report. */
  failures: string[]
}

export interface TurnFacts {
  /** The send never reached the app. */
  readonly notSent?: string
  /** The app still listed the turn as running when the wait ran out. */
  readonly timedOut: boolean
  readonly evidence: ReturnType<TurnEvidence['added']>
  /** New reply characters this turn added. */
  readonly replyChars: number
  /** The journey pressed Stop during this turn. */
  readonly stopPressed: boolean
}

/** The one place a turn's outcome is decided. Order matters: evidence first. */
export function scoreTurn(facts: TurnFacts): TurnVerdict {
  if (facts.notSent) return { outcome: 'not-sent', error: facts.notSent, failures: [] }
  const { failures, stopped, retryAppeared } = facts.evidence
  const all = [...stopped, ...failures, ...(retryAppeared ? ['a Retry control appeared in the transcript'] : [])]
  // A Stop that took effect. One that did not (still running at the deadline)
  // falls through to `timeout`, because Stop failing is itself the defect.
  if (stopped.length || (facts.stopPressed && !facts.timedOut)) {
    return { outcome: 'stopped', error: stopped[0] ?? failures[0] ?? 'stopped by the journey', failures: all }
  }
  if (failures.length || retryAppeared) {
    return { outcome: 'failed', error: failures[0] ?? 'a Retry control appeared in the transcript', failures: all }
  }
  if (facts.timedOut) return { outcome: 'timeout', error: 'the turn was still running when the wait ended', failures: all }
  if (facts.replyChars === 0) return { outcome: 'empty', error: 'the turn ended without any reply text', failures: all }
  return { outcome: 'completed', error: null, failures: [] }
}
