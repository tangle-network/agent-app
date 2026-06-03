import { authenticateToolRequest, type ToolHeaderNames } from './auth'
import { dispatchAppTool, outcomeStatus, type DispatchOptions } from './dispatch'
import type { AppToolName } from './openai'

export interface HandleToolRequestOptions extends DispatchOptions {
  /** Which app tool this route serves. */
  tool: AppToolName
  /** Verify the bearer capability token belongs to the header user. */
  verifyToken: (userId: string, bearer: string) => Promise<boolean>
  headerNames?: ToolHeaderNames
  /** Optional success-message builder for a friendlier tool result. */
  message?: (result: unknown) => string
}

/**
 * Handle one app-tool HTTP request end to end — the sandbox MCP path. The
 * agent's per-turn HTTP MCP server POSTs here; this authenticates (header user
 * + capability token), reads the args (MCP-alias tolerant), dispatches to the
 * product handler, and returns a JSON Response. A product's route file becomes
 * a one-liner: `export const action = ({ request }) => handleAppToolRequest(request, cfg)`.
 */
export async function handleAppToolRequest(request: Request, opts: HandleToolRequestOptions): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })

  const auth = await authenticateToolRequest(request, { verifyToken: opts.verifyToken, headerNames: opts.headerNames })
  if (!auth.ok) return auth.response

  let body: { args?: Record<string, unknown>; arguments?: Record<string, unknown> } & Record<string, unknown>
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const args = (body.args ?? body.arguments ?? body) as Record<string, unknown>

  const outcome = await dispatchAppTool(opts.tool, args, auth.ctx, opts)
  if (!outcome.ok) {
    return Response.json({ error: outcome.code, message: outcome.message }, { status: outcomeStatus(outcome) })
  }
  const payload = outcome.result as Record<string, unknown>
  return Response.json({ ok: true, ...payload, ...(opts.message ? { message: opts.message(outcome.result) } : {}) })
}
