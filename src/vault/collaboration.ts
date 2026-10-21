/**
 * Live co-editing of vault files: bootstrap, token refresh and snapshot
 * routes over the sandbox collaboration server. Each product supplies its
 * product id, how to read a vault file, and its own request auth and
 * workspace access lookup; the token policy and route contract live here once.
 */
import { createHash } from 'node:crypto'
import {
  buildCollaborationDocumentId,
  parseCollaborationDocumentId,
  type CollaborationBootstrapResponse,
  type CollaborationTokenRefreshResponse,
  type SaveCollaborationSnapshotResponse,
} from '@tangle-network/sandbox'
import { ProductTokenIssuer } from '@tangle-network/sandbox/auth'
import { workspaceRoleToCollaborationAccess, type WorkspaceRole } from '../teams/roles'

export type CollaborationAccess = 'read' | 'write'

export interface CollaborationViewer {
  id: string
  name?: string | null
  email?: string | null
}

/** The deployment settings collaboration needs, read from the worker env. */
export interface CollaborationEnv {
  COLLABORATION_SERVER_URL?: string
  ORCHESTRATOR_SIGNING_SECRET?: string
}

/** The vault file fields collaboration reads: `body` seeds the editor, and
 *  the full `content` (frontmatter included) versions the snapshot. */
export interface CollaborationVaultFile {
  body: string
  content: string
}

export type ReadCollaborationVaultFile = (
  workspaceId: string,
  relativePath: string,
) => Promise<CollaborationVaultFile>

function getCollaborationServerUrl(env: CollaborationEnv): string | null {
  const url = env.COLLABORATION_SERVER_URL?.trim()
  return url ? url.replace(/\/+$/, '') : null
}

export function isCollaborationConfigured(env: CollaborationEnv): boolean {
  return Boolean(env.ORCHESTRATOR_SIGNING_SECRET && getCollaborationServerUrl(env))
}

function createIssuer(productId: string, env: CollaborationEnv) {
  if (!env.ORCHESTRATOR_SIGNING_SECRET) {
    throw new Error('Missing ORCHESTRATOR_SIGNING_SECRET')
  }

  return new ProductTokenIssuer({
    productId,
    signingSecret: env.ORCHESTRATOR_SIGNING_SECRET,
    ttlMinutes: {
      free: 30,
      pro: 120,
      enterprise: 240,
    },
  })
}

function buildEditorSessionId(workspaceId: string, viewer: CollaborationViewer): string {
  return `collab:${workspaceId}:${viewer.id}`
}

function createSnapshotVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export async function buildVaultCollaborationBootstrap(params: {
  productId: string
  env: CollaborationEnv
  readFile: ReadCollaborationVaultFile
  workspaceId: string
  relativePath: string
  viewer: CollaborationViewer
  access?: CollaborationAccess
}): Promise<CollaborationBootstrapResponse> {
  const { productId, env, readFile, workspaceId, relativePath, viewer, access = 'read' } = params
  const websocketUrl = getCollaborationServerUrl(env)

  if (!websocketUrl) {
    throw new Error('Collaboration server is not configured')
  }

  const file = await readFile(workspaceId, relativePath)
  const documentId = buildCollaborationDocumentId({
    workspaceId,
    relativePath,
  })
  const { token, expiresAt } = createIssuer(productId, env).issueCollaboration({
    userId: viewer.id,
    sessionId: buildEditorSessionId(workspaceId, viewer),
    projectId: workspaceId,
    documentId,
    access,
    tier: 'pro',
  })

  return {
    documentId,
    transport: {
      websocketUrl,
      token,
      expiresAt,
    },
    permissions: {
      access,
      canSnapshot: access === 'write',
    },
    source: 'filesystem',
    initialContent: file.body,
    snapshotVersion: createSnapshotVersion(file.content),
  }
}

export function refreshVaultCollaborationToken(params: {
  productId: string
  env: CollaborationEnv
  workspaceId: string
  documentId: string
  viewer: CollaborationViewer
  access?: CollaborationAccess
}): CollaborationTokenRefreshResponse {
  const { productId, env, workspaceId, documentId, viewer, access = 'read' } = params
  const ref = parseCollaborationDocumentId(documentId)

  if (!ref || ref.workspaceId !== workspaceId) {
    throw new Error('Document does not belong to workspace')
  }

  const { token, expiresAt } = createIssuer(productId, env).issueCollaboration({
    userId: viewer.id,
    sessionId: buildEditorSessionId(workspaceId, viewer),
    projectId: workspaceId,
    documentId,
    access,
    tier: 'pro',
  })

  return {
    token,
    expiresAt,
    access,
  }
}

export async function saveVaultCollaborationSnapshot(params: {
  readFile: ReadCollaborationVaultFile
  workspaceId: string
  relativePath: string
  documentId: string
}): Promise<SaveCollaborationSnapshotResponse> {
  const { readFile, workspaceId, relativePath, documentId } = params
  const ref = parseCollaborationDocumentId(documentId)

  if (!ref || ref.workspaceId !== workspaceId || ref.relativePath !== relativePath) {
    throw new Error('Document does not match requested file')
  }

  const file = await readFile(workspaceId, relativePath)
  return {
    snapshotVersion: createSnapshotVersion(file.content),
    savedAt: new Date().toISOString(),
  }
}

