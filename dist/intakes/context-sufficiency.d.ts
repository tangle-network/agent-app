/**
 * Pure context-sufficiency floor + conversational-gather scaffold — the
 * product-agnostic core of a CONVERSATIONAL intake. Where the question-graph
 * model (`./model`) runs a one-question-at-a-time interview, this leaf judges
 * whether an agent has gathered ENOUGH context to act, and renders the prompt
 * directive that tells the agent to fold the remaining gaps into its work
 * instead of running a form.
 *
 * Zero dependencies: no drizzle, no env, no react, no I/O, no product reads.
 * A product declares WHICH facts matter (`ContextFactSpec`), and its own
 * adapter resolves those facts + named substrate flags from whatever substrate
 * it owns (`ResolvedContextSignals`); this leaf only does the deterministic
 * combine and the wording. That separation is what makes the framework opt-in
 * and tree-shakeable, and what lets gtm/tax/legal/insurance share one core.
 *
 * Readiness is a two-part floor: SCOPE (every required fact has a value) AND
 * SUBSTRATE (at least one named substrate flag is true). Scope alone is not
 * enough — knowing the goal without any durable thing to act on is still
 * not-ready; substrate alone is not enough either. The product's adapter
 * decides what counts as a fact and what counts as substrate.
 */
/** One fact the product treats as known context once it has a value. */
export interface ContextFact {
    /** Stable key the resolved-signals map is keyed on. */
    key: string;
    /** Human label shown in the prompt's known/missing lists. */
    label: string;
    /** When true, this fact must have a value for SCOPE to be met. */
    required?: boolean;
    /** How the agent should gather this fact conversationally, if missing. */
    gatherHint?: string;
}
/**
 * The product's declaration of what context matters: the facts that make up
 * scope, plus optional tool hints appended verbatim to the gather prompt (e.g.
 * a product passes the command that extracts a brand from a URL). Pure data —
 * the product supplies labels, hints, and tool lines; the framework never
 * names a product-specific concept itself.
 */
export interface ContextFactSpec {
    facts: ContextFact[];
    /** Lines appended after the gather directive — e.g. product tool pointers. */
    toolHints?: string[];
}
/**
 * What a product's adapter resolves from its own substrate, ready to combine.
 * `facts` carries the resolved VALUE per fact key (undefined/empty = not
 * known); `substrate` carries named boolean flags (e.g.
 * `{ brandConfirmed, configHasContext, coreKnowledgePresent }`) — any one true
 * satisfies the substrate half of the floor.
 */
export interface ResolvedContextSignals {
    facts: Record<string, string | undefined>;
    substrate: Record<string, boolean>;
}
/** A resolved fact that has a value — surfaced to the prompt as known context. */
export interface KnownFact {
    key: string;
    label: string;
    value: string;
}
/** A required fact with no value — surfaced to the prompt as a gap to close. */
export interface MissingFact {
    key: string;
    label: string;
    gatherHint?: string;
}
/** The deterministic verdict over the resolved signals. */
export interface ContextSufficiency {
    /** True when the floor is met: `hasScope && hasSubstrate`. */
    ready: boolean;
    /** Every REQUIRED fact has a non-empty value. */
    hasScope: boolean;
    /** At least one named substrate flag is true. */
    hasSubstrate: boolean;
    /** Facts (required or not) that have a value. */
    knownFacts: KnownFact[];
    /** Required facts that have no value yet. */
    missingFacts: MissingFact[];
    /** The substrate flags as resolved, passed through for the prompt/caller. */
    substrate: Record<string, boolean>;
}
/**
 * Combine a fact spec with resolved signals into the readiness verdict. Pure,
 * deterministic, never throws — a missing fact key or an empty substrate map
 * reads as not-ready, not an error, so a fresh scope is honestly not-ready
 * rather than crashing the caller.
 *
 * SCOPE = every `required` fact resolves to a non-empty value.
 * SUBSTRATE = any value in `signals.substrate` is true.
 * READY = SCOPE && SUBSTRATE.
 *
 * `knownFacts` lists every fact (required or optional) that resolved to a
 * value, in spec declaration order; `missingFacts` lists every REQUIRED fact
 * that did not — optional facts never appear as missing because they never gate
 * scope.
 */
export declare function computeContextSufficiency(spec: ContextFactSpec, signals: ResolvedContextSignals): ContextSufficiency;
/**
 * Render the prompt section that mirrors a conversational-gather flow:
 *  - "### Context you already have" — the known facts, as `label: value`.
 *  - "### Context still missing — gather it while you work, not as a form" —
 *    the missing facts (with their gather hints), the act-first directive, and
 *    any product tool hints appended verbatim.
 *
 * When scope is met but the floor still is not (no substrate flag), it emits
 * the substrate directive instead of a missing-facts list. Returns '' when
 * there is nothing to say (no known facts, no gaps, and ready) so a caller can
 * concatenate it unconditionally. Pure: wording is product-neutral; every
 * product-specific phrase comes from the spec's labels, gather hints, and tool
 * hints.
 */
export declare function buildContextGatherPrompt(spec: ContextFactSpec, sufficiency: ContextSufficiency): string;
