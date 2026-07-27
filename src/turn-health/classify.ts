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
  /** The turn was answered without the model ever running — a pre-producer gate
   *  short-circuited and returned the product's own response.
   *
   *  Reported as a `warning`, never `critical`: gating an unready turn is a
   *  legitimate design (an intake flow SHOULD answer before spending a model
   *  call). What is pathological is the RATE, which only the caller's own
   *  threshold can judge — so this variant exists to be COUNTED, and alerting
   *  on it is opt-in. It is the per-turn evidence behind a dead tool surface:
   *  a gate that answers every turn means the agent never runs at all. */
  | { kind: 'answered_without_model' }
  /** The detector could not read this turn.
   *
   *  Every part carried a type outside the vocabulary this classifier
   *  understands — which is what field-level encryption at rest looks like from
   *  the outside (tax-agent persists `{"type":"__encrypted_parts__"}`, its own
   *  convention, and 32 of its 129 assistant rows are exactly that).
   *
   *  This exists because the alternative is the bug this whole module hunts.
   *  An unreadable row has no text, no artifact and no tool part, so every
   *  other rule here would happily conclude "nothing wrong" — a detector
   *  reporting health from data it cannot see. Blindness is a finding, not a
   *  pass, so it gets its own reason and its own counter. */
  | { kind: 'unreadable_turn'; partTypes: string[] }

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
  /** Set when a pre-producer gate answered this turn and the model never ran.
   *  Supplied by `/chat-routes`' lifecycle seam, which stamps `gated` on the
   *  completion it now fires for a `contextGate` short-circuit. */
  gated?: boolean
}

/** The verdict for one turn. `healthy` is exactly `reasons.length === 0`, kept
 *  as a field so callers read intent rather than an array length. */
export interface TurnHealthVerdict {
  healthy: boolean
  severity: TurnHealthSeverity | null
  reasons: TurnHealthReason[]
  /** How many tool parts this turn carried.
   *
   *  Zero is NOT a per-turn defect — plenty of good turns answer from context
   *  without touching a tool, and paging on each one would be pure noise. It is
   *  reported so a WINDOW can be judged: a product whose deliverable is tool
   *  output and which produced zero tool calls across every turn in the
   *  lookback has a dead tool surface, and that is the shape no per-turn rule
   *  can see. (Measured: tax-agent, 129 of 129 assistant rows all-time.) */
  toolCalls: number
  /** True when nothing about this turn could be judged — no interpretable part
   *  AND no visible text. Callers MUST exclude these from any healthy/unhealthy
   *  ratio, because counting an unreadable turn as healthy is how a detector
   *  reports green on data it never read. */
  unreadable: boolean
  /** False when this turn carried parts that could not be interpreted.
   *
   *  Separate from {@link unreadable} because the two blindnesses have
   *  different consequences, and production has a row that is one but not the
   *  other: tax-agent persists CIPHERTEXT as `content` alongside an encrypted
   *  `parts` blob, so the turn plainly delivered something (there is text) while
   *  its tool calls are completely invisible.
   *
   *  Any conclusion ABOUT TOOLS — above all the dead-tool-surface verdict — may
   *  only be drawn over turns where this is true. Reading "no tool parts" off an
   *  encrypted blob and declaring the tool surface dead would be the same
   *  crime as declaring it healthy: a finding asserted from data never read. */
  partsReadable: boolean
  /** The part types that could not be interpreted. Empty when
   *  {@link partsReadable}. Named in the alert so a reader can see EXACTLY what
   *  the detector was blind to instead of taking "unreadable" on faith. */
  opaquePartTypes: string[]
}

/** Part kinds that count as something a user actually receives.
 *
 *  A tool part is deliberately NOT here. A turn that ran six tools and said
 *  nothing, with no artifact to show for it, is the malformed-tool-call
 *  disaster — counting a tool chip as output would suppress the very alert
 *  this module exists to raise. */
const ARTIFACT_PART_KINDS = new Set(['file', 'image', 'work-product', 'plan', 'interaction'])

/** Part types that carry no user-visible output but ARE understood.
 *
 *  The distinction matters: a turn made of nothing but `reasoning` parts
 *  thought hard and said nothing, which is a real empty completion. A turn made
 *  of types this module has never heard of is a turn it cannot read. Only the
 *  second is blindness — so these are enumerated rather than lumped in with the
 *  unknown.
 *
 *  Grounded in what the fleet actually persists, not guessed: a scan of every
 *  assistant part in the gtm / legal / tax production tables returns exactly
 *  `tool` (138), `text` (69), `reasoning` (26), `step-start` (3),
 *  `step-finish` (3) and tax's opaque `__encrypted_parts__` (32). */
const KNOWN_NON_OUTPUT_PART_KINDS = new Set([
  'reasoning',
  'step-start',
  'step-finish',
  'source',
  'source-url',
  'data',
])

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
  let toolCalls = 0
  // Part types this module could not interpret. Tracked so blindness can be
  // reported as blindness instead of silently reading as health.
  const opaqueTypes: string[] = []
  let interpretedParts = 0

  for (const raw of parts) {
    const part = asRecord(raw)
    if (!part) continue
    const type = typeof part.type === 'string' ? part.type : ''

    if (type === 'text') {
      interpretedParts += 1
      if (nonEmptyString(part.text) !== null) hasVisibleText = true
      continue
    }
    if (ARTIFACT_PART_KINDS.has(type)) {
      interpretedParts += 1
      artifactCount += 1
      continue
    }
    if (KNOWN_NON_OUTPUT_PART_KINDS.has(type)) {
      interpretedParts += 1
      continue
    }
    if (type !== 'tool') {
      opaqueTypes.push(type || '(missing type)')
      continue
    }
    interpretedParts += 1
    toolCalls += 1

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

  // A turn whose parts were ALL uninterpretable cannot be judged. Reported as
  // blindness and returned early, because every rule below would otherwise read
  // "no text, no artifact" off data that was simply encrypted and call it a
  // blank completion — a false page that would train readers to ignore this
  // module, which is the same ending as no detector at all.
  const partsReadable = opaqueTypes.length === 0
  const uniqueOpaque = [...new Set(opaqueTypes)]
  const unreadable = opaqueTypes.length > 0 && interpretedParts === 0 && !hasVisibleText
  if (unreadable) {
    reasons.push({ kind: 'unreadable_turn', partTypes: uniqueOpaque })
    return {
      healthy: false,
      severity: 'warning',
      reasons,
      toolCalls,
      unreadable: true,
      partsReadable: false,
      opaquePartTypes: uniqueOpaque,
    }
  }

  // A gate answered before the producer ran. Recorded rather than judged: see
  // `answered_without_model`. It also SUPPRESSES the empty-completion rule
  // below — the model producing no text is the expected outcome when the model
  // never ran, and firing `empty_completion` here would page on every healthy
  // intake turn.
  if (input.gated) {
    reasons.push({ kind: 'answered_without_model' })
  } else if (!input.failed && !hasVisibleText && artifactCount === 0) {
    // `outputTokens` is corroborating evidence, never the trigger: a turn can
    // spend tokens on reasoning and still deliver nothing, and a turn with
    // unknown usage can still be perfectly fine.
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
    toolCalls,
    unreadable: false,
    partsReadable,
    opaquePartTypes: uniqueOpaque,
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
    case 'answered_without_model':
      return 'answered by a pre-producer gate — the model never ran'
    case 'unreadable_turn':
      return `turn could not be read: every part had an uninterpretable type (${reason.partTypes.join(
        ', ',
      )})`
  }
}
