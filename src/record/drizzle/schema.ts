/**
 * Drizzle table factory for a record-entry table. The product owns its
 * scope (workspace / tenant / account) table; this factory creates the entry
 * table and wires the foreign key into it, so the whole graph lives in one
 * drizzle schema with real cascade semantics.
 *
 * The table NAME is a parameter, so one product can host several independent
 * record tables (different domains, different schema maps) side by side.
 *
 * Three storage invariants are encoded here, and the store depends on all
 * three:
 *
 * 1. **Every key column is NOT NULL with a sentinel.** SQLite treats NULLs as
 *    distinct inside a unique index, so a nullable `item_key` or `dimension`
 *    would let two live heads coexist on one logical key and the partial
 *    unique index below would silently stop enforcing anything. `''` and `0`
 *    are the sentinels; see `RECORD_KEY_SENTINEL` / `RECORD_PERIOD_SENTINEL`.
 * 2. **The live head is unique per key.** The partial unique index covers only
 *    rows that are `accepted` and not superseded, which is exactly the set the
 *    materializer reads. Two writers racing for the same head make the second
 *    one fail loudly instead of both landing.
 * 3. **Ordering is `seq`, never a timestamp.** `created_at` is epoch
 *    milliseconds and is display-only. `(scope_id, seq)` is unique, so the
 *    fold has a total order even for rows written in the same millisecond.
 *
 * `superseded_by_id` deliberately carries NO foreign key: the supersede batch
 * stamps the replacement's id onto the outgoing head BEFORE inserting the
 * replacement row, and SQLite cannot defer the constraint check to allow that
 * order. Rows are append-only and cascade with their scope, so the link cannot
 * dangle.
 */

import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn, AnySQLiteTable, SQLiteColumnBuilderBase } from 'drizzle-orm/sqlite-core'
import type { RecordReviewState, RecordSourceLocator } from '../model'

/** A product table referenced by foreign key — only its `id` column is used. */
export type RecordParentTable = AnySQLiteTable & { id: AnySQLiteColumn }

/**
 * Product columns added to the entry table, keyed by the property name the
 * store and the product read them under. Ordinary drizzle column builders, so
 * a product declares foreign keys, defaults and null-ability exactly as it
 * would in its own schema.
 */
export type RecordExtraColumns = Readonly<Record<string, SQLiteColumnBuilderBase>>

/** Options for {@link createRecordTable}. */
export interface CreateRecordTableOptions {
  /**
   * SQL table name, chosen by the product. Also the default prefix for the
   * index names, so two record tables in one schema never collide.
   */
  tableName: string
  /**
   * The tenant table entries belong to. Rows cascade with it — deleting a
   * workspace deletes its record.
   */
  scopeTable: RecordParentTable
  /**
   * Optional table `source_ref` points at (a documents table, a source-record
   * table). Wire it ONLY when every source kind's ref points at this one
   * table; a product whose refs are heterogeneous (a document id for one kind,
   * a message id for another) leaves it off and keeps `source_ref` plain text.
   * When wired, deleting the source sets the ref null and leaves the entry
   * with its quote and locator intact.
   */
  sourceTable?: RecordParentTable
  /** Optional table `reviewed_by` points at (a users table). */
  reviewerTable?: RecordParentTable
  /** Index-name prefix. Defaults to {@link tableName}. */
  indexPrefix?: string
  /**
   * Product columns merged into the table, the `/missions` store-port pattern.
   *
   * The built-in `source_ref` is ONE column, which is right for a store whose
   * refs all point at one table and wrong for one whose kinds cite different
   * things — a chat-sourced row citing a message and a document-sourced row
   * citing a document each want their own foreign key with their own
   * `ON DELETE` behaviour. Declare them here, require them per source kind
   * through `policy.requireExtras`, and pass their values on `write`; the
   * store carries them and reads none of them.
   *
   * A key that collides with a built-in column is refused at construction —
   * silently shadowing `path` or `review_state` would break every invariant
   * the store rests on.
   */
  extraColumns?: RecordExtraColumns
}

/** Column property names the store owns. An extra column may not take one, and
 *  neither may an `extras` value on a write — shadowing `path` or
 *  `review_state` would break every invariant this table encodes. */
export const RECORD_STORE_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'scopeId',
  'seq',
  'dimension',
  'period',
  'path',
  'itemKey',
  'valueJson',
  'affirmedEmpty',
  'reviewState',
  'conflict',
  'supersededById',
  'sourceKind',
  'sourceRef',
  'sourceLocator',
  'sourceQuote',
  'confidence',
  'reviewedAt',
  'reviewedBy',
  'createdAt',
])

/** The base table, built with no spread of a type variable so drizzle infers
 *  the exact row shape {@link RecordEntryRow} is derived from. */
