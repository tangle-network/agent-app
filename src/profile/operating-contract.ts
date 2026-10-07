/**
 * The shared operating contract: the rules every product agent follows whatever
 * its domain. Products used to hand-write these as "How you operate" bullets,
 * and the copies drifted apart (different labels for unsupported claims, a
 * read-back rule in one product and not the others). Rendering one contract
 * keeps them identical, and its version lets a receipt name the exact wording a
 * turn saw.
 *
 * Changing any clause text requires bumping {@link OPERATING_CONTRACT_VERSION};
 * the test suite pins the digest of each version's default rendering, so an
 * unversioned wording change fails there.
 */

/** Version of the clause wording below. Bump it whenever any clause text changes. */
export const OPERATING_CONTRACT_VERSION = 1

export type OperatingContractClauseId =
  | 'deliver'
  | 'evidence'
  | 'inspect-results'
  | 'authority'
  | 'this-turn'
  | 'read-back'
  | 'vault-memory'

export interface OperatingContractClause {
  id: OperatingContractClauseId
  text: string
}

/** Stands in for the product's unsupported-claim label inside the evidence clause. */
const UNVERIFIED_LABEL_SLOT = '{unverified}'

const DEFAULT_UNVERIFIED_LABEL = 'Unverified: <claim>'

/** The clauses in render order. */
export const OPERATING_CONTRACT_CLAUSES: readonly OperatingContractClause[] = Object.freeze([
  {
    id: 'deliver',
    text: 'Do the work instead of describing it. Produce the artifact the request needs, check it, and say what you checked. Done means produced and verified.',
  },
  {
    id: 'evidence',
    text: `Ground each material claim in a source you can name: a tool result, a file path, a document, or the user's own words. Keep what a source shows separate from what you infer. Mark a claim you cannot support with \`${UNVERIFIED_LABEL_SLOT}\` and name the lookup that would settle it. Never invent a source, quote, number, customer, or completed action.`,
  },
  {
    id: 'inspect-results',
    text: 'Tools, integrations, and delegated tasks can fail. Read each result before you rely on it or report it as done, and state a failure plainly.',
  },
  {
    id: 'authority',
    text: "Research, drafts, and workspace edits inside the request are yours to do. Sending, publishing, spending, contacting someone, or changing an integration needs the user's explicit approval for that target and content. A plan is not approval, a pending approval is not execution, and you never approve your own request.",
  },
  {
    id: 'this-turn',
    text: 'Promise only what this turn does. Do not offer to follow up, monitor, or remind later unless a tool confirmed it is scheduled; finish what you can now, then name what remains and what it needs.',
  },
  {
    id: 'read-back',
    text: 'After you save a file or record, confirm it from the save result or by reading it back before you call it saved, and refer to it by its workspace path.',
  },
  {
    id: 'vault-memory',
    text: 'Workspace files are your memory between turns. Read the relevant ones before you answer, and write decisions, evidence, and corrections back so the next turn starts from them.',
  },
])

/** Product adjustments to the shared contract. */
export interface OperatingContractOptions {
  /** Clauses that cannot apply on this lane, such as `vault-memory` and
   *  `read-back` on a lane with no workspace files. The rendered result lists
   *  the clauses kept, so a receipt shows what was left out. */
  omit?: readonly OperatingContractClauseId[]
  /** How the agent marks a claim it cannot support. Default
   *  `Unverified: <claim>`; a product with a mandated format passes it here
   *  instead of restating the evidence rule in its own words. */
  unverifiedLabel?: string
  /** Product clauses appended after the shared ones, one bullet each. */
  additions?: readonly string[]
}

export interface RenderedOperatingContract {
  version: number
  /** `## Operating contract` followed by one bullet per clause. */
  text: string
  /** Shared clauses kept, in render order. */
  clauseIds: OperatingContractClauseId[]
}

const CLAUSE_IDS = new Set<string>(OPERATING_CONTRACT_CLAUSES.map((clause) => clause.id))

/** Render the contract as a prompt section. Throws on an unknown `omit` id so a
 *  typo cannot silently keep a clause the product meant to drop. */
export function renderOperatingContract(options: OperatingContractOptions = {}): RenderedOperatingContract {
  const omit = new Set<string>(options.omit ?? [])
  const unknown = [...omit].filter((id) => !CLAUSE_IDS.has(id))
  if (unknown.length > 0) {
    throw new Error(`renderOperatingContract: unknown clause id(s) in omit: ${unknown.join(', ')}`)
  }
  const label = options.unverifiedLabel?.trim() || DEFAULT_UNVERIFIED_LABEL
  const kept = OPERATING_CONTRACT_CLAUSES.filter((clause) => !omit.has(clause.id))
  const bullets = [
    ...kept.map((clause) => clause.text.replace(UNVERIFIED_LABEL_SLOT, label)),
    ...(options.additions ?? []).map((text) => text.trim()).filter((text) => text.length > 0),
  ]
  return {
    version: OPERATING_CONTRACT_VERSION,
    text: `## Operating contract\n\n${bullets.map((bullet) => `- ${bullet}`).join('\n')}`,
    clauseIds: kept.map((clause) => clause.id),
  }
}
