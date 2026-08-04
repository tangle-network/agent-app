/**
 * The pure half of the provenance affordance: what kind of claim a value is,
 * what a reader should DO about it, and what has to be SAID when its origin
 * cannot be shown.
 *
 * Zero React, zero DOM — a loader or a worker can decide a value's standing
 * before it reaches a screen, and `./provenance`'s `ProvenanceValue` renders
 * exactly what these functions decide.
 *
 * The distinction the module exists to hold: a person typing a number, a
 * document carrying it, a formula producing it, and a model claiming it are
 * four different kinds of evidence. Rendered as one grey caption they are
 * indistinguishable, which is how an unverified model assertion reads to a
 * reviewer as a transcribed fact.
 *
 * Every domain word is a caller parameter: no field names, no document kinds,
 * and no confidence policy beyond a default the product overrides.
 */

/**
 * How a value came to exist. Four kinds, never interchangeable:
 *
 * - `extracted` — read out of a document or message the product can open.
 * - `entered` — a person typed or confirmed it.
 * - `computed` — produced from other values, each carrying its own provenance.
 * - `asserted` — the agent stated it, with nothing outside the model behind it.
 */
export type ProvenanceBasis = 'extracted' | 'entered' | 'computed' | 'asserted'

/** Every basis, in the order a legend should list them. */
export const PROVENANCE_BASES: readonly ProvenanceBasis[] = ['extracted', 'entered', 'computed', 'asserted']

/** The words one basis is rendered and announced with. */
export interface ProvenanceBasisMeta {
  /** Marker text next to the value — short, and never only a colour. */
  label: string
  /** One plain sentence naming what kind of claim this is. */
  meaning: string
  /** What a reader can hold the value against, or `null` when nothing outside
   *  the model can. `null` is what makes an `asserted` value uncertifiable at
   *  any confidence. */
  checkableAgainst: string | null
}

const BASIS_META: Record<ProvenanceBasis, ProvenanceBasisMeta> = {
  extracted: {
    label: 'From document',
    meaning: 'Read out of a source document.',
    checkableAgainst: 'the document it was read from',
  },
  entered: {
    label: 'Entered by a person',
    meaning: 'A person typed or confirmed this value.',
    checkableAgainst: 'the person who entered it',
  },
  computed: {
    label: 'Computed',
    meaning: 'Produced from other values.',
    checkableAgainst: 'the values it was computed from',
  },
  asserted: {
    label: 'Agent, unverified',
    meaning: 'The agent stated this. No source was recorded behind it.',
    checkableAgainst: null,
  },
}

/** Words for one basis. */
export function provenanceBasisMeta(basis: ProvenanceBasis): ProvenanceBasisMeta {
  return BASIS_META[basis]
}

/** Whether a source could be resolved. `ready` is the default for a source that
 *  says nothing. */
export type ProvenanceSourceStatus = 'ready' | 'loading' | 'unavailable'

/** One thing a value came from. A `label` is mandatory because an unnamed
 *  source is the same as no source. */
export interface ProvenanceSource {
  /** What the source IS, in the reader's words: "Form W-2 (Acme Corp)",
   *  "Dana Whitfield", "Engagement letter". */
  label: string
  /** The text in the source that carries the value. */
  quote?: string
  /** Position inside the source — a page, a line, a span, a timestamp. The
   *  caller's words; nothing here parses it. */
  locator?: string
  /** Click-through target. Absent → the source is named but not openable. */
  href?: string
  /** Defaults to `ready`. */
  status?: ProvenanceSourceStatus
  /** Why an `unavailable` source cannot be opened, in one sentence. */
  unavailableReason?: string
}

/**
 * What the reader should DO about a value — the only form confidence takes on
 * screen. "89% confidence" names no next move; these three do.
 *
 * - `settled` — nothing to do.
 * - `check` — open the source and confirm before relying on it.
 * - `confirm` — a person has to confirm the value before it is used.
 */
export type ProvenanceStanding = 'settled' | 'check' | 'confirm'

