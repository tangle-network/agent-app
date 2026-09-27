import { type ToolHeaderNames } from './auth';
import { type DispatchOptions } from './dispatch';
import { type AppToolName } from './openai';
import type { AppToolDefinition } from './registry';
/** Define options for handling tool requests including tool identification and token verification */
export interface HandleToolRequestOptions extends DispatchOptions {
    /** Which app tool this route serves — a built-in name or a product-registered
     *  {@link AppToolDefinition} (auto-added to `customTools` for dispatch). */
    tool: AppToolName | AppToolDefinition;
    /** Verify the bearer capability token belongs to the header user. */
    verifyToken: (userId: string, bearer: string) => Promise<boolean>;
    headerNames?: ToolHeaderNames;
    /** Optional model-facing description used by the MCP tools/list response. */
    description?: string;
    /** Product-specific values for the schedule_followup.priority schema. */
    priorityValues?: readonly string[];
    /** Optional success-message builder for a friendlier tool result. */
    message?: (result: unknown) => string;
}
/**
 * Handle one app-tool HTTP request end to end — the sandbox MCP path. The
 * agent's per-turn HTTP MCP server POSTs here; this authenticates (header user
 * + capability token), reads the args (MCP-alias tolerant), dispatches to the
 * product handler, and returns a JSON Response. A product's route file becomes
 * a one-liner: `export const action = ({ request }) => handleAppToolRequest(request, cfg)`.
 */
export declare function handleAppToolRequest(request: Request, opts: HandleToolRequestOptions): Promise<Response>;
