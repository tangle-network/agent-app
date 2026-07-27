/**
 * The classifier for turns that FAIL BY RETURNING SUCCESS.
 *
 * Every failure this module names shipped to a customer with HTTP 200, no
 * thrown error, and no log line anyone read. Three were measured in production
 * in a single week:
 *
 *   - a turn settled `{"outcome":{"type":"completed"},"finalText":"",
 *     "tokenUsage":{"outputTokens":0}}` — the customer saw a blank bubble;
 *   - six `submit_proposal` tool calls collapsed into ONE whose arguments were
 *     a 1,652-character non-JSON string, so zero proposals persisted and
 *     nothing errored (agent-runtime #626);
 *   - a thread took 255 user messages over 17 days and produced 2 replies,
 *     both of them error text.
 *
 * A conventional health check cannot see any of these, because it probes
 * DEPENDENCIES (is the sandbox reachable, is the router up) and every one of
 * these failures happens with all dependencies green. This classifier probes
 * the OUTCOME instead.
 *
 * It is deliberately pure and structural: it reads a settled turn's own
 * projection, so the SAME function judges a live turn through the
 * `/chat-routes` lifecycle seam and a historical row read back out of the
 * store during a sweep. One definition of "silently broken", two call sites.
 */

/** How loudly a reason should be routed. `critical` means a customer got
 *  nothing usable; `warning` means the turn degraded but still produced
 *  something a human could read. */
export type TurnHealthSeverity = 'critical' | 'warning'

/** One specific way a turn returned success while failing.
 *
 *  Each variant carries the evidence that identified it, so an alert can name
 *  the offending value instead of asserting a verdict the reader has to take
 *  on faith. */
export type TurnHealthReason =
  /** Settled without error and produced nothing a user can read: no text, and
   *  no artifact part (file/image/work-product/plan/interaction). This is the
   *  verbatim blank-completion capture. */
  | {
      kind: 'empty_completion'
      outputTokens: number | null
      partCount: number
      durationMs?: number
    }
  /** A tool call whose arguments never parsed. The engine surfaces unparseable
   *  arguments as a RAW STRING rather than throwing, so the call is neither
   *  dropped nor errored — it silently does nothing. Detecting a string-typed
   *  tool input that fails `JSON.parse` is the exact fingerprint of the
   *  index-less parallel-tool-call collapse. */
  | {
      kind: 'malformed_tool_call'
      tool: string
      inputLength: number
      /** Leading characters of the offending input, for the alert body. */
      sample: string
    }
  /** A tool call that never reached a terminal state carrying output. The call
   *  was issued and then simply produced no effect. */
  | {
      kind: 'tool_call_no_effect'
      tool: string
      status: string
    }
  /** The turn failed outright. Not silent by itself — but it becomes silent
   *  the moment nothing is watching, which is how 16 days of
   *  `TANGLE_HUB_URL is required` reached customers unnoticed. */
  | { kind: 'turn_failed'; reason: string }

/** A settled turn, in the narrowest shape both call sites can supply.
 *
 *  Structural on purpose: the lifecycle seam supplies `finalText`/`usage`, a
 *  store sweep supplies `content`/`parts` read back from a row, and neither
 *  has to import the other's types. */
export interface TurnOutcomeInput {
  /** The turn's final assistant text. */
  finalText?: string | null
  /** The persisted assistant parts. Untyped by design — a sweep reads these
   *  out of a JSON column and must not be forced to validate them first. */
  parts?: readonly unknown[] | null
  /** Output tokens, when the caller has usage. `null`/absent is unknown, which
   *  is NOT the same as zero and is never treated as evidence. */
  outputTokens?: number | null
  /** Set when the turn surfaced a terminal error event. */
  failed?: boolean
  failureReason?: string | null
  durationMs?: number
}

/** The verdict for one turn. `healthy` is exactly `reasons.length === 0`, kept
 *  as a field so callers read intent rather than an array length. */
export interface TurnHealthVerdict {
  healthy: boolean
  severity: TurnHealthSeverity | null
  reasons: TurnHealthReason[]
}

/** Part kinds that count as something a user actually receives.
 *
 *  A tool part is deliberately NOT here. A turn that ran six tools and said
 *  nothing, with no artifact to show for it, is the malformed-tool-call
 *  disaster — counting a tool chip as output would suppress the very alert
 *  this module exists to raise. */
