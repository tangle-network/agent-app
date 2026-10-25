/**
 * Access to a thread follows its workspace: the caller needs the role on the
 * workspace the thread itself names, so a forged thread id from another
 * workspace answers 404, never rows. A missing thread and a denied workspace
 * answer the same 404 so neither reveals the other exists.
 */
import type { WorkspaceRole } from './roles'

export interface ThreadAccessOptions<Role extends string = WorkspaceRole> {
  /** The workspace a thread belongs to, or null when no such thread exists. */
  findThreadWorkspace(threadId: string): Promise<string | null>
  /** The product's workspace check; it throws (any error) to deny. */
  requireWorkspaceAccess(workspaceId: string, userId: string, role: Role): Promise<unknown>
}

/**
 * Bind the thread check to a product's thread table and workspace access.
 * The returned check answers the thread's workspace id, or the Response the
 * route returns: 400 for a missing id, 404 for an unknown or denied thread.
 */
export function createThreadAccessCheck<Role extends string = WorkspaceRole>(options: ThreadAccessOptions<Role>) {
  return async function requireThreadAccess(
    threadId: string | undefined,
    userId: string,
    role: Role,
  ): Promise<{ workspaceId: string } | Response> {
    if (!threadId) return Response.json({ error: 'Missing threadId' }, { status: 400 })
    const workspaceId = await options.findThreadWorkspace(threadId)
    if (!workspaceId) return Response.json({ error: 'Thread not found' }, { status: 404 })
    try {
      await options.requireWorkspaceAccess(workspaceId, userId, role)
    } catch {
      return Response.json({ error: 'Thread not found' }, { status: 404 })
    }
    return { workspaceId }
  }
}
