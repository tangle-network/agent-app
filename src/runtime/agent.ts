/** Prompt and explicitly authorized tools resolved by the application for one turn.
 * Certified delivery composes prompt-compatible guidance only; it preserves
 * these tool definitions without granting new execution authority. Full-profile
 * files, MCP servers and credentials belong to the existing provisioning and
 * authorization seams, not this prompt-composition contract.
 */
export interface ResolvedAgentProfile {
  systemPrompt: string
  extraTools: unknown[]
}
