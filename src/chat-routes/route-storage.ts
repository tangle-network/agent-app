/** Shared D1 replay and authenticated thread locks from the application's bindings. */
import { createD1TurnEventStore, type TurnEventStore } from '../stream/turn-buffer'
import { createDurableTurnLock } from '../turn-stream/adapters'
import type { CreateChatTurnRoutesOptions } from './turn-route-contracts'

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
    turnLock: options.turnLock ?? createDurableTurnLock<TContext>({ ...store.lock, scopeOf: () => 'thread' }),
  }
}
