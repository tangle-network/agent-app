/**
 * The production store against the shared contract, on a real SQLite database.
 *
 * This is the run that matters: the same suite that pins the reference
 * in-memory store now has to pass over SQL, so "the drizzle store behaves like
 * the reference store" is a test result rather than a claim.
 */

import { createDurableChatTables, createDrizzleDurableChatStore } from '../../src/durable-chat/drizzle'
import { openDatabase } from './db-helper'
import { describeDurableChatStoreContract } from './store-contract'

describeDurableChatStoreContract('createDrizzleDurableChatStore (better-sqlite3)', () => {
  const tables = createDurableChatTables()
  const db = openDatabase(Object.values(tables))
  return createDrizzleDurableChatStore({ db, tables })
})
