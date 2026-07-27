/**
 * Schema and migration guarantees.
 *
 * The anti-drift check here is deliberately not a string comparison against the
 * generated DDL — those differ in quoting and `IF NOT EXISTS` while describing
 * the same schema, so a textual assert would be brittle and prove little.
 * Instead the shipped `DURABLE_CHAT_MIGRATION_SQL` has to EARN it: a database
 * built from nothing but that constant must satisfy the entire store contract.
 * A missing column or a forgotten index fails as a real store failure.
 *
 * The rest of the file pins what the store's correctness argument rests on: the
 * unique indexes that every `ON CONFLICT` targets must actually exist and
 * actually reject duplicates.
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'

import {
  DURABLE_CHAT_MIGRATION_SQL,
  createDurableChatTables,
  createDurableInteractionTables,
  createDurablePlanTables,
  createDrizzleDurableChatStore,
} from '../../src/durable-chat/drizzle'
import { openDatabase, tableDdl } from './db-helper'
import { describeDurableChatStoreContract } from './store-contract'

function openFromMigrationSql() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec(DURABLE_CHAT_MIGRATION_SQL)
  return sqlite
}

/** The shipped migration SQL must produce a fully working store. */
describeDurableChatStoreContract('DURABLE_CHAT_MIGRATION_SQL', () => {
  const tables = createDurableChatTables()
  return createDrizzleDurableChatStore({ db: drizzle(openFromMigrationSql()), tables })
})

describe('durable chat schema', () => {
  it('splits the tables so a plan-only adopter creates no interaction tables', () => {
    expect(Object.keys(createDurablePlanTables()).sort()).toEqual([
      'planCommand', 'planEffect', 'planProjection',
    ])
    expect(Object.keys(createDurableInteractionTables()).sort()).toEqual([
      'answerIntent', 'interactionAlias', 'interactionProjection', 'interactionSemantic',
    ])
    expect(Object.keys(createDurableChatTables())).toHaveLength(7)
  })

  it('ships a migration covering every table and index the factories declare', () => {
    const tables = Object.values(createDurableChatTables())
    const generated = tables.flatMap((table) => tableDdl(table)).join('\n')

    // Every table and index name the drizzle definitions produce must appear in
    // the SQL a product actually applies, or production runs a schema the tests
    // never saw.
    const names = [...generated.matchAll(/(?:CREATE TABLE|INDEX) "([a-z_]+)"/g)].map((match) => match[1]!)
    expect(names.length).toBeGreaterThan(0)
    for (const name of new Set(names)) {
      expect(DURABLE_CHAT_MIGRATION_SQL).toContain(name)
    }

    // ...and every column, which is what catches a field added to a table but
    // forgotten in the migration.
    for (const table of tables) {
      const ddl = tableDdl(table)[0]!
      for (const column of [...ddl.matchAll(/"([a-z_]+)" (?:TEXT|INTEGER)/g)].map((m) => m[1]!)) {
        expect(DURABLE_CHAT_MIGRATION_SQL).toContain(column)
      }
    }
  })

  it('creates the unique indexes every compare-and-set targets', () => {
    const sqlite = openFromMigrationSql()
    const indexes = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'uniq_%'",
    ).all() as Array<{ name: string }>

    expect(new Set(indexes.map((row) => row.name))).toEqual(new Set([
      'uniq_durable_plan_projection',
      'uniq_durable_plan_command_revision',
      'uniq_durable_plan_command_key',
      'uniq_durable_plan_effect',
      'uniq_durable_interaction_projection',
      'uniq_durable_interaction_alias',
      'uniq_durable_interaction_semantic',
      'uniq_durable_answer_intent',
    ]))
  })

  it('enforces one command per plan revision at the database level', () => {
    // This is the competing-decision invariant. If the index is missing the
    // store still "works" in single-threaded tests and silently allows two
    // decisions on one revision under load — so assert the constraint itself.
    const sqlite = openFromMigrationSql()
    const insert = (decision: string, commandKey: string) => sqlite.prepare(`
      INSERT INTO durable_plan_command
        (scope, plan_id, revision, decision, command_key, authority_idempotency_key,
         state, claimed_at, lease_token, lease_at)
      VALUES ('s', 'plan-1', 1, ?, ?, 'idem', 'claimed', 'now', 'lease', 0)
    `).run(decision, commandKey)

    insert('approved', 'plan:plan-1:1:approved')
    expect(() => insert('rejected', 'plan:plan-1:1:rejected')).toThrow(/UNIQUE constraint failed/)
  })

  it('enforces one open ask per content signature', () => {
    const sqlite = openFromMigrationSql()
    const reserve = (interactionId: string) => sqlite.prepare(
      'INSERT INTO durable_interaction_semantic (scope, semantic_key, interaction_id) VALUES (?, ?, ?)',
    ).run('s', 'sig-1', interactionId)

    reserve('ask-1')
    expect(() => reserve('ask-2')).toThrow(/UNIQUE constraint failed/)
    // A different scope is a different tenant and must not collide.
    expect(() => sqlite.prepare(
      'INSERT INTO durable_interaction_semantic (scope, semantic_key, interaction_id) VALUES (?, ?, ?)',
    ).run('other', 'sig-1', 'ask-3')).not.toThrow()
  })

  it('generates DDL matching the migration for a plan-only adopter', () => {
    // A plan-only product runs three tables' DDL and nothing else — proving the
    // split is real at the schema level, not just in the TypeScript types.
    const planTables = Object.values(createDurablePlanTables())
    const ddl = planTables.flatMap((table) => tableDdl(table)).join('\n')
    expect(ddl).not.toContain('durable_answer_intent')
    expect(ddl).not.toContain('durable_interaction_projection')

    // ...and that DDL alone opens cleanly.
    expect(() => openDatabase(planTables)).not.toThrow()
  })
})
