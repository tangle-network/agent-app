/**
 * The composed-system-prompt byte budget, split out of `./index` so it imports
 * NOTHING.
 *
 * `./index` pulls `@tangle-network/agent-eval` (the evolvable-section seam), so
 * `/sandbox` — which has no agent-eval import and must not gain one — could not
 * enforce the budget from there. The gate is the same function either way; only
 * its module home moved. `./index` re-exports every symbol below, so the
 * published `/profile` surface is byte-identical.
 *
 * Why the gate belongs at more than one call site: `composeAgentProfile` is
 * OPT-IN. A product may hand-build its `AgentProfile`, and one does —
 * creative-agent's create-time profile is deliberately minimal and its full
 * system prompt rides the PER-TURN backend (`buildPromptBackend`), which never
 * touches the composer. `/sandbox` therefore runs this gate at the three points
 * where the profile that actually executes exists.
 */

/** Byte budget on the FINAL composed `prompt.systemPrompt`. Past this the
 *  model degrades sharply (a 122,659-byte prompt shipped once and the model
 *  returned empty answers), so the default gate throws well before that. */
export const DEFAULT_MAX_SYSTEM_PROMPT_BYTES = 40_000

/** Budget config for the composed system prompt. */
export interface ComposeProfileBudget {
  /** Byte cap on the composed `prompt.systemPrompt`.
   *  Default {@link DEFAULT_MAX_SYSTEM_PROMPT_BYTES}. */
  maxSystemPromptBytes?: number
  /** Downgrade the over-budget throw to a `console.warn` — the escape hatch
   *  for a product with a known-big prompt that must still ship (it yells on
   *  every compose instead of blocking). */
  warnOnly?: boolean
  /** Required to raise {@link maxSystemPromptBytes} above
   *  {@link DEFAULT_MAX_SYSTEM_PROMPT_BYTES} or to set {@link warnOnly}: a
   *  written reason naming what stays inline and why it cannot be mounted.
   *  Weakening the cap is a product decision that outlives the person making
   *  it, and the usual cause is reference material concatenated into the prompt
   *  that belongs in `resources.files`; demanding the sentence here keeps that
   *  from happening by accident. */
  overBudgetReason?: string
}

/** Reject a budget that weakens the cap without stating why. Runs before the
 *  size check so it fires on every compose, not only once a prompt has already
 *  grown past the raised ceiling. */
function assertBudgetPolicy(budget: ComposeProfileBudget): void {
  const raisedCap =
    budget.maxSystemPromptBytes !== undefined &&
    budget.maxSystemPromptBytes > DEFAULT_MAX_SYSTEM_PROMPT_BYTES
  if (!raisedCap && !budget.warnOnly) return
  if ((budget.overBudgetReason ?? '').trim() !== '') return
  const weakened = raisedCap
    ? `maxSystemPromptBytes ${budget.maxSystemPromptBytes} exceeds the ${DEFAULT_MAX_SYSTEM_PROMPT_BYTES}-byte default`
    : 'warnOnly downgrades the over-budget throw to a warning'
  throw new Error(
    `${weakened} without an overBudgetReason. Oversized system prompts degrade toward empty answers, so the cap is not a formality. ` +
      'Before raising it: rank the prompt with largestPromptSections() — reference material (playbooks, checklists, corpora) belongs in resources.files ' +
      "via corpusSkills()/userSkillMounts() or composeSkills({ mode: 'mounted' }), which puts the bodies on disk in the sandbox and leaves a short index in the prompt. " +
      'Only content the agent must obey without a tool call should stay inline. If the prompt is genuinely irreducible, set overBudgetReason to the sentence that says so.',
  )
}

/** Largest markdown-heading-delimited sections of a prompt, by UTF-8 bytes.
 *  Cheap heuristic: split on `#`-heading lines; the preamble before the first
 *  heading reports as "(preamble)". */
export function largestPromptSections(
  prompt: string,
  top = 3,
): Array<{ title: string; bytes: number }> {
  const encoder = new TextEncoder()
  const sections: Array<{ title: string; bytes: number }> = []
  let title = '(preamble)'
  let start = 0
  const flush = (end: number) => {
    const body = prompt.slice(start, end)
    if (body.trim()) sections.push({ title, bytes: encoder.encode(body).byteLength })
  }
  const headingRe = /^#{1,6}\s+(.+)$/gm
  for (const match of prompt.matchAll(headingRe)) {
    flush(match.index)
    title = (match[1] ?? '').trim() || '(untitled section)'
    start = match.index
  }
  flush(prompt.length)
  return sections.sort((a, b) => b.bytes - a.bytes).slice(0, top)
}

/** Enforce {@link ComposeProfileBudget} on a composed system prompt: over
 *  budget throws (or warns with `warnOnly`) with the actual size and the
 *  top-3 largest sections. Exported so a product assembling its prompt
 *  outside `composeAgentProfile` (e.g. via the `/prompt` assembler) can
 *  run the same gate at its own final-composition point. */
export function assertSystemPromptWithinBudget(
  systemPrompt: string,
  budget: ComposeProfileBudget = {},
  /** Prefixed to the message so a throw from a turn/provision choke point says
   *  WHERE it fired — "composed systemPrompt" alone reads like a compose-time
   *  error even when it fired on `driveSandboxTurn`. */
  origin = 'composed systemPrompt',
): void {
  assertBudgetPolicy(budget)
  const max = budget.maxSystemPromptBytes ?? DEFAULT_MAX_SYSTEM_PROMPT_BYTES
  const bytes = new TextEncoder().encode(systemPrompt).byteLength
  if (bytes <= max) return
  const sections = largestPromptSections(systemPrompt)
    .map((s) => `"${s.title}" (${s.bytes}B)`)
    .join(', ')
  const message =
    `${origin} is ${bytes} bytes — over the ${max}-byte budget ` +
    `(oversized prompts degrade to empty answers). ` +
    (sections ? `Largest sections: ${sections}. ` : '') +
    `Move reference material to resources.files (corpusSkills/userSkillMounts, or composeSkills({ mode: 'mounted' })) so the bodies land on disk in the sandbox ` +
    `and the prompt keeps only an index; keep inline only what the agent must obey without a tool call. Raising maxSystemPromptBytes requires an overBudgetReason.`
  if (budget.warnOnly) {
    console.warn(`[profile] ${message}`)
    return
  }
  throw new Error(message)
}

/** Run {@link assertSystemPromptWithinBudget} over a profile-shaped object's
 *  `prompt.systemPrompt`. Structural on purpose: `/sandbox` calls this on the
 *  SDK's `AgentProfile` and on the product-supplied seam result without either
 *  module importing the other's types. A profile with no string systemPrompt
 *  is a no-op — there is nothing to measure.
 *
 *  The `hint` exists because this gate can fire on a product that ALREADY made
 *  a deliberate budget decision somewhere else. gtm-agent composes with
 *  `{ maxSystemPromptBytes: 50_000 }`; without the hint, the shell's 40 KB
 *  default reads as the gate contradicting a choice the product already made
 *  rather than as "declare the same number here too". */
export function assertProfilePromptWithinBudget(
  profile: { prompt?: { systemPrompt?: unknown } } | undefined,
  budget: ComposeProfileBudget = {},
  origin = 'profile systemPrompt',
  hint = '',
): void {
  const systemPrompt = profile?.prompt?.systemPrompt
  if (typeof systemPrompt !== 'string') return
  try {
    assertSystemPromptWithinBudget(systemPrompt, budget, origin)
  } catch (err) {
    if (!hint) throw err
    throw new Error(`${(err as Error).message} ${hint}`, { cause: err })
  }
}