/** The signed-in user a collaboration route acts for. */
export interface CollaborationSessionUser {
  id: string
  name?: string | null
  email?: string | null
}

export interface CollaborationWorkspaceAccess {
  workspace: { id: string }
  role: WorkspaceRole
}

export interface VaultCollaborationRoutesConfig<Context> {
  /** Product id the collaboration tokens are issued for. */
  productId: string
  /** Authenticate the request; throw the product's own 401 response. */
  requireUser: (request: Request) => Promise<{ user: CollaborationSessionUser }>
  /** Read the worker env from the route context. */
  resolveEnv: (context: Context) => CollaborationEnv
  /** Resolve the user's membership; `minRole` is the least role the route needs. */
  getWorkspaceAccess: (
    workspaceId: string,
    userId: string,
    minRole?: 'editor',
  ) => Promise<CollaborationWorkspaceAccess | null>
  readFile: ReadCollaborationVaultFile
}

interface CollaborationRouteArgs<Context> {
  request: Request
  context: Context
}

/**
 * The three collaboration route actions. Viewers get read-only sessions;
 * snapshots need editor access. A missing file answers 404 on bootstrap.
 */
export function createVaultCollaborationRoutes<Context>(config: VaultCollaborationRoutesConfig<Context>) {
  const { productId, readFile } = config

  async function admit({ request, context }: CollaborationRouteArgs<Context>) {
    const session = await config.requireUser(request)
    const env = config.resolveEnv(context)
    if (!isCollaborationConfigured(env)) {
      return Response.json(
        { error: 'Collaboration is not configured for this deployment' },
        { status: 503 },
      )
    }
    return { session, env }
  }

  function viewerOf(user: CollaborationSessionUser): CollaborationViewer {
    return { id: user.id, name: user.name, email: user.email }
  }

  async function bootstrap(args: CollaborationRouteArgs<Context>): Promise<Response> {
    const admitted = await admit(args)
    if (admitted instanceof Response) return admitted
    const { session, env } = admitted

    const body = await args.request.json() as {
      workspaceId?: string
      relativePath?: string
    }

    if (!body.workspaceId || !body.relativePath) {
      return Response.json({ error: 'Missing workspaceId or relativePath' }, { status: 400 })
    }

    const access = await config.getWorkspaceAccess(body.workspaceId, session.user.id)
    if (!access) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 })
    }

    try {
      const result = await buildVaultCollaborationBootstrap({
        productId,
        env,
        readFile,
        workspaceId: access.workspace.id,
        relativePath: body.relativePath,
        viewer: viewerOf(session.user),
        access: workspaceRoleToCollaborationAccess(access.role),
      })
      return Response.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to bootstrap collaboration'
      const status = message.includes('not found') ? 404 : 400
      return Response.json({ error: message }, { status })
    }
  }

  async function token(args: CollaborationRouteArgs<Context>): Promise<Response> {
    const admitted = await admit(args)
    if (admitted instanceof Response) return admitted
    const { session, env } = admitted

    const body = await args.request.json() as {
      workspaceId?: string
      documentId?: string
    }

    if (!body.workspaceId || !body.documentId) {
      return Response.json({ error: 'Missing workspaceId or documentId' }, { status: 400 })
    }

    const access = await config.getWorkspaceAccess(body.workspaceId, session.user.id)
    if (!access) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 })
    }

    try {
      const refreshed = refreshVaultCollaborationToken({
        productId,
        env,
        workspaceId: access.workspace.id,
        documentId: body.documentId,
        viewer: viewerOf(session.user),
        access: workspaceRoleToCollaborationAccess(access.role),
      })
      return Response.json(refreshed)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh collaboration token'
      return Response.json({ error: message }, { status: 400 })
    }
  }

  async function snapshot(args: CollaborationRouteArgs<Context>): Promise<Response> {
    const admitted = await admit(args)
    if (admitted instanceof Response) return admitted
    const { session } = admitted

    const body = await args.request.json() as {
      workspaceId?: string
      relativePath?: string
      documentId?: string
    }

    if (!body.workspaceId || !body.relativePath || !body.documentId) {
      return Response.json(
        { error: 'Missing workspaceId, relativePath, or documentId' },
        { status: 400 },
      )
    }

    const access = await config.getWorkspaceAccess(body.workspaceId, session.user.id, 'editor')
    if (!access) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 })
    }

    try {
      const saved = await saveVaultCollaborationSnapshot({
        readFile,
        workspaceId: access.workspace.id,
        relativePath: body.relativePath,
        documentId: body.documentId,
      })
      return Response.json(saved)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save collaboration snapshot'
      return Response.json({ error: message }, { status: 400 })
    }
  }

  return { bootstrap, token, snapshot }
}
