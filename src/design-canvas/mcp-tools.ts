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

import type { McpToolDefinition } from '../tools/mcp-rpc'
import type { DesignCanvasMcpToolEnv } from './mcp-context'
import { CANVAS_READ_TOOLS } from './mcp-read-tools'
import { CANVAS_ELEMENTS_TOOLS } from './mcp-elements-tools'
import { CANVAS_PAGES_TOOLS } from './mcp-pages-tools'
import { CANVAS_TEMPLATES_TOOLS } from './mcp-templates-tools'

export type { DesignCanvasMcpToolEnv } from './mcp-context'

export const CANVAS_MCP_TOOLS: McpToolDefinition<DesignCanvasMcpToolEnv>[] = [
  ...CANVAS_READ_TOOLS,
  ...CANVAS_ELEMENTS_TOOLS,
  ...CANVAS_PAGES_TOOLS,
  ...CANVAS_TEMPLATES_TOOLS,
]
