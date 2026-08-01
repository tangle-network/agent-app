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

/**
 * Which identity the bearer is bound to.
 *
 * `'userId'` (default) is right when the product mints a token per user and can
 * deliver it per turn.
 *
 * `'workspaceId'` is the only workable choice when the token has to survive in
 * the BOX ENVIRONMENT. Since agent-interface 0.38 a credential may reach a
 * profile only as a reference the sandbox resolves from that environment, and
 * the environment is workspace-wide and written once at box creation. A
 * per-user token therefore cannot be delivered at all — and a per-user token
 * that IS written there was never per-user in any meaningful sense, because
 * every member of that workspace's box can read it.
 *
 * Binding the bearer to the workspace does NOT collapse the identity: the user
 * header is still required, still server-set, still returned on `ctx`, and is
 * what downstream domain code attributes work to. Only the question "may this
 * caller act at all" moves from the user to the workspace — which is what the
 * shared box already implies.
 */
export type CapabilitySubject = 'userId' | 'workspaceId'

/** Define options to verify bearer tokens and customize authentication header names */
export interface AuthenticateOptions {
  /** Verify the bearer capability token belongs to the subject named by
   *  {@link AuthenticateOptions.subject}. The product's HMAC/JWT impl — the
   *  seam that keeps token crypto out of this package. */
  verifyToken: (subject: string, bearer: string) => Promise<boolean>
  headerNames?: ToolHeaderNames
  /** What the bearer is bound to. Defaults to `'userId'`, so an existing caller
   *  is byte-unchanged. */
  subject?: CapabilitySubject
}

/** Represent the result of tool authentication with success context or failure response */
export type ToolAuthResult =
  | { ok: true; ctx: AppToolContext }
  | { ok: false; response: Response }

/**
 * Recover + verify the trusted context for a tool request.
 *
 * Both the user and the workspace come from server-set headers — never from
 * tool args — so the model can neither forge identity nor target another
 * workspace. The bearer must verify against whichever of the two the product
 * declares as its {@link CapabilitySubject}.
 *
 * Fail-closed, and deliberately in this order: a missing credential or a token
 * minted for another subject yields 401 before anything else is read. When the
 * subject is the workspace, its header is required BEFORE verification rather
 * than after — verifying against an absent subject is not a check at all.
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
  const subject = opts.subject === 'workspaceId' ? workspaceId : userId
  if (!subject) {
    return { ok: false, response: Response.json({ error: 'Missing workspace context' }, { status: 400 }) }
  }
  if (!(await opts.verifyToken(subject, bearer))) {
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
