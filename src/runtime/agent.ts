/**
 * The resolved per-turn profile surfaces a delivered / certified `AgentProfile`
 * can change.
 *
 * This file used to also carry `createAgentRuntime` — a factory that hand-wired
 * `resolveTangleModelConfig` + `buildAppToolOpenAITools` + `createOpenAICompatStreamTurn`
 * + `createAppToolRuntimeExecutor` + `runAppToolLoop` into one object. It shipped
 * for the whole life of the package and never acquired a consumer (0 references
 * across all nine repos on the fleet's default branches), while every product
 * that drives an in-process model turn composes those five directly or uses
 * `handleChatTurn`. It was removed in 0.44.0; compose the pieces, or see
 * `examples/browser-copilot.md` for the sandbox-free assembly.
 */

/** The agent's resolved profile surfaces for one turn — the things a delivered
 *  / certified `AgentProfile` can change. Profile-WIDE on purpose: certified
 *  delivery folds prompt-surface + skills into `systemPrompt` AND can add
 *  certified `tool` artifacts to `extraTools`. MCP servers / memory / RAG that
 *  materialize as files or servers deliver through the sandbox-provisioning
 *  seam, not here. */
export interface ResolvedAgentProfile {
  systemPrompt: string
  extraTools: unknown[]
}
