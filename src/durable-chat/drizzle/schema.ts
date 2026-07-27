/**
 * Drizzle schema for the durable chat store. Three factories, matching the
 * three ports: `createDurablePlanTables()` (plan-only adopter),
 * `createDurableInteractionTables()` (interaction-only adopter), and
 * `createDurableChatTables()` (both). A plan-only product runs three tables'
 * worth of DDL and never creates an answer-intent journal it does not use.
 *
 * `scope` is a plain column with NO foreign key. It is an opaque,
 * authorization-derived tenant/thread string (`DurableChatScope`) that the store
 * must never interpret or join on — so it is simply the leading column of every
 * index, and every query pins it in the WHERE clause.
 *
 * ## Why each row carries a JSON blob plus a handful of scalar columns
 *
 * The blob is authoritative for the record's content; the scalar columns exist
 * only because a SQL predicate needs them — to key a row, to order revisions, or
 * to guard a compare-and-set. Spreading `ChatInteraction`/`ChatPlan` across
 * columns would make every future field addition a migration, and the projection
 * types are owned by `/plans` and `/interactions`, not here.
 *
 * ## Why every ON CONFLICT target is a named unique INDEX
 *
 * Not a composite `primaryKey()` and not a `uniqueConstraints` entry: the DDL
 * generators the tests use to build a real SQLite database from these
 * definitions emit columns, foreign keys and indexes. A composite primary key
 * would be silently absent from the test database, so every compare-and-set test
 * would pass against a schema that is not the one production runs. Partial
 * (`.where(...)`) indexes are avoided for the same reason, which is why the
 * semantic-key reservation and the duplicate-id alias map are their own tables
 * rather than a partial index over the projection table.
 *
 * Imports `drizzle-orm` at module top — that is WHY this lives behind the
 * `/durable-chat/drizzle` subpath. The pure `./durable-chat` leaf imports none
 * of it, so a consumer that never touches a database never pulls the optional
 * peer.
 */

import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import type {
  DurableAnswerIntentState,
  DurableInteractionAcknowledgement,
  DurableInteractionProjection,
  DurablePlanAuthorityResult,
  DurablePlanCommandState,
  DurablePlanProjection,
  DurableFollowUpReceipt,
} from '../types'

const hexId = () => text('id').primaryKey().default(sql`(lower(hex(randomblob(16))))`)

/** Epoch milliseconds. The store owns this clock; it decides lease staleness. */
const leaseAt = () => integer('lease_at').notNull()

// ─── plan side ───────────────────────────────────────────────────────────────

function createPlanProjectionTable() {
  return sqliteTable('durable_plan_projection', {
    id: hexId(),
    scope: text('scope').notNull(),
    planId: text('plan_id').notNull(),
    revision: integer('revision').notNull(),
    /** Guard column: drives the status-transition and terminal-rewrite checks. */
    status: text('status').notNull(),
    /** Guard columns: a change to any of these without a new revision is rejected. */
    title: text('title'),
    body: text('body').notNull(),
    submittedAt: text('submitted_at').notNull(),
    /** Authoritative content. */
    projection: text('projection', { mode: 'json' }).$type<DurablePlanProjection>().notNull(),
    updatedAt: integer('updated_at').notNull(),
  }, (t) => [
    uniqueIndex('uniq_durable_plan_projection').on(t.scope, t.planId, t.revision),
    // Serves "the current revision" — getPlanProjection with no revision reads
    // the highest one, which is what the in-memory pointer table resolves to.
    index('idx_durable_plan_projection_current').on(t.scope, t.planId, t.revision),
  ])
}

function createPlanCommandTable() {
  return sqliteTable('durable_plan_command', {
    id: hexId(),
    scope: text('scope').notNull(),
    planId: text('plan_id').notNull(),
    revision: integer('revision').notNull(),
    decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
    commandKey: text('command_key').notNull(),
    authorityIdempotencyKey: text('authority_idempotency_key').notNull(),
    state: text('state', {
      enum: ['claimed', 'authority_committed', 'finalized', 'conflicted'],
    }).$type<DurablePlanCommandState>().notNull(),
    claimedAt: text('claimed_at').notNull(),
    /** Random per claim. Holding the current token IS owning the claim. */
    leaseToken: text('lease_token').notNull(),
    leaseAt: leaseAt(),
    /** Incremented on every stale-claim takeover. */
    attempt: integer('attempt').notNull().default(1),
    authorityResult: text('authority_result', { mode: 'json' }).$type<DurablePlanAuthorityResult>(),
    receipt: text('receipt', { mode: 'json' }).$type<DurableFollowUpReceipt>(),
    conflict: text('conflict'),
  }, (t) => [
    // AT MOST ONE command per plan revision, whatever the decision. This is the
    // competing-decision invariant as a database constraint: two workers racing
    // an approve and a reject cannot both win.
    uniqueIndex('uniq_durable_plan_command_revision').on(t.scope, t.planId, t.revision),
    // The port looks commands up by their opaque key.
    uniqueIndex('uniq_durable_plan_command_key').on(t.scope, t.commandKey),
  ])
}