const ARTIFACT_PART_KINDS = new Set(['file', 'image', 'work-product', 'plan', 'interaction'])

const SAMPLE_CHARS = 120

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/** True when a string is not parseable JSON.
 *
 *  Only meaningful for tool INPUT, where the engine's contract is that a
 *  well-formed call carries an object (or a string that parses into one). A
 *  string that fails to parse means the arguments were concatenated or
 *  truncated upstream. */
function isUnparseableJson(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  try {
    JSON.parse(trimmed)
    return false
  } catch {
    return true
  }
}

/** Tool statuses that mean the call actually landed.
 *
 *  Anything else — `pending`, `running`, `error`, an unknown string — left no
 *  persisted effect by the time the turn settled. */
const SETTLED_TOOL_STATUSES = new Set(['completed', 'complete', 'success', 'done'])

/**
 * Judge one settled turn.
 *
 * Never throws: a malformed `parts` blob is a thing this function REPORTS on,
 * so it must not be a thing it dies on. Telemetry that can crash the turn it
 * measures is worse than no telemetry.
 */
export function classifyTurnOutcome(input: TurnOutcomeInput): TurnHealthVerdict {
  const reasons: TurnHealthReason[] = []

  if (input.failed) {
    reasons.push({
      kind: 'turn_failed',
      reason: nonEmptyString(input.failureReason) ?? 'unspecified',
    })
  }

  const parts = Array.isArray(input.parts) ? input.parts : []

  let hasVisibleText = nonEmptyString(input.finalText) !== null
  let artifactCount = 0

  for (const raw of parts) {
    const part = asRecord(raw)
    if (!part) continue
    const type = typeof part.type === 'string' ? part.type : ''

    if (type === 'text' && nonEmptyString(part.text) !== null) {
      hasVisibleText = true
      continue
    }
    if (ARTIFACT_PART_KINDS.has(type)) {
      artifactCount += 1
      continue
    }
    if (type !== 'tool') continue

    const tool = nonEmptyString(part.tool) ?? 'unknown'
    const state = asRecord(part.state)
    const status = typeof state?.status === 'string' ? state.status : 'unknown'

    // The #626 fingerprint: arguments surfaced as a raw string because they
    // failed to parse upstream. Checked before the status gate — a malformed
    // call can still be marked completed, which is precisely why it is silent.
    const toolInput = state?.input
    if (typeof toolInput === 'string' && isUnparseableJson(toolInput)) {
      reasons.push({
        kind: 'malformed_tool_call',
        tool,
        inputLength: toolInput.length,
        sample: toolInput.slice(0, SAMPLE_CHARS),
      })
      continue
    }

    if (!SETTLED_TOOL_STATUSES.has(status)) {
      reasons.push({ kind: 'tool_call_no_effect', tool, status })
    }
  }

  // `outputTokens` is corroborating evidence, never the trigger: a turn can
  // spend tokens on reasoning and still deliver nothing, and a turn with
  // unknown usage can still be perfectly fine.
  if (!input.failed && !hasVisibleText && artifactCount === 0) {
    reasons.push({
      kind: 'empty_completion',
      outputTokens: input.outputTokens ?? null,
      partCount: parts.length,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    })
  }

  return {
    healthy: reasons.length === 0,
    severity: severityOf(reasons),
    reasons,
  }
}

/** `critical` when the customer got nothing usable out of the turn. A
 *  malformed tool call alongside readable text is a `warning` — degraded, but
 *  a human still received an answer. */
function severityOf(reasons: TurnHealthReason[]): TurnHealthSeverity | null {
  if (reasons.length === 0) return null
  const critical = reasons.some((r) => r.kind === 'empty_completion' || r.kind === 'turn_failed')
  return critical ? 'critical' : 'warning'
}

/** One-line human summary of a reason, for an alert body. */
export function describeReason(reason: TurnHealthReason): string {
  switch (reason.kind) {
    case 'empty_completion':
      return `completed with NO output (${reason.partCount} parts, outputTokens=${
        reason.outputTokens ?? 'unknown'
      })`
    case 'malformed_tool_call':
      return `tool \`${reason.tool}\` arguments did not parse (${reason.inputLength} chars): ${reason.sample}`
    case 'tool_call_no_effect':
      return `tool \`${reason.tool}\` left no effect (status=${reason.status})`
    case 'turn_failed':
      return `turn failed: ${reason.reason}`
  }
}
