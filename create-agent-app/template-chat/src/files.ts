import { createSandboxFileIndexRoute } from '@tangle-network/agent-app/chat-routes'
import { peekWorkspaceSandbox } from '@tangle-network/agent-app/sandbox'
import type { ChatApp } from './chat'
import type { AppEnv } from './env'
import { createSandboxShell } from './sandbox'

/** Only explicitly published artifacts are indexed, not configuration or private workspace files. */
export const ARTIFACT_ROOT = '/home/agent/artifacts'

export function createArtifactIndex(
  env: AppEnv,
  app: ChatApp,
  peek: typeof peekWorkspaceSandbox = peekWorkspaceSandbox,
) {
  return createSandboxFileIndexRoute({
    authorize: async ({ request }) => {
      const session = await app.auth.getSession(request)
      if (!session) return { status: 'denied', response: Response.json({ error: 'Unauthorized' }, { status: 401 }) }
      const userId = session.user.id
      const requestedWorkspace = new URL(request.url).searchParams.get('workspaceId')
      if (requestedWorkspace !== null && requestedWorkspace !== userId) {
        return { status: 'denied', response: Response.json({ error: 'Not found' }, { status: 404 }) }
      }
      const found = await peek(createSandboxShell(env), { workspaceId: userId, userId })
      if (found.status !== 'running') return { status: 'warming' }
      return { status: 'ready', fs: found.box.fs, root: ARTIFACT_ROOT }
    },
    maxEntries: 1000,
  })
}
