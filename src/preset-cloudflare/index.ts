/**
 * `@tangle-network/agent-app/preset-cloudflare` — the batteries-included default
 * stack.
 *
 * Every fleet agent runs the SAME backend: Cloudflare D1 (SQLite) through
 * Drizzle for state, a KV namespace as the artifact vault, AES-GCM field crypto
 * for PII, and per-workspace budget-capped model keys. The other agent-app
 * modules are pure SEAMS — `./tools` needs an `AppToolHandlers`, `./knowledge`
 * needs a `KnowledgeStateAccessor`, `./billing` needs a `WorkspaceKeyStore` +
 * `KeyCrypto`. This module is the ONE implementation of those seams against the
 * house stack, so a consumer that runs D1 + KV stands the whole shell up with
 * config + bindings and ZERO handler code.
 *
 * Layering:
 *  - Drizzle is a PEER (the consumer installs `drizzle-orm`, never bundled). The
 *    schema is therefore expressed two ways that need no import here: the plain
 *    DDL ({@link PRESET_MIGRATION_SQL}) a consumer runs to create the tables, and
 *    a {@link createPresetDrizzleSchema} factory that takes the consumer's
 *    `drizzle-orm/sqlite-core` builder module and returns the typed tables. The
 *    column names in {@link PRESET_TABLES} are the contract the handlers,
 *    accessor, and DDL all agree on.
 *  - D1 + KV are STRUCTURAL: {@link D1Like} (Cloudflare `D1Database` satisfies it)
 *    and `KvLike` from `../web` (Cloudflare `KVNamespace` satisfies it). No
 *    `@cloudflare/workers-types` dependency.
 *  - Crypto/billing reuse `../crypto` + `../billing` exactly — this only wires
 *    them to the D1 key table.
 */

import { createFieldCrypto } from '../crypto/index'
import {
  createWorkspaceKeyManager,
  type KeyCrypto,
  type KeyProvisioner,
  type WorkspaceKeyManager,
  type WorkspaceKeyRecord,
  type WorkspaceKeyStore,
} from '../billing/index'
import type { KnowledgeStateAccessor } from '../knowledge/index'
import type {
  AddCitationArgs,
  AddCitationResult,
  AppToolContext,
  AppToolHandlers,
  RenderUiArgs,
  RenderUiResult,
  ScheduleFollowupArgs,
  ScheduleFollowupResult,
  SubmitProposalArgs,
  SubmitProposalResult,
} from '../tools/index'
import type { KvLike } from '../web/index'

// ---------------------------------------------------------------------------
// D1 structural seam
//
// The minimal surface of Cloudflare's `D1Database` the handlers + accessor use.
// `D1Database` satisfies it structurally, so the consumer passes `env.DB`
// directly and tests pass an in-memory fake. We keep it to the
// prepare/bind/first/run/all shape D1 already exposes — no Drizzle here, so the
// default handlers run on a fresh Worker with only the D1 binding.
// ---------------------------------------------------------------------------

/** A prepared, bound D1 statement. */
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>
  run(): Promise<unknown>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

/** The D1 surface the preset needs. Cloudflare `D1Database` satisfies it. */
export interface D1Like {
  prepare(query: string): D1PreparedLike
}

// ---------------------------------------------------------------------------
// Default schema
//
// The four tables the default handlers + accessor read/write. Column names are
// the single source of truth shared by the DDL, the Drizzle factory, the
// handlers, and the accessor. Every table is workspace-scoped on `workspace_id`
// (the accessor's default `where` column) so the knowledge `count` rule and the
// tool writes agree without per-consumer wiring.
//
// Deliberately NOT here: chat thread/message tables. `/chat-store` is the
// single thread-schema owner (`createChatTables` + `createChatStore`); the
// preset once declared an unconsumed `threads` DDL, removed so two schemas
// can't drift.
// ---------------------------------------------------------------------------

