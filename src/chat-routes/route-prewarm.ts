/** Prewarm inherits the existing thread-read authority; it never infers spend authority. */
import { createWorkspacePrewarmRoute } from '../sandbox/prewarm-route'
import { turnStorageBindings } from './route-storage'
import type { CreateChatTurnRoutesOptions } from './turn-route-contracts'

export function createChatPrewarm<TContext, TResource>(options: CreateChatTurnRoutesOptions<TContext, TResource>) {
  if (options.prewarm === false) return async () => new Response(null, { status: 405 })
  const bindings = options.turnLock === false ? undefined : turnStorageBindings(options)
  const route = createWorkspacePrewarmRoute({
    turnStore: bindings,
    authorize: async ({ request, threadId }) => {
      if (!threadId) return { status: 'declined', reason: 'thread_required' }
      const auth = await options.authorize({ request, intent: 'running', threadId })
      if (!auth.ok) return { status: 'denied', response: auth.response }
      if (auth.intent !== undefined && auth.intent !== 'running') return { status: 'denied',
        response: Response.json({ error: 'Authorization did not allow this read.', code: 'chat_authorization_intent_mismatch' }, { status: 403 }) }
      if (!bindings) return { status: 'declined', reason: 'lock_not_configured' }
      return { status: 'allowed', workspaceId: auth.tenantId, steps: [] }
    },
  })
  return (request: Request) => route(request, undefined)
}