/** The words one standing is rendered and announced with. */
export interface ProvenanceStandingMeta {
  /** Short state label. */
  label: string
  /** The next move, as a sentence a person can follow. */
  action: string
}

const STANDING_META: Record<ProvenanceStanding, ProvenanceStandingMeta> = {
  settled: { label: 'Traced', action: 'Nothing to check — this value can be traced to where it came from.' },
  check: { label: 'Check the source', action: 'Open the source and confirm this value before you rely on it.' },
  confirm: { label: 'Needs a person', action: 'Someone has to confirm this value before it is used.' },
}

/** Words for one standing. */
export function provenanceStandingMeta(standing: ProvenanceStanding): ProvenanceStandingMeta {
  return STANDING_META[standing]
}

const STANDING_SEVERITY: Record<ProvenanceStanding, number> = { settled: 0, check: 1, confirm: 2 }

/** The weaker of two standings — `confirm` beats `check` beats `settled`. */
export function weakerProvenanceStanding(a: ProvenanceStanding, b: ProvenanceStanding): ProvenanceStanding {
  return STANDING_SEVERITY[a] >= STANDING_SEVERITY[b] ? a : b
}

/**
 * Where a product draws its confidence lines. These are a POLICY, not a truth:
 * a number a model reports about itself means different things per surface, so
 * the thresholds are a parameter and the number itself never reaches the screen.
 */
export interface ProvenanceConfidencePolicy {
  /** At or above this, a value is `settled`. */
  settledAtOrAbove: number
  /** At or above this (and below `settledAtOrAbove`), a value is `check`.
   *  Below it, `confirm`. */
  checkAtOrAbove: number
}

/** The starting policy. Products with a different tolerance pass their own. */
export const DEFAULT_PROVENANCE_CONFIDENCE_POLICY: ProvenanceConfidencePolicy = {
  settledAtOrAbove: 0.9,
  checkAtOrAbove: 0.6,
}

/** A value, where it came from, and — when it was computed — the provenanced
 *  values it came from. The `inputs` field is what makes the shape compose:
 *  a computed value's provenance IS its inputs. */
export interface ProvenanceRecord {
  /** The value as the reader should see it, already formatted. An empty string
   *  is a missing value and renders as one, never as blank space. */
  display: string
  /** What the value IS ("Wages", "Filing deadline"). Optional at the top level,
   *  where the surface around it usually says; rendered for every composed
   *  input, where nothing else names them. */
  label?: string
  basis: ProvenanceBasis
  /** Where it came from. An `extracted` value without one is a gap, not a
   *  detail. */
  sources?: readonly ProvenanceSource[]
  /** The provenanced values a `computed` value was produced from. */
  inputs?: readonly ProvenanceRecord[]
  /** How the inputs combine, in the caller's words ("wages + interest"). */
  derivation?: string
  /** 0–1. Never rendered as a number — it selects a standing. */
  confidence?: number
  /** Overrides the standing confidence and basis would produce — a reviewer
   *  approved it, a gate failed. It can only make a value WEAKER: the
   *  structural floors below still apply, so a product cannot mark a value
   *  settled that has no origin on file. */
  standing?: ProvenanceStanding
}

/** The standing a bare confidence maps to under a policy. */
export function standingFromConfidence(
  confidence: number,
  policy: ProvenanceConfidencePolicy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY,
): ProvenanceStanding {
  if (confidence >= policy.settledAtOrAbove) return 'settled'
  if (confidence >= policy.checkAtOrAbove) return 'check'
  return 'confirm'
}

/** The standing a basis implies before any confidence or gap is considered. */
function standingFromBasis(basis: ProvenanceBasis): ProvenanceStanding {
  // Only `asserted` starts weak: the other three name something outside the
  // model — a document, a person, a computation — that a reader can go check.
  return basis === 'asserted' ? 'check' : 'settled'
}

/** Something missing that the reader has to be TOLD about, because the value
 *  renders either way and a bare number reads as a fact. */
