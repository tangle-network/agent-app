import type { AgentProfileMcpServer, AgentProfileResourceRef } from '@tangle-network/agent-interface/profile'

/**
 * Registry discovery port for the shared profile editor (agent-app#776).
 * The host authenticates and bounds every search server-side; the editor
 * never talks to a catalog directly. Discovery never implies trust,
 * authorization, or installation: choosing a result only adds the canonical
 * reference to the profile draft, and the product's own constraints
 * (pinned commits, HTTPS-only endpoints, unique names) still decide whether
 * the reference may be added.
 */

/** A skill offered by a maintained catalog. */
export interface AgentProfileRegistrySkill {
  /** Canonical skill name; the product's format and uniqueness rules still apply. */
  name: string
  /** What the skill is for, from the catalog. */
  description?: string
  /** Display name of the catalog that answered, for example `Tangle Network skills`. */
  catalog: string
  /** Permissions the skill declares, shown before the operator adds it. */
  permissions?: readonly string[]
  /** Canonical reference added to the profile when the operator chooses this skill. */
  ref: AgentProfileResourceRef
}

/** An MCP server offered by the official MCP Registry or a custom registry. */
export interface AgentProfileRegistryMcpServer {
  /** Canonical server name; existing profile entries win over duplicates. */
  name: string
  /** What the server provides, from the registry. */
  description?: string
  /** Display name of the registry that answered, for example `Official MCP Registry`. */
  catalog: string
  /** Canonical server entry added to the profile when the operator chooses it. */
  server: AgentProfileMcpServer
}

export interface AgentProfileRegistrySkillsResult {
  skills: readonly AgentProfileRegistrySkill[]
  /** Catalogs that could not answer; results from the remaining catalogs stay usable. */
  unavailable?: readonly string[]
}

export interface AgentProfileRegistryMcpResult {
  mcpServers: readonly AgentProfileRegistryMcpServer[]
  unavailable?: readonly string[]
}

/** Registry search failures the editor renders distinctly. */
export type AgentProfileRegistryFailure = 'authorization-required' | 'unavailable' | 'failed'

export class AgentProfileRegistryError extends Error {
  constructor(readonly kind: AgentProfileRegistryFailure, message: string) {
    super(message)
    this.name = 'AgentProfileRegistryError'
  }
}

/** Host-supplied registry search. Implementations must time out and never install anything. */
export interface AgentProfileRegistryPort {
  searchSkills(query: string, signal?: AbortSignal): Promise<AgentProfileRegistrySkillsResult>
  searchMcpServers(query: string, signal?: AbortSignal): Promise<AgentProfileRegistryMcpResult>
}
