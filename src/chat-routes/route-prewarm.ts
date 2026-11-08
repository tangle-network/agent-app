/** Prewarm inherits thread-read authority; only a product's `prewarm: 'box'` spends, under `waitUntil` so a canceled request keeps no claim. */
import { createWorkspacePrewarmRoute } from '../sandbox/prewarm-route'
import { turnStorageBindings } from './route-storage'
import type { ChatTurnRequestContext, CreateChatTurnRoutesOptions } from './turn-route-contracts'

export function createChatPrewarm<TContext, TResource>(options: CreateChatTurnRoutesOptions<TContext, TResource>, box?: (scope: { workspaceId: string; userId: string }) => Promise<unknown>) {
  if (options.prewarm === false) return async () => new Response(null, { status: 405 })
  const bindings = options.turnLock === false ? undefined : turnStorageBindings(options)
  const route = createWorkspacePrewarmRoute<ChatTurnRequestContext | undefined>({
    turnStore: bindings,
    authorize: async ({ request, context, threadId }) => {
      const auth = await options.authorize({ request, intent: 'running', threadId })
      if (!auth.ok) return { status: 'denied', response: auth.response }
      if (auth.intent !== undefined && auth.intent !== 'running') return { status: 'denied',
        response: Response.json({ error: 'Authorization did not allow this read.', code: 'chat_authorization_intent_mismatch' }, { status: 403 }) }
      if (!bindings) return { status: 'declined', reason: 'lock_not_configured' }
      if (options.prewarm === 'box' && box) context?.waitUntil?.(box({ workspaceId: auth.tenantId, userId: auth.userId }))
      return { status: 'allowed', workspaceId: auth.tenantId, steps: [] }
    },
  })
  return (request: Request, ctx?: ChatTurnRequestContext) => route(request, ctx)
}
