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
export type ProvenanceBasis = 'extracted' | 'entered' | 'computed' | 'asserted';
/** Every basis, in the order a legend should list them. */
export declare const PROVENANCE_BASES: readonly ProvenanceBasis[];
/** The words one basis is rendered and announced with. */
export interface ProvenanceBasisMeta {
    /** Marker text next to the value — short, and never only a colour. */
    label: string;
    /** One plain sentence naming what kind of claim this is. */
    meaning: string;
    /** What a reader can hold the value against, or `null` when nothing outside
     *  the model can. `null` is what makes an `asserted` value uncertifiable at
     *  any confidence. */
    checkableAgainst: string | null;
}
/** Words for one basis. */
export declare function provenanceBasisMeta(basis: ProvenanceBasis): ProvenanceBasisMeta;
/** Whether a source could be resolved. `ready` is the default for a source that
 *  says nothing. */
export type ProvenanceSourceStatus = 'ready' | 'loading' | 'unavailable';
/** One thing a value came from. A `label` is mandatory because an unnamed
 *  source is the same as no source. */
export interface ProvenanceSource {
    /** What the source IS, in the reader's words: "Form W-2 (Acme Corp)",
     *  "Dana Whitfield", "Engagement letter". */
    label: string;
    /** The text in the source that carries the value. */
    quote?: string;
    /** Position inside the source — a page, a line, a span, a timestamp. The
     *  caller's words; nothing here parses it. */
    locator?: string;
    /** Click-through target. Absent → the source is named but not openable. */
    href?: string;
    /** Defaults to `ready`. */
    status?: ProvenanceSourceStatus;
    /** Why an `unavailable` source cannot be opened, in one sentence. */
    unavailableReason?: string;
}
/**
 * What the reader should DO about a value — the only form confidence takes on
 * screen. "89% confidence" names no next move; these three do.
 *
 * - `settled` — nothing to do.
 * - `check` — open the source and confirm before relying on it.
 * - `confirm` — a person has to confirm the value before it is used.
 */
export type ProvenanceStanding = 'settled' | 'check' | 'confirm';
/** The words one standing is rendered and announced with. */
export interface ProvenanceStandingMeta {
    /** Short state label. */
    label: string;
    /** The next move, as a sentence a person can follow. */
    action: string;
}
/** Words for one standing. */
export declare function provenanceStandingMeta(standing: ProvenanceStanding): ProvenanceStandingMeta;
/** The weaker of two standings — `confirm` beats `check` beats `settled`. */
export declare function weakerProvenanceStanding(a: ProvenanceStanding, b: ProvenanceStanding): ProvenanceStanding;
/**
 * Where a product draws its confidence lines. These are a POLICY, not a truth:
 * a number a model reports about itself means different things per surface, so
 * the thresholds are a parameter and the number itself never reaches the screen.
 */
export interface ProvenanceConfidencePolicy {
    /** At or above this, a value is `settled`. */
    settledAtOrAbove: number;
    /** At or above this (and below `settledAtOrAbove`), a value is `check`.
     *  Below it, `confirm`. */
    checkAtOrAbove: number;
}
/** The starting policy. Products with a different tolerance pass their own. */
export declare const DEFAULT_PROVENANCE_CONFIDENCE_POLICY: ProvenanceConfidencePolicy;
/** A value, where it came from, and — when it was computed — the provenanced
 *  values it came from. The `inputs` field is what makes the shape compose:
 *  a computed value's provenance IS its inputs. */
export interface ProvenanceRecord {
    /** The value as the reader should see it, already formatted. An empty string
     *  is a missing value and renders as one, never as blank space. */
    display: string;
    /** What the value IS ("Wages", "Filing deadline"). Optional at the top level,
     *  where the surface around it usually says; rendered for every composed
     *  input, where nothing else names them. */
    label?: string;
    basis: ProvenanceBasis;
    /** Where it came from. An `extracted` value without one is a gap, not a
     *  detail. */
    sources?: readonly ProvenanceSource[];
    /** The provenanced values a `computed` value was produced from. */
    inputs?: readonly ProvenanceRecord[];
    /** How the inputs combine, in the caller's words ("wages + interest"). */
    derivation?: string;
    /** 0–1. Never rendered as a number — it selects a standing. */
    confidence?: number;
    /** Overrides the standing confidence and basis would produce — a reviewer
     *  approved it, a gate failed. It can only make a value WEAKER: the
     *  structural floors below still apply, so a product cannot mark a value
     *  settled that has no origin on file. */
    standing?: ProvenanceStanding;
}
/** The standing a bare confidence maps to under a policy. */
export declare function standingFromConfidence(confidence: number, policy?: ProvenanceConfidencePolicy): ProvenanceStanding;
/** Something missing that the reader has to be TOLD about, because the value
 *  renders either way and a bare number reads as a fact. */
export type ProvenanceGapKind = 'no-source' | 'no-inputs' | 'unavailable-source';
/** One stated gap. `message` is rendered verbatim. */
export interface ProvenanceGap {
    kind: ProvenanceGapKind;
    message: string;
    /** The source that could not be resolved (`unavailable-source` only). */
    source?: ProvenanceSource;
}
/** The sentence for a source that is not `ready`, or `null` when it is. One
 *  source of this copy, so the row and the gap list never disagree. */
export declare function describeProvenanceSourceStatus(source: ProvenanceSource): string | null;
/**
 * What this record cannot show, at its own level. Inputs are not walked: every
 * composed input renders its own gaps next to its own value, where a reader can
 * act on them.
 */
export declare function provenanceGaps(record: ProvenanceRecord): ProvenanceGap[];
/** The sources still resolving — rendered as their own state, never as an
 *  absence. A load in flight is not a missing source. */
export declare function loadingProvenanceSources(record: ProvenanceRecord): ProvenanceSource[];
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
export declare function resolveProvenanceStanding(record: ProvenanceRecord, policy?: ProvenanceConfidencePolicy): ProvenanceStanding;
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
export declare function rollUpProvenanceStanding(record: ProvenanceRecord, policy?: ProvenanceConfidencePolicy, seen?: Set<ProvenanceRecord>): ProvenanceStanding;
/**
 * One plain sentence naming where the value came from — the panel's first line
 * and part of what a screen reader announces. It states the absence when there
 * is one, so no code path produces silence.
 */
export declare function describeProvenance(record: ProvenanceRecord): string;
/**
 * The move THIS value's reader can actually make.
 *
 * `provenanceStandingMeta().action` is the generic sentence for a standing;
 * this is the one that accounts for what is on file. "Open the source and
 * confirm it" is a dead instruction on a value that has no source — an action
 * a reader cannot perform is the same defect as no action at all.
 */
export declare function provenanceNextMove(record: ProvenanceRecord, standing: ProvenanceStanding, policy?: ProvenanceConfidencePolicy): string;
/**
 * The accessible name of the disclosure control: the value, how it came to
 * exist, and — unless there is nothing to do — the next move. This is the
 * whole affordance for someone who never sees the colour.
 */
export declare function provenanceTriggerLabel(record: ProvenanceRecord, standing: ProvenanceStanding): string;
