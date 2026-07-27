/**
 * `/durable-chat` — server-safe structural durability contracts for plan and
 * interaction state. No product authentication, database, transport, or
 * Sandbox imports live here.
 *
 * Two ports, so an adopter implements only the half it uses: `DurablePlanStore`
 * (projections, decision commands, after-decision effects) and
 * `DurableInteractionStore` (ask projections, answer intents).
 * `DurableChatStore` composes both.
 *
 * The in-memory adapter here is a reference/test aid, explicitly NOT production
 * persistence. The production store is
 * `@tangle-network/agent-app/durable-chat/drizzle` — kept behind its own subpath
 * so this module never pulls the optional `drizzle-orm` peer.
 */
export * from './errors'
export * from './types'
export * from './memory'
export * from './interactions'
export * from './adapters'
export * from './plan-routes'
export * from './reconcile'