export type ProvenanceGapKind = 'no-source' | 'no-inputs' | 'unavailable-source'

/** One stated gap. `message` is rendered verbatim. */
export interface ProvenanceGap {
  kind: ProvenanceGapKind
  message: string
  /** The source that could not be resolved (`unavailable-source` only). */
  source?: ProvenanceSource
}

/** The sentence for a source that is not `ready`, or `null` when it is. One
 *  source of this copy, so the row and the gap list never disagree. */
export function describeProvenanceSourceStatus(source: ProvenanceSource): string | null {
  if (source.status === 'loading') return `Looking up ${source.label}…`
  if (source.status === 'unavailable') {
    return source.unavailableReason
      ? `${source.label} could not be opened — ${source.unavailableReason}`
      : `${source.label} could not be opened.`
  }
  return null
}

/**
 * What this record cannot show, at its own level. Inputs are not walked: every
 * composed input renders its own gaps next to its own value, where a reader can
 * act on them.
 */
export function provenanceGaps(record: ProvenanceRecord): ProvenanceGap[] {
  const gaps: ProvenanceGap[] = []
  const sources = record.sources ?? []
  if (record.basis === 'extracted' && sources.length === 0) {
    gaps.push({
      kind: 'no-source',
      message: 'Read from a document, but no document is on file — nothing here shows where this came from.',
    })
  }
  if (record.basis === 'computed' && (record.inputs ?? []).length === 0) {
    gaps.push({
      kind: 'no-inputs',
      message: 'Computed, but the values it was computed from are not recorded.',
    })
  }
  for (const source of sources) {
    if (source.status !== 'unavailable') continue
    gaps.push({
      kind: 'unavailable-source',
      message: describeProvenanceSourceStatus(source) ?? `${source.label} could not be opened.`,
      source,
    })
  }
  return gaps
}

/** The sources still resolving — rendered as their own state, never as an
 *  absence. A load in flight is not a missing source. */
export function loadingProvenanceSources(record: ProvenanceRecord): ProvenanceSource[] {
  return (record.sources ?? []).filter((source) => source.status === 'loading')
}

/**
 * This record's own standing, ignoring its inputs.
 *
 * The order is: start from the explicit standing, else from confidence, else
 * from the basis — then apply every structural floor, taking the WEAKEST. The
 * floors are what a caller cannot talk its way out of:
 *
 * - an `asserted` value never reaches `settled` (a model's own confidence
 *   cannot certify the model's claim — there is nothing to check it against),
 * - a `no-source` / `no-inputs` gap forces `confirm` (a value dressed as
 *   evidence with no evidence behind it is worse than an open guess),
 * - an unopenable source forces `check` (the value may be right; the reader
 *   just cannot confirm it).
 */
export function resolveProvenanceStanding(
  record: ProvenanceRecord,
  policy: ProvenanceConfidencePolicy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY,
): ProvenanceStanding {
  let standing =
    record.standing ??
    (record.confidence === undefined ? standingFromBasis(record.basis) : standingFromConfidence(record.confidence, policy))

  if (record.basis === 'asserted') standing = weakerProvenanceStanding(standing, 'check')
  for (const gap of provenanceGaps(record)) {
    standing = weakerProvenanceStanding(standing, gap.kind === 'unavailable-source' ? 'check' : 'confirm')
  }
  return standing
}

/**
 * The standing a reader should see: this record's own, weakened by every value
 * it was computed from, however deep.
 *
 * A total is only as trustworthy as the weakest number in it. Rendering the
 * parent's own standing instead is how an exact sum of one document figure and
 * one model guess presents as traced.
 *
 * Cycle-safe: a record reachable from itself is counted once.
 */
export function rollUpProvenanceStanding(
  record: ProvenanceRecord,
  policy: ProvenanceConfidencePolicy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY,
  seen: Set<ProvenanceRecord> = new Set(),
): ProvenanceStanding {
  if (seen.has(record)) return 'settled'
  seen.add(record)
  let standing = resolveProvenanceStanding(record, policy)
  for (const input of record.inputs ?? []) {
    standing = weakerProvenanceStanding(standing, rollUpProvenanceStanding(input, policy, seen))
  }
  return standing
}

