/** Shared D1 replay and authenticated thread locks from the application's bindings. */
import { createD1TurnEventStore, type TurnEventStore, type D1LikeForTurns } from '../stream/turn-buffer'
import { createDurableTurnLock, type TurnStreamNamespaceLike, type TurnStreamAuth, type TurnStreamLocationHint } from '../turn-stream/adapters'
import type { CreateChatTurnRoutesOptions } from './turn-route-contracts'

/** One application binding descriptor, shared by chat admission and workspace prewarm. */
export interface ChatTurnStoreBindings {
  db: D1LikeForTurns
  /** The app's D1 region, also used as the placement hint for new lock channels. Default: enam. */
  region?: TurnStreamLocationHint
  lock: { namespace: TurnStreamNamespaceLike; auth: TurnStreamAuth }
}

/** Keep the workspace-channel identity, authentication and region the same in both routes. */
export function createDefaultTurnLock<TContext>(store: ChatTurnStoreBindings) {
  return createDurableTurnLock<TContext>({ ...store.lock, locationHint: store.region, scopeOf: () => 'thread' })
}

export type ResolvedChatTurnRoutesOptions<TContext, TResource = unknown> = Omit<CreateChatTurnRoutesOptions<TContext, TResource>, 'turnStore'> & {
  turnStore: TurnEventStore
}

export function resolveTurnStorage<TContext, TResource>(options: CreateChatTurnRoutesOptions<TContext, TResource>): ResolvedChatTurnRoutesOptions<TContext, TResource> {
  const store = options.turnStore
  // A custom store may expose its own database; its existing capabilities win.
  if ('append' in store) return { ...options, turnStore: store }
  return {
    ...options,
    turnStore: createD1TurnEventStore(store.db),
    turnLock: options.turnLock ?? createDefaultTurnLock<TContext>(store),
  }
}
