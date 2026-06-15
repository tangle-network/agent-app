/**
 * System-prompt assembler for agent products.
 *
 * Every agent product composes its system prompt the same way: a base profile
 * prompt (the operator persona + tools block + any skills section the consumer
 * already rendered), an always-on operating directive, then an ordered list of
 * optional per-turn context sections (known-context, board, approval history,
 * learned-style, pending questions, the active artifact). The ORDERING and the
 * whitespace contract are identical across products; only the section BODIES are
 * domain. This module owns the ordering and the joins; the product injects every
 * body as an already-rendered string through the `sections` array.
 *
 * Whitespace contract (preserves the join/concat/trim algebra of the per-product
 * pre-lift composers — a product adopting this asserts byte-for-byte parity in
 * its own suite):
 *   - base is emitted verbatim, with no leading/trailing normalization.
 *   - directive is appended after base with a single `\n\n` join.
 *   - each section in `sections` is appended with NO separator: a section is
 *     either '' (absent — contributes nothing) or already carries its own
 *     leading `\n\n` (and its `## ` heading). The assembler concatenates them
 *     unconditionally, which is why the conditional-prefix-or-empty contract
 *     lives in the product's section renderers, not here.
 *   - `trim` (default false) applies a final `.trim()` to the whole result.
 *     Branches that historically trimmed pass `trim: true`; branches that did
 *     not (e.g. the new-workspace paths) leave it false, preserving that
 *     asymmetry rather than silently changing trailing whitespace.
 *
 * Pure string composition: no SDK runtime symbol, no node builtins, no glob.
 * The base profile prompt and the skills-section insertion point both live
 * INSIDE the product-built `base` string — the assembler never reaches into an
 * AgentProfile and never loads a corpus. The sibling
 * `@tangle-network/agent-app/skills` subpath loads the corpus and returns file
 * mounts (`AgentProfileFileMount[]`); the PRODUCT renders any `## Skills` text
 * section and folds it into `base` before calling this assembler. This module
 * never renders a skills heading.
 */

/** Inputs to {@link assembleSystemPrompt}. */
export interface AssembleSystemPromptInput {
  /** The product's already-composed base block: persona/system prompt + tools
   *  block + (optionally) the rendered skills section. The product is
   *  responsible for resolving its profile system prompt and failing loud if it
   *  is absent — an empty base reaches this assembler only as a programmer
   *  error, which it rejects (see {@link AssembleResult}). */
  base: string
  /** The always-on operating directive, placed immediately after base with a
   *  `\n\n` join. Pass '' to omit it (the join is then suppressed). */
  directive?: string
  /** Ordered per-turn context sections, each already rendered by the product to
   *  either '' (absent) or a `\n\n## …`-prefixed string. Concatenated in order
   *  with no added separator. */
  sections?: string[]
  /** Apply a final `.trim()` to the composed result. Default false — set true
   *  only on branches whose pre-lift output was trimmed. */
  trim?: boolean
}

/** Typed outcome of {@link assembleSystemPrompt}. `succeeded: false` is returned
 *  for a programmer error (an empty base) rather than emitting a roleless
 *  prompt — callers MUST inspect `succeeded` before using `prompt`. */
export type AssembleResult =
  | { succeeded: true; prompt: string }
  | { succeeded: false; error: string }

/** True when a string is empty or whitespace-only. */
function isBlank(value: string): boolean {
  return value.trim().length === 0
}

/**
 * Assemble a system prompt from a base block, an operating directive, and an
 * ordered list of pre-rendered context sections.
 *
 * Returns a typed outcome: an empty/blank `base` is a defect (an agent with no
 * persona/system prompt), so it fails loud instead of silently producing a
 * prompt with no role. The product resolves and validates its profile prompt
 * upstream; this is the last-line guard at the seam.
 */
export function assembleSystemPrompt(input: AssembleSystemPromptInput): AssembleResult {
  const { base, directive = '', sections = [], trim = false } = input

  if (isBlank(base)) {
    return {
      succeeded: false,
      error: 'assembleSystemPrompt: base is empty — a system prompt with no persona/base block is a defect, not a default',
    }
  }

  let prompt = directive.length > 0 ? `${base}\n\n${directive}` : base
  for (const section of sections) prompt += section

  return { succeeded: true, prompt: trim ? prompt.trim() : prompt }
}