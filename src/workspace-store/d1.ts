/**
 * D1 + R2 adapter for agent-runtime's `./workspace-store` port: one versioned
 * memory and file store per tenant, shared by every executor of an app.
 *
 * Text lives in D1 rows; an entry carrying `bytes` points at an R2 object the
 * host uploaded under a key it owns. Delete erases the row, records a tombstone
 * and then removes the R2 object. Products apply {@link WORKSPACE_STORE_D1_SCHEMA_SQL}
 * in their own migration.
 */
import {
  checkWorkspacePut, WorkspaceConflictError, assertWorkspacePath,
  type WorkspaceBytesRef, type WorkspaceDeleteInput, type WorkspaceEntry, type WorkspaceEntryKind,
  type WorkspacePutInput, type WorkspaceStore, type WorkspaceTombstone,
} from '@tangle-network/agent-runtime/workspace-store'

/** Structural subset of Cloudflare D1; keeps the driver out of the public types. */
export interface WorkspaceStoreD1Statement {
  bind(...values: (string | number | null)[]): WorkspaceStoreD1Statement
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}

export interface WorkspaceStoreD1Database {
  prepare(sql: string): WorkspaceStoreD1Statement
  batch(statements: WorkspaceStoreD1Statement[]): Promise<{ meta: { changes: number } }[]>
}

/** Only `delete` is needed: the host uploads bytes before it puts the entry. */
export interface WorkspaceStoreR2Bucket {
  delete(key: string): Promise<void>
}

export const WORKSPACE_STORE_D1_SCHEMA_SQL = `
CREATE TABLE workspace_store_entry (
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'instruction', 'file')),
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'member')),
  content TEXT,
  bytes_key TEXT,
  bytes_size INTEGER,
  bytes_content_type TEXT,
  bytes_sha256 TEXT,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path),
  CHECK ((content IS NULL) <> (bytes_key IS NULL))
);
CREATE TABLE workspace_store_path_revision (
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  last_revision INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
CREATE TABLE workspace_store_tombstone (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path, revision)
);
`

interface EntryRow {
  workspace_id: string; path: string; id: string; kind: WorkspaceEntryKind; scope: WorkspaceEntry['scope']
  content: string | null; bytes_key: string | null; bytes_size: number | null
  bytes_content_type: string | null; bytes_sha256: string | null; revision: number
  created_by: string; created_at: string; updated_by: string; updated_at: string
}

interface TombstoneRow {
  workspace_id: string; id: string; path: string; revision: number; deleted_by: string; deleted_at: string
}

const ENTRY_COLUMNS = `workspace_id, path, id, kind, scope, content, bytes_key, bytes_size,
  bytes_content_type, bytes_sha256, revision, created_by, created_at, updated_by, updated_at`

function entry(row: EntryRow): WorkspaceEntry {
  const bytes: WorkspaceBytesRef | undefined = row.bytes_key === null ? undefined : {
    key: row.bytes_key, size: row.bytes_size ?? 0,
    ...(row.bytes_content_type ? { contentType: row.bytes_content_type } : {}),
    ...(row.bytes_sha256 ? { sha256: row.bytes_sha256 } : {}),
  }
  return { workspaceId: row.workspace_id, id: row.id, path: row.path, kind: row.kind, scope: row.scope,
    ...(row.content !== null ? { content: row.content } : {}), ...(bytes ? { bytes } : {}),
    revision: row.revision, createdBy: row.created_by, createdAt: row.created_at,
    updatedBy: row.updated_by, updatedAt: row.updated_at }
}

function tombstone(row: TombstoneRow): WorkspaceTombstone {
  return { workspaceId: row.workspace_id, id: row.id, path: row.path, revision: row.revision,
    deletedBy: row.deleted_by, deletedAt: row.deleted_at }
}

function scopeOf(path: string): WorkspaceEntry['scope'] {
  return /^\/memories\/members\/[^/]+\//.test(path) ? 'member' : 'workspace'
}

/** Prefix match without LIKE wildcards: model-chosen paths may contain `%` and `_`. */
const PREFIX = 'substr(path, 1, length(?)) = ?'

export interface D1R2WorkspaceStoreOptions {
  db: WorkspaceStoreD1Database
  /** Required when entries carry `bytes`; delete removes the object after the row. */
  bucket?: WorkspaceStoreR2Bucket
  now?: () => Date
}

