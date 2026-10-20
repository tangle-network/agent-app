/**
 * The agent-facing work-product side channel — three registry `customTools`
 * built on `/tools`' `defineAppTool`, dispatched through `dispatchAppTool`'s
 * single validation/outcome path (a thrown `ToolInputError` → correctable 4xx
 * back to the model; any other throw → internal error; a call never silently
 * succeeds without its effect). Deliberately NOT new `/tools` built-ins:
 * extending `AppToolHandlers` would break every existing consumer, and the
 * registry seam exists precisely for a product tool family like this.
 *
 * Partial-emission contract across a long turn: the draft ROW is the
 * accumulator. Evidence and exceptions stream in as found via small batched
 * calls; the artifact arrives once at the end. The agent addresses everything
 * by `scopeKey` — the server mints row ids, the model never invents them, and
 * identity (userId/workspaceId/threadId) rides the trusted `AppToolContext`
 * from headers, never model args. A turn that dies mid-emission leaves a
 * consistent draft the next turn resumes by the same scopeKey.
 */

import type { AppToolDefinition } from '../tools/registry'
import { buildDraftEmissionTools } from './draft-emission-tools'
import { createWorkProductService } from './service'
import { buildSubmissionTool } from './submission-tool'
import type { WorkProductToolConfig } from './tool-config'

export * from './tool-config'

/** Build the three work-product tools for `customTools` registration on the
 *  MCP server / HTTP handler / runtime executor. */
export function buildWorkProductTools(config: WorkProductToolConfig): AppToolDefinition[] {
  const service = createWorkProductService({
    store: config.store,
    ...(config.now ? { now: config.now } : {}),
    ...(config.generateId ? { generateId: config.generateId } : {}),
  })
  return [...buildDraftEmissionTools(config, service), buildSubmissionTool(config, service)]
}
