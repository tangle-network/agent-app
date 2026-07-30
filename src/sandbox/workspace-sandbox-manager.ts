/** Define the shape of a workspace sandbox instance including its connection details and status. */
export interface WorkspaceSandboxInstanceLike {
  id: string
  name?: string
  status?: string
  connection?: {
    runtimeUrl?: string
    sidecarUrl?: string
    authToken?: string
    sidecarToken?: string
    authTokenExpiresAt?: string
  } | null
}

/** Define the context containing workspace and user identifiers for sandbox environment operations. */
export interface WorkspaceSandboxEnsureContext {
  workspaceId: string
  userId: string
}

/** Define configuration options for managing workspace sandboxes. */
export interface WorkspaceSandboxManagerOptions<TClient, TBox extends WorkspaceSandboxInstanceLike, TEnsureOptions = void> {
  getClient: (ctx: WorkspaceSandboxEnsureContext) => Promise<TClient> | TClient
  nameForWorkspace: (workspaceId: string, ctx: WorkspaceSandboxEnsureContext) => string
  listSandboxes: (client: TClient, ctx: WorkspaceSandboxEnsureContext) => Promise<TBox[]>
  createSandbox: (args: {
    client: TClient
    ctx: WorkspaceSandboxEnsureContext
    name: string
    options: TEnsureOptions
    listError?: unknown
  }) => Promise<TBox>
  waitForRunning?: (box: TBox, ctx: WorkspaceSandboxEnsureContext) => Promise<void>
  prepareExisting?: (box: TBox, ctx: WorkspaceSandboxEnsureContext, options: TEnsureOptions) => Promise<TBox | void>
  prepareCreated?: (box: TBox, ctx: WorkspaceSandboxEnsureContext, options: TEnsureOptions) => Promise<TBox | void>
  onListError?: (error: unknown, ctx: WorkspaceSandboxEnsureContext) => void
}

/** Manage workspace sandboxes by ensuring their creation and retrieval for specified users. */
export interface WorkspaceSandboxManager<TBox extends WorkspaceSandboxInstanceLike, TEnsureOptions = void> {
  ensureWorkspaceSandbox: (
    workspaceId: string,
    userId: string,
    options?: TEnsureOptions,
  ) => Promise<TBox>
}

/**
 * Create a generic name-keyed sandbox lifecycle manager for products that
 * drive their own SDK or box types.
 */
export function createWorkspaceSandboxManager<TClient, TBox extends WorkspaceSandboxInstanceLike, TEnsureOptions = void>(
  opts: WorkspaceSandboxManagerOptions<TClient, TBox, TEnsureOptions>,
): WorkspaceSandboxManager<TBox, TEnsureOptions> {
  return {
    async ensureWorkspaceSandbox(workspaceId, userId, options) {
      if (!workspaceId) throw new Error('workspaceId is required')
      if (!userId) throw new Error('userId is required')
      const ctx = { workspaceId, userId }
      const client = await opts.getClient(ctx)
      const name = opts.nameForWorkspace(workspaceId, ctx)
      let listError: unknown
      let existing: TBox[] = []

      try {
        existing = await opts.listSandboxes(client, ctx)
      } catch (err) {
        listError = err
        opts.onListError?.(err, ctx)
      }

      const found = existing.find((box) => box.name === name)
      if (found) {
        return (await opts.prepareExisting?.(found, ctx, options as TEnsureOptions)) ?? found
      }

      const created = await opts.createSandbox({
        client,
        ctx,
        name,
        options: options as TEnsureOptions,
        listError,
      })
      await opts.waitForRunning?.(created, ctx)
      return (await opts.prepareCreated?.(created, ctx, options as TEnsureOptions)) ?? created
    },
  }
}
