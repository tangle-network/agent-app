/** Shared D1 replay and authenticated workspace locks from the application's bindings. */
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

/** Keep the workspace-channel identity, authentication and region the same in both routes. With `db`, the store the
 *  routes renew running turns in, a refused acquire reclaims a dead holder (`reconcileTurnLockFromStoreAndBox`). */
export function createDefaultTurnLock<TContext>(store: Pick<ChatTurnStoreBindings, 'lock' | 'region'> & { db?: D1LikeForTurns }) {
  return createDurableTurnLock<TContext>({ ...store.lock, locationHint: store.region, scopeOf: () => 'workspace',
    ...(store.db ? { turnStore: createD1TurnEventStore(store.db) } : {}) })
}

export type ResolvedChatTurnRoutesOptions<TContext, TResource = unknown> = Omit<CreateChatTurnRoutesOptions<TContext, TResource>, 'turnStore' | 'turnLock' | 'produce'> & {
  turnStore: TurnEventStore
  turnLock?: Exclude<CreateChatTurnRoutesOptions<TContext, TResource>['turnLock'], false>
  produce: Exclude<CreateChatTurnRoutesOptions<TContext, TResource>['produce'], undefined | import('./default-backend').ChatTurnDefaultBackend<TContext, TResource>>
}

export function turnStorageBindings(options: { turnStore: TurnEventStore | ChatTurnStoreBindings; env?: import('./default-backend').ChatTurnEnvironment }): ChatTurnStoreBindings | undefined {
  if (!('append' in options.turnStore)) return options.turnStore
  const env = options.env
  const namespace = env?.TURN_STREAM ?? env?.TURN_STREAM_DO
  if (!env?.DB || !namespace || !env.TURN_STREAM_AUTH_SECRET) return undefined
  return { db: env.DB, region: env.D1_REGION, lock: { namespace, auth: { secret: env.TURN_STREAM_AUTH_SECRET } } }
}

export function resolveTurnStorage<TContext, TResource>(options: CreateChatTurnRoutesOptions<TContext, TResource>) {
  const bindings = turnStorageBindings(options)
  const env = options.env
  const namespace = env?.TURN_STREAM ?? env?.TURN_STREAM_DO
  const lockBindings = bindings ?? (namespace && env?.TURN_STREAM_AUTH_SECRET ? {
    region: env.D1_REGION, lock: { namespace, auth: { secret: env.TURN_STREAM_AUTH_SECRET } },
  } : undefined)
  // The lock reads running turns from `db` only when the routes renew them there, never beside a product's own store.
  const lockStore = lockBindings && 'append' in options.turnStore ? { ...lockBindings, db: undefined } : lockBindings
  return {
    turnStore: 'append' in options.turnStore ? options.turnStore : createD1TurnEventStore(options.turnStore.db),
    turnLock: options.turnLock === false ? undefined : options.turnLock ?? (lockStore ? createDefaultTurnLock<TContext>(lockStore)
      : env ? { acquire: () => ({ acquired: false as const, response: Response.json({ error: 'Durable turn locking is not configured', code: 'chat.lock_not_configured' }, { status: 503 }) }), release: () => {} } : undefined),
  }
}
