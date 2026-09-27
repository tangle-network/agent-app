import type { AppToolTaxonomy, BuildAppToolsOptions } from './types';
/** The four canonical app-tool names. Stable identifiers the model calls in
 *  both the sandbox (MCP server name) and runtime (function-tool name) paths. */
export declare const APP_TOOL_NAMES: readonly ['submit_proposal', 'schedule_followup', 'render_ui', 'add_citation'];
/** Resolve a valid application tool name from the predefined list of tool names */
export type AppToolName = (typeof APP_TOOL_NAMES)[number];
/** Determine if a string matches a valid application tool name */
export declare function isAppToolName(name: string): name is AppToolName;
/** A minimal OpenAI Chat Completions function-tool shape — structurally
 *  compatible with `@tangle-network/agent-runtime`'s `OpenAIChatTool` without
 *  importing it (keeps this package runtime-free). */
export interface OpenAIFunctionTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
/**
 * Build the four app tools in OpenAI function-tool shape. `submit_proposal`'s
 * `type` enum is the product's {@link AppToolTaxonomy.proposalTypes}; the
 * model-facing descriptions and the follow-up priority enum default to the
 * Tangle reference vocabulary and can be retuned via {@link BuildAppToolsOptions}
 * (the tool names + JSON-Schema shapes stay fixed — they are mechanism). Pass
 * the result to the agent-runtime backend's `tools`.
 */
export declare function buildAppToolOpenAITools(taxonomy: AppToolTaxonomy, opts?: BuildAppToolsOptions): OpenAIFunctionTool[];