export function createD1R2WorkspaceStore(options: D1R2WorkspaceStoreOptions): WorkspaceStore {
  const { db, bucket } = options
  const now = () => (options.now?.() ?? new Date()).toISOString()

  async function current(workspaceId: string, path: string): Promise<EntryRow | null> {
    return db.prepare(`SELECT ${ENTRY_COLUMNS} FROM workspace_store_entry WHERE workspace_id = ? AND path = ?`)
      .bind(workspaceId, path).first<EntryRow>()
  }

  async function lastRevision(workspaceId: string, path: string): Promise<number> {
    const row = await db.prepare(`SELECT last_revision FROM workspace_store_path_revision
      WHERE workspace_id = ? AND path = ?`).bind(workspaceId, path).first<{ last_revision: number }>()
    return row?.last_revision ?? 0
  }

  /** Advance the path counter only when the entry write in the same batch landed. */
  function bumpRevision(workspaceId: string, path: string, previous: number, next: number,
    landed: { sql: string; values: (string | number | null)[] }): WorkspaceStoreD1Statement {
    return db.prepare(`INSERT INTO workspace_store_path_revision (workspace_id, path, last_revision)
      SELECT ?, ?, ? WHERE ${landed.sql}
      ON CONFLICT (workspace_id, path) DO UPDATE SET last_revision = excluded.last_revision
        WHERE workspace_store_path_revision.last_revision = ?`)
      .bind(workspaceId, path, next, ...landed.values, previous)
  }

  async function conflict(input: { workspaceId: string; path: string }, expected: number | null): Promise<never> {
    const actual = await current(input.workspaceId, input.path)
    throw new WorkspaceConflictError(input.path, expected, actual?.revision ?? null)
  }

  return {
    async get(workspaceId, path) {
      assertWorkspacePath(path)
      const row = await current(workspaceId, path)
      return row ? entry(row) : null
    },

    async list(workspaceId, prefix) {
      const { results } = await db.prepare(`SELECT ${ENTRY_COLUMNS} FROM workspace_store_entry
        WHERE workspace_id = ? AND ${PREFIX} ORDER BY path`).bind(workspaceId, prefix, prefix).all<EntryRow>()
      return results.map(entry)
    },

    async put(input: WorkspacePutInput) {
      checkWorkspacePut(input)
      const existing = await current(input.workspaceId, input.path)
      if ((existing?.revision ?? null) !== input.ifRevision) return conflict(input, input.ifRevision)
      const previous = await lastRevision(input.workspaceId, input.path)
      const revision = previous + 1
      const at = now()
      const bytes = input.bytes
      const body = [input.content ?? null, bytes?.key ?? null, bytes?.size ?? null,
        bytes?.contentType ?? null, bytes?.sha256 ?? null] as const
      const write = existing
        ? db.prepare(`UPDATE workspace_store_entry SET kind = ?, content = ?, bytes_key = ?, bytes_size = ?,
            bytes_content_type = ?, bytes_sha256 = ?, revision = ?, updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND path = ? AND revision = ?`)
          .bind(input.kind, ...body, revision, input.actor, at, input.workspaceId, input.path, existing.revision)
        : db.prepare(`INSERT INTO workspace_store_entry (${ENTRY_COLUMNS})
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM workspace_store_entry WHERE workspace_id = ? AND path = ?)`)
          .bind(input.workspaceId, input.path, input.id ?? crypto.randomUUID(), input.kind, scopeOf(input.path),
            ...body, revision, input.actor, at, input.actor, at, input.workspaceId, input.path)
      const landed = { sql: `EXISTS (SELECT 1 FROM workspace_store_entry
        WHERE workspace_id = ? AND path = ? AND revision = ? AND updated_at = ?)`,
      values: [input.workspaceId, input.path, revision, at] }
      const [written] = await db.batch([write,
        bumpRevision(input.workspaceId, input.path, previous, revision, landed)])
      if (written?.meta.changes !== 1) return conflict(input, input.ifRevision)
      const saved = await current(input.workspaceId, input.path)
      if (!saved || saved.revision !== revision) return conflict(input, input.ifRevision)
      return entry(saved)
    },

    async delete(input: WorkspaceDeleteInput) {
      assertWorkspacePath(input.path)
      const existing = await current(input.workspaceId, input.path)
      if (!existing) {
        if (input.ifRevision !== undefined) return conflict(input, input.ifRevision)
        return null
      }
      if (input.ifRevision !== undefined && existing.revision !== input.ifRevision) {
        return conflict(input, input.ifRevision)
      }
      const previous = await lastRevision(input.workspaceId, input.path)
      const revision = Math.max(previous, existing.revision) + 1
      const at = now()
      const gone = { sql: `NOT EXISTS (SELECT 1 FROM workspace_store_entry WHERE workspace_id = ? AND path = ?)`,
        values: [input.workspaceId, input.path] }
      const [erased] = await db.batch([
        db.prepare(`DELETE FROM workspace_store_entry WHERE workspace_id = ? AND path = ? AND revision = ?`)
          .bind(input.workspaceId, input.path, existing.revision),
        db.prepare(`INSERT INTO workspace_store_tombstone (workspace_id, id, path, revision, deleted_by, deleted_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE ${gone.sql}`)
          .bind(input.workspaceId, existing.id, input.path, revision, input.actor, at, ...gone.values),
        bumpRevision(input.workspaceId, input.path, previous, revision, gone),
      ])
      if (erased?.meta.changes !== 1) return conflict(input, input.ifRevision ?? existing.revision)
      // The row is gone first, so a failed object delete leaves an orphan object,
      // never an entry that points at missing bytes. Surface the failure.
      if (existing.bytes_key) {
        if (!bucket) throw new Error(`${input.path}: an R2 bucket is required to erase its bytes`)
        await bucket.delete(existing.bytes_key)
      }
      return { workspaceId: input.workspaceId, id: existing.id, path: input.path, revision,
        deletedBy: input.actor, deletedAt: at }
    },

    async tombstones(workspaceId, prefix = '/') {
      const { results } = await db.prepare(`SELECT workspace_id, id, path, revision, deleted_by, deleted_at
        FROM workspace_store_tombstone WHERE workspace_id = ? AND ${PREFIX}
        ORDER BY deleted_at, revision`).bind(workspaceId, prefix, prefix).all<TombstoneRow>()
      return results.map(tombstone)
    },
  }
}