/** The preset table + column names — the contract the DDL, Drizzle schema,
 *  handlers, and accessor share. Exposed so a consumer can reference a column
 *  without a string literal. */
export const PRESET_TABLES = {
  proposals: {
    name: 'proposals',
    columns: {
      id: 'id',
      workspaceId: 'workspace_id',
      threadId: 'thread_id',
      type: 'type',
      title: 'title',
      description: 'description',
      status: 'status',
      createdBy: 'created_by',
      createdAt: 'created_at',
    },
  },
  knowledge: {
    name: 'knowledge',
    columns: {
      id: 'id',
      workspaceId: 'workspace_id',
      path: 'path',
      kind: 'kind',
      label: 'label',
      content: 'content',
      createdAt: 'created_at',
    },
  },
  deadlines: {
    name: 'deadlines',
    columns: {
      id: 'id',
      workspaceId: 'workspace_id',
      threadId: 'thread_id',
      title: 'title',
      dueDate: 'due_date',
      priority: 'priority',
      status: 'status',
      createdAt: 'created_at',
    },
  },
  workspaceKeys: {
    name: 'workspace_keys',
    columns: {
      id: 'id',
      workspaceId: 'workspace_id',
      keyId: 'key_id',
      keyEncrypted: 'key_encrypted',
      budgetUsd: 'budget_usd',
      expiresAt: 'expires_at',
      revokedAt: 'revoked_at',
      createdAt: 'created_at',
    },
  },
} as const

/**
 * Plain DDL for the preset schema — run by a consumer to create the tables with
 * ZERO drizzle (`for (const sql of PRESET_MIGRATION_SQL) await db.prepare(sql).run()`,
 * or paste into a `.sql` migration). One statement per table so D1's
 * single-statement `prepare` accepts each. Matches {@link PRESET_TABLES} exactly.
 */