function sourcePhrase(source: ProvenanceSource): string {
  return source.locator ? `${source.label}, ${source.locator}` : source.label
}

function inputPhrase(input: ProvenanceRecord): string {
  return input.label ?? input.display
}

/**
 * One plain sentence naming where the value came from — the panel's first line
 * and part of what a screen reader announces. It states the absence when there
 * is one, so no code path produces silence.
 */
export function describeProvenance(record: ProvenanceRecord): string {
  const sources = record.sources ?? []
  const first = sources[0]
  const more = sources.length > 1 ? ` and ${sources.length - 1} more source${sources.length > 2 ? 's' : ''}` : ''

  switch (record.basis) {
    case 'extracted':
      return first ? `Read from ${sourcePhrase(first)}${more}.` : 'Read from a document, but no document is on file.'
    case 'entered':
      return first ? `Entered by ${sourcePhrase(first)}.` : 'Entered by a person.'
    case 'computed': {
      const inputs = record.inputs ?? []
      if (record.derivation) return `Computed from ${record.derivation}.`
      if (inputs.length === 0) return 'Computed, but the values it was computed from are not recorded.'
      return `Computed from ${inputs.map(inputPhrase).join(', ')}.`
    }
    case 'asserted':
      return first
        ? `Stated by the agent, pointing at ${sourcePhrase(first)} — not verified against it.`
        : 'Stated by the agent, with no source to check it against.'
  }
}

/**
 * The move THIS value's reader can actually make.
 *
 * `provenanceStandingMeta().action` is the generic sentence for a standing;
 * this is the one that accounts for what is on file. "Open the source and
 * confirm it" is a dead instruction on a value that has no source — an action
 * a reader cannot perform is the same defect as no action at all.
 */
export function provenanceNextMove(
  record: ProvenanceRecord,
  standing: ProvenanceStanding,
  policy: ProvenanceConfidencePolicy = DEFAULT_PROVENANCE_CONFIDENCE_POLICY,
): string {
  const generic = provenanceStandingMeta(standing).action
  if (standing === 'settled') return generic

  const gaps = provenanceGaps(record)
  if (gaps.some((gap) => gap.kind === 'no-source')) {
    return 'Nobody recorded where this came from. Confirm the value and record its source before it is used.'
  }
  if (gaps.some((gap) => gap.kind === 'no-inputs')) {
    return 'Nobody recorded what this was computed from. Confirm the value and record its inputs before it is used.'
  }
  if (gaps.some((gap) => gap.kind === 'unavailable-source')) {
    return 'The source could not be opened. Try again, or confirm this value another way before you rely on it.'
  }
  if (record.basis === 'asserted' && (record.sources ?? []).length === 0) {
    return 'The agent gave no source. Check this against the real document before you rely on it.'
  }
  // Weakened only by what it was computed from: the move is one level down,
  // not on this row.
  if (record.basis === 'computed' && (record.inputs ?? []).length > 0 && resolveProvenanceStanding(record, policy) === 'settled') {
    return 'One of the values this was computed from still needs checking — open the marked ones below.'
  }
  return generic
}

/**
 * The accessible name of the disclosure control: the value, how it came to
 * exist, and — unless there is nothing to do — the next move. This is the
 * whole affordance for someone who never sees the colour.
 */
export function provenanceTriggerLabel(record: ProvenanceRecord, standing: ProvenanceStanding): string {
  const value = record.display.trim() === '' ? 'this missing value' : `“${record.display}”`
  const named = record.label ? `${record.label} ${value}` : value
  const basis = provenanceBasisMeta(record.basis).label
  const next = standing === 'settled' ? '' : ` ${provenanceStandingMeta(standing).label}.`
  return `Where ${named} came from — ${basis}.${next}`
}
