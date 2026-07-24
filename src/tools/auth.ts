import type { AppToolContext } from './types'

/**
 * Header names carrying the server-set per-turn context + the capability token.
 * Defaults are product-neutral (`X-Agent-App-*`); a product that already ships
 * a header convention (e.g. `X-Acme-User-Id`) passes its own.
 */
export interface ToolHeaderNames {
  userId: string
  workspaceId: string
  threadId: string
}

/** Provide default HTTP header names for user, workspace, and thread identification */
export const DEFAULT_HEADER_NAMES: ToolHeaderNames = {
  userId: 'X-Agent-App-User-Id',
  workspaceId: 'X-Agent-App-Workspace-Id',
  threadId: 'X-Agent-App-Thread-Id',
}

/** Define options to verify bearer tokens and customize authentication header names */
export interface AuthenticateOptions {
  /** Verify the bearer capability token belongs to `userId`. The product's
   *  HMAC/JWT impl — the seam that keeps token crypto out of this package. */
  verifyToken: (userId: string, bearer: string) => Promise<boolean>
  headerNames?: ToolHeaderNames
}

/** Represent the result of tool authentication with success context or failure response */
export type ToolAuthResult =
  | { ok: true; ctx: AppToolContext }
  | { ok: false; response: Response }

/**
 * Recover + verify the trusted context for a tool request. The user comes from
 * a server-set header and the bearer token MUST verify against THAT user; the
 * workspace comes from a header too — never from tool args — so the model can
 * neither forge identity nor target another workspace. Fail-closed: any missing
 * credential or a token minted for another user yields a 401/400 Response.
 */
export async function authenticateToolRequest(request: Request, opts: AuthenticateOptions): Promise<ToolAuthResult> {
  const h = opts.headerNames ?? DEFAULT_HEADER_NAMES
  const userId = request.headers.get(h.userId)?.trim()
  const workspaceId = request.headers.get(h.workspaceId)?.trim()
  const threadId = request.headers.get(h.threadId)?.trim() || null
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]

  if (!userId || !bearer) {
    return { ok: false, response: Response.json({ error: 'Missing capability credentials' }, { status: 401 }) }
  }
  if (!(await opts.verifyToken(userId, bearer))) {
    return { ok: false, response: Response.json({ error: 'Invalid capability token' }, { status: 401 }) }
  }
  if (!workspaceId) {
    return { ok: false, response: Response.json({ error: 'Missing workspace context' }, { status: 400 }) }
  }
  return { ok: true, ctx: { userId, workspaceId, threadId } }
}

/** Read a tool's argument object from the request body, tolerant of MCP host
 *  aliases (`args` / `arguments`) or a bare body. Returns null on non-JSON. */
export async function readToolArgs<T>(request: Request): Promise<T | null> {
  let body: { args?: T; arguments?: T }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return null
  }
  return (body.args ?? body.arguments ?? (body as T)) as T
}
