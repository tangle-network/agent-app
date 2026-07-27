/**
 * The reference in-memory store against the shared contract. This is the
 * baseline run: the contract was written FROM `memory.ts`, so any failure here
 * means the contract mis-states the protocol, not that the store is broken.
 *
 * `tests/durable-chat/drizzle-store.test.ts` runs the same suite against the
 * production store — that is where the contract earns its keep.
 */

import { InMemoryDurableChatStateStore } from '../../src/durable-chat'
import { describeDurableChatStoreContract } from './store-contract'

describeDurableChatStoreContract('InMemoryDurableChatStateStore', () => new InMemoryDurableChatStateStore())
