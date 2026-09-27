/**
 * Design-canvas MCP tool registry — what the in-sandbox agent sees over the
 * live agent→canvas channel. Each entry carries an LLM-facing description, a
 * JSON Schema for the arguments, and the typed dispatch that validates the
 * resulting operations, applies them through the store, and records ONE
 * decision row per mutating call.
 *
 * Every mutation: validate → apply via storeApplyScenePlan → recordDecision.
 * Throws anywhere become isError results the model reads to correct its call.
 *
 * Convenience sugar tools (add_text, move_element, etc.) expand to the
 * underlying operation primitives before reaching the kernel — no separate
 * code path to drift.
 */
import type { SceneStore } from './store';
import type { McpToolDefinition } from '../tools/mcp-rpc';
/** Define the environment for MCP tool with a scene store and ID minting function */
export interface DesignCanvasMcpToolEnv {
    store: SceneStore;
    mintId: () => string;
}
/** Provide a collection of MCP tool definitions for manipulating and querying the design canvas environment */
declare const CANVAS_MCP_TOOLS: McpToolDefinition<DesignCanvasMcpToolEnv>[];
export { CANVAS_MCP_TOOLS };
/** Find the canvas MCP tool definition matching the given name or return undefined */
export declare function findCanvasMcpTool(name: string): McpToolDefinition<DesignCanvasMcpToolEnv> | undefined;
/** Extract names of all tools from the CANVAS_MCP_TOOLS array */
export declare const CANVAS_MCP_TOOL_NAMES: string[];
/** Provide a readonly array of string identifiers representing canvas element kinds */
export declare const CANVAS_ELEMENT_KINDS: readonly string[];