export const PRESET_MIGRATION_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    content TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deadlines (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    thread_id TEXT,
    title TEXT NOT NULL,
    due_date TEXT NOT NULL,
    priority TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    key_encrypted TEXT NOT NULL,
    budget_usd REAL NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_proposals_ws ON proposals (workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_deadlines_ws ON deadlines (workspace_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_ws ON knowledge (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_workspace_keys_ws ON workspace_keys (workspace_id, revoked_at)`,
]

/** A chainable column builder — every modifier returns the builder so calls
 *  like `.notNull().default('pending')` typecheck. The concrete drizzle builders
 *  satisfy this structurally. */
export interface DrizzleColumnLike {
  primaryKey: () => DrizzleColumnLike
  notNull: () => DrizzleColumnLike
  default: (v: unknown) => DrizzleColumnLike
}

/** The shape of a `drizzle-orm/sqlite-core` module — the few builders the
 *  preset schema uses. The consumer passes the real module; agent-app never
 *  imports it (it stays a peer). */
export interface DrizzleSqliteCoreLike {
  sqliteTable: (name: string, columns: Record<string, DrizzleColumnLike>) => unknown
  text: (name?: string) => DrizzleColumnLike
  integer: (name?: string, config?: unknown) => DrizzleColumnLike
  real: (name?: string) => DrizzleColumnLike
}

/**
 * Build the typed Drizzle schema for the preset, given the consumer's
 * `drizzle-orm/sqlite-core` module. Returns one table object per
 * {@link PRESET_TABLES} entry — pass to `drizzle(db, { schema })` for typed
 * queries, or to drizzle-kit for migration generation. agent-app never imports
 * drizzle; the builder module is the seam.
 *
 * ```ts
 * import * as d from 'drizzle-orm/sqlite-core'
 * const schema = createPresetDrizzleSchema(d)
 * ```
 */
export function createPresetDrizzleSchema(d: DrizzleSqliteCoreLike) {
  const { sqliteTable, text, integer, real } = d
  const C = PRESET_TABLES
  return {
    proposals: sqliteTable(C.proposals.name, {
      id: text(C.proposals.columns.id).primaryKey(),
      workspaceId: text(C.proposals.columns.workspaceId).notNull(),
      threadId: text(C.proposals.columns.threadId),
      type: text(C.proposals.columns.type).notNull(),
      title: text(C.proposals.columns.title).notNull(),
      description: text(C.proposals.columns.description),
      status: text(C.proposals.columns.status).notNull().default('pending'),
      createdBy: text(C.proposals.columns.createdBy),
      createdAt: integer(C.proposals.columns.createdAt).notNull(),
    }),
    knowledge: sqliteTable(C.knowledge.name, {
      id: text(C.knowledge.columns.id).primaryKey(),
      workspaceId: text(C.knowledge.columns.workspaceId).notNull(),
      path: text(C.knowledge.columns.path).notNull(),
      kind: text(C.knowledge.columns.kind).notNull(),
      label: text(C.knowledge.columns.label),
      content: text(C.knowledge.columns.content),
      createdAt: integer(C.knowledge.columns.createdAt).notNull(),
    }),
    deadlines: sqliteTable(C.deadlines.name, {
      id: text(C.deadlines.columns.id).primaryKey(),
      workspaceId: text(C.deadlines.columns.workspaceId).notNull(),
      threadId: text(C.deadlines.columns.threadId),
      title: text(C.deadlines.columns.title).notNull(),
      dueDate: text(C.deadlines.columns.dueDate).notNull(),
      priority: text(C.deadlines.columns.priority),
      status: text(C.deadlines.columns.status).notNull().default('scheduled'),
      createdAt: integer(C.deadlines.columns.createdAt).notNull(),
    }),
    workspaceKeys: sqliteTable(C.workspaceKeys.name, {
      id: text(C.workspaceKeys.columns.id).primaryKey(),
      workspaceId: text(C.workspaceKeys.columns.workspaceId).notNull(),
      keyId: text(C.workspaceKeys.columns.keyId).notNull(),
      keyEncrypted: text(C.workspaceKeys.columns.keyEncrypted).notNull(),
      budgetUsd: real(C.workspaceKeys.columns.budgetUsd).notNull(),
      expiresAt: integer(C.workspaceKeys.columns.expiresAt).notNull(),
      revokedAt: integer(C.workspaceKeys.columns.revokedAt),
      createdAt: integer(C.workspaceKeys.columns.createdAt).notNull(),
    }),
  }
}

// ---------------------------------------------------------------------------
// Default AppToolHandlers over D1 + KV
// ---------------------------------------------------------------------------

/** The KV-backed vault. `KvLike` (from `../web`) is the structural KV contract;
 *  Cloudflare `KVNamespace` satisfies it. Artifacts are stored under their path. */
export type VaultKv = KvLike

/** Define configuration options for handling preset tools including database, vault, and optional utilities */
export interface PresetToolHandlerOptions {
  /** The D1 database (Cloudflare `D1Database` satisfies {@link D1Like}). */
  db: D1Like
  /** The KV namespace used as the artifact vault. */
  vault: VaultKv
  /** Id generator. Default `crypto.randomUUID`. Injectable for deterministic tests. */
  newId?: () => string
  /** Clock (epoch ms). Default `Date.now`. Injectable for deterministic tests. */
  now?: () => number
  /** Vault path prefix for `render_ui` artifacts. Default `'ui'`. */
  uiPathPrefix?: string
  /** Vault path prefix for `add_citation` artifacts. Default `'citations'`. */
  citationPathPrefix?: string
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'item'
}

/**
 * The default {@link AppToolHandlers} for the house stack:
 *  - `submit_proposal`   → insert a `proposals` row (`status='pending'`), deduped
 *                          on (workspace, title) so a retried turn doesn't double-queue.
 *  - `schedule_followup` → insert a `deadlines` row, deduped on (workspace, title, due_date).
 *  - `render_ui`         → write the schema JSON as a `ui/<thread>/<slug>.json`
 *                          vault artifact AND a `knowledge` row pointing at it.
 *  - `add_citation`      → write the quote as a `citations/<slug>.json` artifact AND
 *                          a `knowledge` row.
 *
 * Returns the EXACT persisted content from `render_ui` (per the seam contract) so
 * a completion oracle sees real bytes. Pure seam wiring: a consumer that runs
 * D1 + KV gets all four tools with no handler code.
 */
export function createPresetToolHandlers(opts: PresetToolHandlerOptions): AppToolHandlers {
  const { db, vault } = opts
  const newId = opts.newId ?? (() => crypto.randomUUID())
  const now = opts.now ?? (() => Date.now())
  const uiPrefix = opts.uiPathPrefix ?? 'ui'
  const citationPrefix = opts.citationPathPrefix ?? 'citations'
  const P = PRESET_TABLES.proposals
  const D = PRESET_TABLES.deadlines
  const K = PRESET_TABLES.knowledge

  async function persistArtifact(path: string, body: string): Promise<void> {
    await vault.put(path, body)
  }

  async function insertKnowledge(workspaceId: string, path: string, kind: string, label: string | null, content: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO ${K.name} (${K.columns.id}, ${K.columns.workspaceId}, ${K.columns.path}, ${K.columns.kind}, ${K.columns.label}, ${K.columns.content}, ${K.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId(), workspaceId, path, kind, label, content, now())
      .run()
  }

  return {
    async submitProposal(args: SubmitProposalArgs, ctx: AppToolContext): Promise<SubmitProposalResult> {
      const existing = await db
        .prepare(`SELECT ${P.columns.id} AS id FROM ${P.name} WHERE ${P.columns.workspaceId} = ? AND ${P.columns.title} = ? LIMIT 1`)
        .bind(ctx.workspaceId, args.title)
        .first<{ id: string }>()
      if (existing) return { proposalId: existing.id, deduped: true }

      const id = newId()
      await db
        .prepare(
          `INSERT INTO ${P.name} (${P.columns.id}, ${P.columns.workspaceId}, ${P.columns.threadId}, ${P.columns.type}, ${P.columns.title}, ${P.columns.description}, ${P.columns.status}, ${P.columns.createdBy}, ${P.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(id, ctx.workspaceId, ctx.threadId, args.type, args.title, args.description ?? null, ctx.userId, now())
        .run()
      return { proposalId: id, deduped: false }
    },

    async scheduleFollowup(args: ScheduleFollowupArgs, ctx: AppToolContext): Promise<ScheduleFollowupResult> {
      const existing = await db
        .prepare(
          `SELECT ${D.columns.id} AS id, ${D.columns.dueDate} AS dueDate FROM ${D.name} WHERE ${D.columns.workspaceId} = ? AND ${D.columns.title} = ? AND ${D.columns.dueDate} = ? LIMIT 1`,
        )
        .bind(ctx.workspaceId, args.title, args.dueDate)
        .first<{ id: string; dueDate: string }>()
      if (existing) return { id: existing.id, dueDate: existing.dueDate, deduped: true }

      const id = newId()
      await db
        .prepare(
          `INSERT INTO ${D.name} (${D.columns.id}, ${D.columns.workspaceId}, ${D.columns.threadId}, ${D.columns.title}, ${D.columns.dueDate}, ${D.columns.priority}, ${D.columns.status}, ${D.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
        )
        .bind(id, ctx.workspaceId, ctx.threadId, args.title, args.dueDate, args.priority ?? null, now())
        .run()
      return { id, dueDate: args.dueDate, deduped: false }
    },

    async renderUi(args: RenderUiArgs, ctx: AppToolContext): Promise<RenderUiResult> {
      const content = JSON.stringify(args.schema)
      const path = `${uiPrefix}/${ctx.threadId ?? 'global'}/${slug(args.title)}.json`
      await persistArtifact(path, content)
      await insertKnowledge(ctx.workspaceId, path, 'ui', args.title, content)
      return { path, content }
    },

    async addCitation(args: AddCitationArgs, ctx: AppToolContext): Promise<AddCitationResult> {
      const citationId = newId()
      const path = `${citationPrefix}/${slug(args.label ?? args.path)}-${citationId.slice(0, 8)}.json`
      const body = JSON.stringify({ sourcePath: args.path, quote: args.quote, label: args.label ?? null })
      await persistArtifact(path, body)
      await insertKnowledge(ctx.workspaceId, path, 'citation', args.label ?? null, body)
      return { citationId, path }
    },
  }
}

// ---------------------------------------------------------------------------
// D1-backed KnowledgeStateAccessor
// ---------------------------------------------------------------------------

/** Define options for accessing preset knowledge scoped to a specific workspace and configuration */
export interface PresetKnowledgeAccessorOptions {
  db: D1Like
  /** The active workspace — every `count` is scoped to it. */
  workspaceId: string
  /** Workspace config the `satisfiedBy: { config }` rules read. A resolved
   *  object (dot-path lookup), or a function the accessor calls per path. */
  config: Record<string, unknown> | ((path: string) => unknown)
  /** The default workspace fk column a `count` rule scopes on when its rule
   *  omits `where`. Default `'workspace_id'` (the preset schema convention). */
  defaultWhereColumn?: string
}

function readDotPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * The {@link KnowledgeStateAccessor} over the preset D1 schema — the seam that
 * lets the declarative `satisfiedBy` rules resolve with ZERO consumer code:
 *  - `config(path)` reads the supplied workspace config by dot-path.
 *  - `count({ table, where, statusIn })` runs `SELECT count(*)` scoped to the
 *    active workspace (the rule's `where` column, default `workspace_id`),
 *    optionally filtered to `statusIn` via a parameterized `IN (...)`.
 *
 * Identifiers (table/column) are validated against a safe pattern before
 * interpolation — they originate from the product's own config, never model
 * input, but we fail loud rather than build a malformed/injectable query.
 */
export function createD1KnowledgeStateAccessor(opts: PresetKnowledgeAccessorOptions): KnowledgeStateAccessor {
  const { db, workspaceId } = opts
  const defaultWhere = opts.defaultWhereColumn ?? 'workspace_id'
  const configFn = typeof opts.config === 'function' ? opts.config : (path: string) => readDotPath(opts.config as Record<string, unknown>, path)

  const isIdentifier = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)

  return {
    config: configFn,
    async count(query) {
      if (!isIdentifier(query.table)) throw new Error(`unsafe table identifier: ${query.table}`)
      const whereCol = query.where ?? defaultWhere
      if (!isIdentifier(whereCol)) throw new Error(`unsafe where identifier: ${whereCol}`)

      let sql = `SELECT count(*) AS n FROM ${query.table} WHERE ${whereCol} = ?`
      const binds: unknown[] = [workspaceId]
      if (query.statusIn && query.statusIn.length > 0) {
        sql += ` AND status IN (${query.statusIn.map(() => '?').join(', ')})`
        binds.push(...query.statusIn)
      }
      const row = await db.prepare(sql).bind(...binds).first<{ n: number }>()
      return row?.n ?? 0
    },
  }
}

// ---------------------------------------------------------------------------
// Crypto + per-workspace key wiring
// ---------------------------------------------------------------------------

/** Build the {@link KeyCrypto} the billing key store uses — AES-256-GCM field
 *  crypto bound to the product's 64-char-hex `ENCRYPTION_KEY` (or a resolver).
 *  This is the concrete impl behind the `../billing` `KeyCrypto` seam. */
export function createPresetFieldCrypto(key: string | (() => string)): KeyCrypto {
  return createFieldCrypto(key)
}

/**
 * The {@link WorkspaceKeyStore} over the preset `workspace_keys` table — the
 * persistence seam the per-workspace key manager needs. "Active" = a row with a
 * null `revoked_at`. Pure D1 wiring; no key minting (that's the provisioner).
 */
export function createPresetWorkspaceKeyStore(db: D1Like): WorkspaceKeyStore {
  const W = PRESET_TABLES.workspaceKeys
  return {
    async getActive(workspaceId: string): Promise<WorkspaceKeyRecord | null> {
      const row = await db
        .prepare(
          `SELECT ${W.columns.id} AS id, ${W.columns.keyId} AS keyId, ${W.columns.keyEncrypted} AS keyEncrypted, ${W.columns.budgetUsd} AS budgetUsd, ${W.columns.expiresAt} AS expiresAt FROM ${W.name} WHERE ${W.columns.workspaceId} = ? AND ${W.columns.revokedAt} IS NULL ORDER BY ${W.columns.createdAt} DESC LIMIT 1`,
        )
        .bind(workspaceId)
        .first<{ id: string; keyId: string; keyEncrypted: string; budgetUsd: number; expiresAt: number | null }>()
      if (!row) return null
      return {
        id: row.id,
        keyId: row.keyId,
        keyEncrypted: row.keyEncrypted,
        budgetUsd: row.budgetUsd,
        expiresAt: row.expiresAt == null ? null : new Date(row.expiresAt),
      }
    },
    async listActive(workspaceId: string): Promise<Array<{ id: string; keyId: string }>> {
      const res = await db
        .prepare(`SELECT ${W.columns.id} AS id, ${W.columns.keyId} AS keyId FROM ${W.name} WHERE ${W.columns.workspaceId} = ? AND ${W.columns.revokedAt} IS NULL`)
        .bind(workspaceId)
        .all<{ id: string; keyId: string }>()
      return res.results
    },
    async insert(record): Promise<void> {
      await db
        .prepare(
          `INSERT INTO ${W.name} (${W.columns.id}, ${W.columns.workspaceId}, ${W.columns.keyId}, ${W.columns.keyEncrypted}, ${W.columns.budgetUsd}, ${W.columns.expiresAt}, ${W.columns.revokedAt}, ${W.columns.createdAt}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .bind(crypto.randomUUID(), record.workspaceId, record.keyId, record.keyEncrypted, record.budgetUsd, record.expiresAt.getTime(), Date.now())
        .run()
    },
    async markRevoked(id: string, now: Date): Promise<void> {
      await db
        .prepare(`UPDATE ${W.name} SET ${W.columns.revokedAt} = ? WHERE ${W.columns.id} = ?`)
        .bind(now.getTime(), id)
        .run()
    },
  }
}

/** Define preset billing options including database, provisioner, encryption key, budget, and optional settings */
export interface PresetBillingOptions {
  db: D1Like
  /** The key provisioner (`@tangle-network/tcloud`'s client satisfies it structurally). */
  provisioner: KeyProvisioner
  /** Field-crypto key (64-char hex) or resolver — encrypts the minted key at rest. */
  encryptionKey: string | (() => string)
  /** Default monthly USD allowance when a call doesn't specify one. */
  defaultBudgetUsd: number
  /** Injectable clock. */
  now?: () => Date
  /** tcloud product the key is scoped to. Default `'router'`. */
  product?: string
}

/**
 * Stand up the per-workspace budget-capped {@link WorkspaceKeyManager} on the
 * house stack: the preset `workspace_keys` D1 store + AES-GCM field crypto +
 * the consumer's tcloud provisioner. The mint/rotate/rollover/usage LOGIC lives
 * in `../billing`; this only binds it to the preset table + crypto.
 */
export function createPresetWorkspaceKeyManager(opts: PresetBillingOptions): WorkspaceKeyManager {
  return createWorkspaceKeyManager({
    provisioner: opts.provisioner,
    store: createPresetWorkspaceKeyStore(opts.db),
    crypto: createPresetFieldCrypto(opts.encryptionKey),
    defaultBudgetUsd: opts.defaultBudgetUsd,
    now: opts.now,
    product: opts.product,
  })
}