function buildRecordEntryTable(options: CreateRecordTableOptions) {
  const { tableName, scopeTable, sourceTable, reviewerTable } = options
  const prefix = options.indexPrefix ?? tableName
  const extraColumns = options.extraColumns ?? {}
  const collisions = Object.keys(extraColumns).filter((name) => RECORD_STORE_COLUMNS.has(name))
  if (collisions.length > 0) {
    throw new Error(
      `createRecordTable('${tableName}'): extraColumns may not redefine the store's own columns — ${collisions.sort().join(', ')}`,
    )
  }

  // The base columns are an ordinary object literal so drizzle infers the
  // exact table shape `RecordTable` is derived from; the product's columns are
  // attached through a widened reference, which adds them at RUNTIME (drizzle
  // reads the map, migrations emit them) without an index signature leaking
  // into the inferred row type and erasing every built-in column.
  const columns = {
    /** ULID minted by the store — an atomic supersede needs the replacement
     *  id before the insert, so this has no column default. */
    id: text('id').primaryKey(),
    scopeId: text('scope_id')
      .notNull()
      .references(() => scopeTable.id, { onDelete: 'cascade' }),
    /** Per-scope monotonic write counter, assigned inside the insert
     *  statement. The fold's only ordering key. */
    seq: integer('seq').notNull(),
    /** Consumer-defined partition inside the scope; `''` when unused. */
    dimension: text('dimension').notNull().default(''),
    /** The period the assertion became true in; `0` when the consumer has no
     *  time dimension. */
    period: integer('period').notNull().default(0),
    /** The field this entry asserts. Validated against the consumer's schema
     *  map on every write. */
    path: text('path').notNull(),
    /** Which element of a collection the path belongs to; `''` when not
     *  applicable. */
    itemKey: text('item_key').notNull().default(''),
    /** Canonical JSON (sorted keys) of the validated value. */
    valueJson: text('value_json').notNull(),
    /** "There are none of these" — written against an affirmable path with
     *  `item_key = ''` and `value_json = 'null'`. */
    affirmedEmpty: integer('affirmed_empty', { mode: 'boolean' }).notNull().default(false),
    reviewState: text('review_state').$type<RecordReviewState>().notNull(),
    /** Set when this entry disagreed with a live head from a different source
     *  kind at write time — surfaced for a human to resolve. */
    conflict: integer('conflict', { mode: 'boolean' }).notNull().default(false),
    /** Audit link to the accepted entry that replaced this one; NULL marks a
     *  live head. */
    supersededById: text('superseded_by_id'),
    /** Stamped by the server call site, never accepted from model output. */
    sourceKind: text('source_kind').notNull(),
    sourceRef: sourceTable
      ? text('source_ref').references(() => sourceTable.id, { onDelete: 'set null' })
      : text('source_ref'),
    /** JSON position inside the source. */
    sourceLocator: text('source_locator', { mode: 'json' }).$type<RecordSourceLocator>(),
    sourceQuote: text('source_quote'),
    confidence: real('confidence'),
    /** Epoch milliseconds. */
    reviewedAt: integer('reviewed_at'),
    reviewedBy: reviewerTable
      ? text('reviewed_by').references(() => reviewerTable.id, { onDelete: 'set null' })
      : text('reviewed_by'),
    /** Epoch milliseconds. Display only — `seq` orders the fold. */
    createdAt: integer('created_at')
      .notNull()
      .$defaultFn(() => Date.now()),
  }
  const widened: Record<string, SQLiteColumnBuilderBase> = columns
  for (const [name, column] of Object.entries(extraColumns)) widened[name] = column

  return sqliteTable(
    tableName,
    columns,
    (table) => [
      uniqueIndex(`${prefix}_scope_seq_uidx`).on(table.scopeId, table.seq),
      uniqueIndex(`${prefix}_live_head_uidx`)
        .on(table.scopeId, table.dimension, table.path, table.itemKey, table.period)
        .where(sql`review_state = 'accepted' AND superseded_by_id IS NULL`),
      index(`${prefix}_scope_period_idx`).on(table.scopeId, table.period),
      index(`${prefix}_scope_review_idx`).on(table.scopeId, table.reviewState),
      index(`${prefix}_scope_path_idx`).on(table.scopeId, table.path),
    ],
  )
}

/** The table shape {@link createRecordTable} produces. */
export type RecordTable = ReturnType<typeof buildRecordEntryTable>

/** One stored entry, as selected. */
export type RecordEntryRow = RecordTable['$inferSelect']

/** The record table plus the product's own columns, so a product's direct
 *  queries name them and the store still sees the shape it depends on. */
export type RecordTableWithExtras<TExtra extends RecordExtraColumns> =
  RecordTable & { readonly [K in keyof TExtra]: AnySQLiteColumn }

/**
 * Build one record-entry table wired to the product's tables.
 *
 * The returned table is an ordinary drizzle table: the product puts it in its
 * schema, generates migrations from it, and queries it directly for anything
 * the store does not cover. Declaring `extraColumns` names those columns on
 * the returned type as well.
 */
// The `extraColumns` overload comes FIRST: overload resolution takes the
// earliest match, and `extraColumns` is optional on the plain signature, so
// the plain one would otherwise swallow every call and drop the product's
// columns from the returned type.
export function createRecordTable<TExtra extends RecordExtraColumns>(
  options: CreateRecordTableOptions & { extraColumns: TExtra },
): RecordTableWithExtras<TExtra>
export function createRecordTable(options: CreateRecordTableOptions): RecordTable
export function createRecordTable(options: CreateRecordTableOptions): RecordTable {
  return buildRecordEntryTable(options)
}