function createPlanEffectTable() {
  return sqliteTable('durable_plan_effect', {
    id: hexId(),
    scope: text('scope').notNull(),
    effectKey: text('effect_key').notNull(),
    planId: text('plan_id').notNull(),
    revision: integer('revision').notNull(),
    decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
    state: text('state', { enum: ['claimed', 'completed', 'error'] }).notNull(),
    claimedAt: text('claimed_at').notNull(),
    completedAt: text('completed_at'),
    error: text('error'),
    leaseToken: text('lease_token').notNull(),
    leaseAt: leaseAt(),
    attempt: integer('attempt').notNull().default(1),
  }, (t) => [
    uniqueIndex('uniq_durable_plan_effect').on(t.scope, t.effectKey),
  ])
}

// ─── interaction side ────────────────────────────────────────────────────────

function createInteractionProjectionTable() {
  return sqliteTable('durable_interaction_projection', {
    id: hexId(),
    scope: text('scope').notNull(),
    interactionId: text('interaction_id').notNull(),
    /** Guard column: pending-vs-terminal drives every ordering rule. */
    status: text('status').notNull(),
    /** Guard column: a repeated event id is an idempotent replay. */
    eventId: text('event_id'),
    /** Guard column: content signature used to dedupe re-emitted questions. */
    semanticKey: text('semantic_key'),
    /** Guard column: a cancel-before-ask row is a terminal tombstone. */
    tombstone: integer('tombstone', { mode: 'boolean' }).notNull().default(false),
    /** Authoritative content. */
    projection: text('projection', { mode: 'json' }).$type<DurableInteractionProjection>().notNull(),
    updatedAt: integer('updated_at').notNull(),
  }, (t) => [
    uniqueIndex('uniq_durable_interaction_projection').on(t.scope, t.interactionId),
    index('idx_durable_interaction_projection_scope').on(t.scope),
  ])
}

/**
 * Duplicate ask ids pointing at the canonical interaction they settle through.
 *
 * Its own table because an alias has no content of its own: a `canonical_id`
 * column on the projection table would need a phantom row per duplicate, and
 * those rows would then surface from `listInteractionProjections`.
 */
function createInteractionAliasTable() {
  return sqliteTable('durable_interaction_alias', {
    id: hexId(),
    scope: text('scope').notNull(),
    aliasId: text('alias_id').notNull(),
    interactionId: text('interaction_id').notNull(),
  }, (t) => [
    uniqueIndex('uniq_durable_interaction_alias').on(t.scope, t.aliasId),
  ])
}

/**
 * The pending-semantic-key reservation: at most one OPEN ask per content
 * signature. A row exists only while its canonical ask is pending and is deleted
 * when that ask settles, so a later turn may legitimately ask the same question
 * again. That release is why this is a table and not a partial unique index —
 * derived state cannot be released independently of the row it derives from.
 */
function createInteractionSemanticTable() {
  return sqliteTable('durable_interaction_semantic', {
    id: hexId(),
    scope: text('scope').notNull(),
    semanticKey: text('semantic_key').notNull(),
    interactionId: text('interaction_id').notNull(),
  }, (t) => [
    uniqueIndex('uniq_durable_interaction_semantic').on(t.scope, t.semanticKey),
  ])
}

function createAnswerIntentTable() {
  return sqliteTable('durable_answer_intent', {
    id: hexId(),
    scope: text('scope').notNull(),
    intentKey: text('intent_key').notNull(),
    interactionId: text('interaction_id').notNull(),
    attemptKey: text('attempt_key').notNull(),
    outcome: text('outcome', { enum: ['accepted', 'declined'] }).notNull(),
    /**
     * Canonical (recursively key-sorted) JSON, so byte equality means payload
     * equality — that is what decides `existing` versus `conflict` on a replayed
     * claim without depending on the key order a client happened to send.
     */
    data: text('data'),
    state: text('state', {
      enum: ['prepared', 'acknowledged', 'finalized', 'aborted'],
    }).$type<DurableAnswerIntentState>().notNull(),
    guarantee: text('guarantee', { enum: ['reconciled', 'best-effort'] }),
    acknowledgement: text('acknowledgement', { mode: 'json' }).$type<DurableInteractionAcknowledgement>(),
    createdAt: text('created_at').notNull(),
    finalizedAt: text('finalized_at'),
    error: text('error'),
    leaseToken: text('lease_token').notNull(),
    leaseAt: leaseAt(),
    attempt: integer('attempt').notNull().default(1),
  }, (t) => [
    uniqueIndex('uniq_durable_answer_intent').on(t.scope, t.intentKey),
    index('idx_durable_answer_intent_interaction').on(t.scope, t.interactionId),
  ])
}

