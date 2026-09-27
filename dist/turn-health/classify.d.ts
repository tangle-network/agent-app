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
export type TurnHealthSeverity = 'critical' | 'warning';
/** One specific way a turn returned success while failing.
 *
 *  Each variant carries the evidence that identified it, so an alert can name
 *  the offending value instead of asserting a verdict the reader has to take
 *  on faith. */
export type TurnHealthReason = 
/** Settled without error and produced nothing a user can read: no text, and
 *  no artifact part (file/image/work-product/plan/interaction). This is the
 *  verbatim blank-completion capture. */
{
    kind: 'empty_completion';
    outputTokens: number | null;
    partCount: number;
    durationMs?: number;
}
/** A tool call whose arguments never parsed. The engine surfaces unparseable
 *  arguments as a RAW STRING rather than throwing, so the call is neither
 *  dropped nor errored — it silently does nothing. Detecting a string-typed
 *  tool input that fails `JSON.parse` is the exact fingerprint of the
 *  index-less parallel-tool-call collapse. */
 | {
    kind: 'malformed_tool_call';
    tool: string;
    inputLength: number;
    /** Leading characters of the offending input, for the alert body. */
    sample: string;
}
/** A tool call that never reached a terminal state carrying output. The call
 *  was issued and then simply produced no effect. */
 | {
    kind: 'tool_call_no_effect';
    tool: string;
    status: string;
}
/** The turn failed outright. Not silent by itself — but it becomes silent
 *  the moment nothing is watching, which is how 16 days of
 *  `TANGLE_HUB_URL is required` reached customers unnoticed. */
 | {
    kind: 'turn_failed';
    reason: string;
}
/** A tool call the harness REJECTED, settled as `completed`.
 *
 *  Found live in legal-agent production, and missed by every other rule here:
 *  the model called `submit_proposal`, the harness answered "Model tried to
 *  call unavailable tool 'submit_proposal'", and the part persisted as
 *  `{"tool":"invalid","state":{"status":"completed","input":{"error":"…"}}}`.
 *
 *  Status is `completed`, the arguments parse cleanly, and the turn has text —
 *  so the blank-completion, malformed-argument and no-effect rules all pass it.
 *  Six deliverables were requested and silently discarded while the product
 *  reported success six times.
 *
 *  Detected structurally, on the presence of an `error` in the settled state
 *  rather than on any harness's name for a rejected call — `invalid` is one
 *  harness's convention and must not be baked into the shell. */
 | {
    kind: 'tool_call_rejected';
    /** The tool the model was trying to reach, when the payload names it. */
    tool: string;
    error: string;
}
/** The turn was answered without the model ever running — a pre-producer gate
 *  short-circuited and returned the product's own response.
 *
 *  Reported as a `warning`, never `critical`: gating an unready turn is a
 *  legitimate design (an intake flow SHOULD answer before spending a model
 *  call). What is pathological is the RATE, which only the caller's own
 *  threshold can judge — so this variant exists to be COUNTED, and alerting
 *  on it is opt-in. It is the per-turn evidence behind a dead tool surface:
 *  a gate that answers every turn means the agent never runs at all. */
 | {
    kind: 'answered_without_model';
}
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
 | {
    kind: 'unreadable_turn';
    partTypes: string[];
};
/** A settled turn, in the narrowest shape both call sites can supply.
 *
 *  Structural on purpose: the lifecycle seam supplies `finalText`/`usage`, a
 *  store sweep supplies `content`/`parts` read back from a row, and neither
 *  has to import the other's types. */
export interface TurnOutcomeInput {
    /** The turn's final assistant text. */
    finalText?: string | null;
    /** The persisted assistant parts. Untyped by design — a sweep reads these
     *  out of a JSON column and must not be forced to validate them first. */
    parts?: readonly unknown[] | null;
    /** Output tokens, when the caller has usage. `null`/absent is unknown, which
     *  is NOT the same as zero and is never treated as evidence. */
    outputTokens?: number | null;
    /** Set when the turn surfaced a terminal error event. */
    failed?: boolean;
    failureReason?: string | null;
    durationMs?: number;
    /** Set when a pre-producer gate answered this turn and the model never ran.
     *  Supplied by `/chat-routes`' lifecycle seam, which stamps `gated` on the
     *  completion it now fires for a `contextGate` short-circuit. */
    gated?: boolean;
}
/** The verdict for one turn. `healthy` is exactly `reasons.length === 0`, kept
 *  as a field so callers read intent rather than an array length. */
export interface TurnHealthVerdict {
    healthy: boolean;
    severity: TurnHealthSeverity | null;
    reasons: TurnHealthReason[];
    /** How many tool parts this turn carried.
     *
     *  Zero is NOT a per-turn defect — plenty of good turns answer from context
     *  without touching a tool, and paging on each one would be pure noise. It is
     *  reported so a WINDOW can be judged: a product whose deliverable is tool
     *  output and which produced zero tool calls across every turn in the
     *  lookback has a dead tool surface, and that is the shape no per-turn rule
     *  can see.
     *
     *  Only meaningful alongside {@link interpretedParts} > 0. Zero tool calls
     *  read off a row that persisted NO parts is not an observation about the
     *  tool surface — it is the absence of one. */
    toolCalls: number;
    /** True when nothing about this turn could be judged — no interpretable part
     *  AND no visible text. Callers MUST exclude these from any healthy/unhealthy
     *  ratio, because counting an unreadable turn as healthy is how a detector
     *  reports green on data it never read. */
    unreadable: boolean;
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
    partsReadable: boolean;
    /** The part types that could not be interpreted. Empty when
     *  {@link partsReadable}. Named in the alert so a reader can see EXACTLY what
     *  the detector was blind to instead of taking "unreadable" on faith. */
    opaquePartTypes: string[];
    /** How many parts this module actually READ (text, artifact, tool, or a known
     *  non-output kind).
     *
     *  The third blindness, and the one that shipped a false page. `partsReadable`
     *  only says nothing was *uninterpretable*; a row that persisted NO parts at
     *  all satisfies that vacuously. Production: 97 of tax-agent's 156 assistant
     *  rows predate parts persistence entirely and store `[]`, and reading "zero
     *  tool calls" off them raised a critical `dead_tool_surface` against a
     *  product whose own `turn_events` table holds 243 `tool_call` frames.
     *
     *  So a tool verdict requires BOTH `partsReadable` AND this being > 0 —
     *  evidence that was read, not merely evidence that failed to be unreadable. */
    interpretedParts: number;
}
/**
 * Judge one settled turn.
 *
 * Never throws: a malformed `parts` blob is a thing this function REPORTS on,
 * so it must not be a thing it dies on. Telemetry that can crash the turn it
 * measures is worse than no telemetry.
 */
export declare function classifyTurnOutcome(input: TurnOutcomeInput): TurnHealthVerdict;
/** One-line human summary of a reason, for an alert body. */
export declare function describeReason(reason: TurnHealthReason): string;
