-- 0001_init.sql — the complete schema for the assembled chat vertical.
-- Apply with: pnpm db:migrate:local (dev) / pnpm db:migrate (production D1).
--
-- Three blocks, each mirroring a factory the app composes. The e2e test in
-- tests/ executes THIS file against a real SQLite database and then drives
-- sign-up, thread CRUD, and a full streamed turn through it — if any block
-- drifts from the factory that owns it, the test fails before you ship.

-- ── better-auth (src/db/schema.ts users/sessions/accounts/verifications) ────

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);

-- ── chat threads/messages (createChatTables() in src/db/schema.ts) ──────────
-- workspace_id is a plain column: this template ships single-user workspaces
-- (workspace id = user id). Moving to real teams later adds the FK via
-- createChatTables({ workspaceTable }).

CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_thread_workspace ON thread (workspace_id);
CREATE INDEX IF NOT EXISTS idx_thread_workspace_updated ON thread (workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  parts TEXT DEFAULT '[]',
  tool_name TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_message_thread ON message (thread_id);
CREATE INDEX IF NOT EXISTS idx_message_thread_created ON message (thread_id, created_at);

-- ── turn buffer (TURN_EVENTS_MIGRATION_SQL from @tangle-network/agent-app/stream)
-- Byte-for-byte the constant the D1 turn-event store expects; the e2e test
-- asserts this block matches the exported SQL so it cannot drift silently.

CREATE TABLE IF NOT EXISTS turn_events (
  turnId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (turnId, seq)
);
CREATE TABLE IF NOT EXISTS turn_status (
  turnId TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  scopeId TEXT,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_status_scope ON turn_status (scopeId, status);