// ─── factories ───────────────────────────────────────────────────────────────

/** The three tables a plan-only adopter needs. */
export function createDurablePlanTables(): DurablePlanTables {
  return {
    planProjection: createPlanProjectionTable(),
    planCommand: createPlanCommandTable(),
    planEffect: createPlanEffectTable(),
  }
}

/** The four tables an interaction-only adopter needs. */
export function createDurableInteractionTables(): DurableInteractionTables {
  return {
    interactionProjection: createInteractionProjectionTable(),
    interactionAlias: createInteractionAliasTable(),
    interactionSemantic: createInteractionSemanticTable(),
    answerIntent: createAnswerIntentTable(),
  }
}

/** All seven tables, for a product wiring both halves. */
export function createDurableChatTables(): DurableChatTables {
  return { ...createDurablePlanTables(), ...createDurableInteractionTables() }
}

/** Plan-side tables. */
export interface DurablePlanTables {
  planProjection: ReturnType<typeof createPlanProjectionTable>
  planCommand: ReturnType<typeof createPlanCommandTable>
  planEffect: ReturnType<typeof createPlanEffectTable>
}

/** Interaction-side tables. */
export interface DurableInteractionTables {
  interactionProjection: ReturnType<typeof createInteractionProjectionTable>
  interactionAlias: ReturnType<typeof createInteractionAliasTable>
  interactionSemantic: ReturnType<typeof createInteractionSemanticTable>
  answerIntent: ReturnType<typeof createAnswerIntentTable>
}

/** Both halves. */
export interface DurableChatTables extends DurablePlanTables, DurableInteractionTables {}

/** Row types, for products that query these tables directly. */
export type DurablePlanProjectionRow = DurablePlanTables['planProjection']['$inferSelect']
/** A persisted plan decision command. */
export type DurablePlanCommandRow = DurablePlanTables['planCommand']['$inferSelect']
/** A persisted after-decision effect claim. */
export type DurablePlanEffectRow = DurablePlanTables['planEffect']['$inferSelect']
/** A persisted interaction ask projection. */
export type DurableInteractionProjectionRow = DurableInteractionTables['interactionProjection']['$inferSelect']
/** A persisted answer intent. */
export type DurableAnswerIntentRow = DurableInteractionTables['answerIntent']['$inferSelect']

/**
 * The DDL these tables compile to, for products applying migrations by hand
 * (D1, libsql). Byte-for-byte what `create-agent-app/template-chat/migrations`
 * ships; `tests/durable-chat/drizzle-schema.test.ts` asserts this constant
 * matches the DDL generated from the definitions above, so it cannot drift.
 */
export const DURABLE_CHAT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS durable_plan_projection (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  projection TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_plan_projection ON durable_plan_projection (scope, plan_id, revision);
CREATE INDEX IF NOT EXISTS idx_durable_plan_projection_current ON durable_plan_projection (scope, plan_id, revision);

CREATE TABLE IF NOT EXISTS durable_plan_command (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  command_key TEXT NOT NULL,
  authority_idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  authority_result TEXT,
  receipt TEXT,
  conflict TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_plan_command_revision ON durable_plan_command (scope, plan_id, revision);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_plan_command_key ON durable_plan_command (scope, command_key);

CREATE TABLE IF NOT EXISTS durable_plan_effect (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  lease_token TEXT NOT NULL,
  lease_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_plan_effect ON durable_plan_effect (scope, effect_key);

CREATE TABLE IF NOT EXISTS durable_interaction_projection (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  status TEXT NOT NULL,
  event_id TEXT,
  semantic_key TEXT,
  tombstone INTEGER NOT NULL DEFAULT false,
  projection TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_interaction_projection ON durable_interaction_projection (scope, interaction_id);
CREATE INDEX IF NOT EXISTS idx_durable_interaction_projection_scope ON durable_interaction_projection (scope);

CREATE TABLE IF NOT EXISTS durable_interaction_alias (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_interaction_alias ON durable_interaction_alias (scope, alias_id);

CREATE TABLE IF NOT EXISTS durable_interaction_semantic (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  interaction_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_interaction_semantic ON durable_interaction_semantic (scope, semantic_key);

CREATE TABLE IF NOT EXISTS durable_answer_intent (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  scope TEXT NOT NULL,
  intent_key TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  data TEXT,
  state TEXT NOT NULL,
  guarantee TEXT,
  acknowledgement TEXT,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  error TEXT,
  lease_token TEXT NOT NULL,
  lease_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_durable_answer_intent ON durable_answer_intent (scope, intent_key);
CREATE INDEX IF NOT EXISTS idx_durable_answer_intent_interaction ON durable_answer_intent (scope, interaction_id);
`
