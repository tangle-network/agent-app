/**
 * Capability gating — compose an agent session's tool surface from a
 * product-defined capability registry.
 *
 * Products that let users pick what an agent can do (a "Studio" agent with the
 * full build toolset vs a clean "Assistant" with none) all need the same
 * mechanics: a registry of named capabilities, each unlocking proposal types
 * and/or named tool groups, resolved against the product's
 * {@link AppToolTaxonomy} into the concrete tools to expose. The mechanics are
 * generic and live here; the capability VOCABULARY (ids, labels, which
 * proposal types, which tool groups) is the product's.
 */

import type { AppToolTaxonomy } from './types'

/** One toggleable tool group in a product's capability registry. */
export interface ToolCapability {
  id: string
  label: string
  description: string
  /** Proposal types this capability unlocks (intersected with the taxonomy,
   *  so a capability can never widen the product's proposal surface). */
  proposalTypes?: readonly string[]
  /** Unlocks every taxonomy proposal type beyond the base set — the domain's
   *  specialized long tail (risk_assessment, vuln_report, …). */
  domainActions?: boolean
  /** Named product tool groups (e.g. 'sandbox', 'integrations') this
   *  capability unlocks. The vocabulary is the product's; the resolver only
   *  unions them. */
  toolGroups?: readonly string[]
}

/** Resolve options for determining tool capabilities based on taxonomy, capabilities, and enabled IDs */
export interface ResolveToolCapabilitiesOptions {
  taxonomy: AppToolTaxonomy
  /** The product's full capability registry. */
  capabilities: readonly ToolCapability[]
  /** Enabled capability ids. `undefined` means full access (legacy callers
   *  that don't send a capability set); an explicit `[]` means a pure chat
   *  agent with no tools. Unknown ids are ignored. */
  enabled: readonly string[] | undefined
  /** The shared base proposal types `domainActions` excludes. Defaults to
   *  every type some capability names explicitly via `proposalTypes` — i.e.
   *  "domain actions" are the taxonomy types no capability claims. */
  baseProposalTypes?: readonly string[]
}

/** Describe resolved capabilities including proposal types and product tool groups to expose */
export interface ResolvedToolCapabilities {
  /** Proposal types to keep — feed to {@link restrictTaxonomy}. */
  proposalTypes: string[]
  /** Product tool groups to expose (deduped union across enabled caps). */
  toolGroups: string[]
}

/**
 * Resolve an enabled capability-id set against a taxonomy into the concrete
 * tool surface. Fail-closed: only types present in the taxonomy survive, and
 * an empty `enabled` set yields no tools at all.
 */
export function resolveToolCapabilities(
  opts: ResolveToolCapabilitiesOptions,
): ResolvedToolCapabilities {
  const { taxonomy, capabilities, enabled } = opts
  if (enabled === undefined) {
    return {
      proposalTypes: [...taxonomy.proposalTypes],
      toolGroups: [...new Set(capabilities.flatMap((c) => c.toolGroups ?? []))],
    }
  }
  const base = new Set(
    opts.baseProposalTypes ?? capabilities.flatMap((c) => c.proposalTypes ?? []),
  )
  const domainTypes = taxonomy.proposalTypes.filter((t) => !base.has(t))
  const byId = new Map(capabilities.map((c) => [c.id, c]))

  const proposalTypes = new Set<string>()
  const toolGroups = new Set<string>()
  for (const id of enabled) {
    const cap = byId.get(id)
    if (!cap) continue
    for (const t of cap.proposalTypes ?? []) {
      if (taxonomy.proposalTypes.includes(t)) proposalTypes.add(t)
    }
    if (cap.domainActions) for (const t of domainTypes) proposalTypes.add(t)
    for (const g of cap.toolGroups ?? []) toolGroups.add(g)
  }
  return { proposalTypes: [...proposalTypes], toolGroups: [...toolGroups] }
}

/**
 * Restrict a taxonomy to a subset of proposal types, intersecting the
 * regulated subset too — the regulated label survives restriction, so a
 * narrowed agent can never launder a regulated type into an unregulated one.
 */
export function restrictTaxonomy(
  taxonomy: AppToolTaxonomy,
  allowed: readonly string[],
): AppToolTaxonomy {
  const allow = new Set(allowed)
  return {
    proposalTypes: taxonomy.proposalTypes.filter((t) => allow.has(t)),
    regulatedTypes: taxonomy.regulatedTypes.filter((t) => allow.has(t)),
  }
}
