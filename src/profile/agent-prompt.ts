/**
 * The product system-prompt renderer: one layout for every product agent.
 *
 *   identity                 who the agent is (product-owned, no heading)
 *   ## Operating contract    the shared, versioned rules (./operating-contract)
 *   ## Environment           facts about the machine and tools this turn has
 *   ## Tool conventions      product tool rules beyond the contract
 *   ## Skills                the task skill index (bodies stay mounted)
 *   ## Domain guidance       fixed product standards, then learned guidance
 *   ## Workspace context     the per-workspace overlay
 *
 * Products previously rendered this through agent-eval's `renderProfile` with a
 * hand-copied operating discipline, learned-guidance loader, and overlay. Two
 * defects came with the copies: an empty skill roster still rendered
 * `_No skills configured._` ahead of the product's real skill index, and an
 * empty learned-guidance section rendered a placeholder sentence. Empty
 * sections are omitted here instead.
 *
 * Learned guidance is the one section the self-improvement loop changes. The
 * loop renders a candidate by passing its body as `learnedGuidance`, so the
 * prompt it scores is byte-identical to the prompt production would render if
 * that candidate were promoted.
 */

import { assertSystemPromptWithinBudget, type ComposeProfileBudget } from './budget'
import {
  renderOperatingContract,
  type OperatingContractClauseId,
  type OperatingContractOptions,
} from './operating-contract'

/** Section id of the evolvable learned guidance, shared by every product and its loop. */
export const LEARNED_GUIDANCE_SECTION_ID = 'learned-guidance'

/** A titled prompt section a product supplies. */
export interface AgentPromptSection {
  id: string
  title: string
  body: string
}

/** Inputs to {@link renderAgentPrompt}. */
export interface AgentPromptInput {
  /** Who the agent is and what it is for. Rendered first, without a heading. */
  identity: string
  /** Product adjustments to the shared operating contract, which always renders. */
  contract?: OperatingContractOptions
  /** Facts about the machine and tools this turn runs with. Pass the lane the
   *  turn actually executes on; a sandbox description on a lane without one
   *  sends the model after tools it does not have. */
  environment: string
  /** Product tool rules beyond the shared contract. Omitted when empty. */
  toolConventions?: string
  /** The task skill index, normally `composeSkillsForHarness(...).promptSection`.
   *  A `## Skills` heading is added when the index has none. Omitted when empty. */
  skillIndex?: string
  /** Fixed product standards, rendered in order under `## Domain guidance`. */
  standards?: readonly AgentPromptSection[]
  /** Deployed or candidate learned guidance. Raw file content is fine: HTML
   *  comments are stripped, and a body that is empty after stripping falls back
   *  to {@link learnedGuidanceBaseline}. */
  learnedGuidance?: string
  /** In-tree guidance used until the loop promotes a body. */
  learnedGuidanceBaseline?: string
  /** Per-workspace overlay: workspace configuration, custom instructions, and
   *  profile knowledge. Rendered last under `## Workspace context`; sections
   *  with empty bodies are dropped. */
  overlay?: readonly AgentPromptSection[]
  /** Byte budget, enforced only when supplied. Pass the product's ceiling when
   *  this render is the final system prompt; when later turn sections are
   *  appended, gate the final string with `assertSystemPromptWithinBudget`. */
  budget?: ComposeProfileBudget
}

/** One rendered section, in prompt order. */
export interface RenderedAgentPromptSection {
  /** `identity`, `operating-contract`, `environment`, `tool-conventions`,
   *  `skills`, a standard's id, {@link LEARNED_GUIDANCE_SECTION_ID}, or an
   *  overlay section's id. */
  id: string
  title: string
  /** Exact text this section contributes, including its heading. */
  text: string
  bytes: number
}

export interface RenderedAgentPrompt {
  /** Sections joined with a blank line. */
  prompt: string
  bytes: number
  contractVersion: number
  /** Shared contract clauses this prompt carries. */
  contractClauseIds: OperatingContractClauseId[]
  sections: RenderedAgentPromptSection[]
}

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/** Body of a loaded markdown file with HTML comments removed and whitespace
 *  trimmed, so an all-comment placeholder counts as empty. */
export function stripComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim()
}

/** Render the product system prompt. Throws on duplicate section ids, an empty
 *  identity or environment, or a prompt over a supplied budget. */
export function renderAgentPrompt(input: AgentPromptInput): RenderedAgentPrompt {
  const identity = input.identity.trim()
  if (!identity) throw new Error('renderAgentPrompt: identity is empty')
  const environment = input.environment.trim()
  if (!environment) throw new Error('renderAgentPrompt: environment is empty')

  const contract = renderOperatingContract(input.contract)
  const sections: Array<Omit<RenderedAgentPromptSection, 'bytes'>> = [
    { id: 'identity', title: 'Identity', text: identity },
    { id: 'operating-contract', title: 'Operating contract', text: contract.text },
    { id: 'environment', title: 'Environment', text: `## Environment\n\n${environment}` },
  ]

  const toolConventions = input.toolConventions?.trim()
  if (toolConventions) {
    sections.push({ id: 'tool-conventions', title: 'Tool conventions', text: `## Tool conventions\n\n${toolConventions}` })
  }

  const skillIndex = input.skillIndex?.trim()
  if (skillIndex) {
    sections.push({ id: 'skills', title: 'Skills', text: skillIndex.startsWith('#') ? skillIndex : `## Skills\n\n${skillIndex}` })
  }

  const learned = stripComments(input.learnedGuidance ?? '') || stripComments(input.learnedGuidanceBaseline ?? '')
  const domain = [
    ...(input.standards ?? []),
    ...(learned ? [{ id: LEARNED_GUIDANCE_SECTION_ID, title: 'Learned guidance', body: learned }] : []),
  ]
  sections.push(...headedGroup('Domain guidance', domain))
  sections.push(...headedGroup('Workspace context', input.overlay ?? []))

  const seen = new Set<string>()
  for (const section of sections) {
    if (seen.has(section.id)) throw new Error(`renderAgentPrompt: duplicate section id "${section.id}"`)
    seen.add(section.id)
  }

  const prompt = sections.map((section) => section.text).join('\n\n')
  if (input.budget) assertSystemPromptWithinBudget(prompt, input.budget, 'rendered agent prompt')
  return {
    prompt,
    bytes: byteLength(prompt),
    contractVersion: contract.version,
    contractClauseIds: contract.clauseIds,
    sections: sections.map((section) => ({ ...section, bytes: byteLength(section.text) })),
  }
}

/** Render titled sections as `### title` blocks under one `## heading`, which
 *  is attributed to the first section. Empty bodies are dropped; an empty group
 *  renders nothing. */
function headedGroup(
  heading: string,
  group: readonly AgentPromptSection[],
): Array<Omit<RenderedAgentPromptSection, 'bytes'>> {
  return group
    .map((section) => ({ ...section, body: section.body.trim() }))
    .filter((section) => section.body.length > 0)
    .map((section, index) => ({
      id: section.id,
      title: section.title,
      text: `${index === 0 ? `## ${heading}\n\n` : ''}### ${section.title}\n\n${section.body}`,
    }))
}
