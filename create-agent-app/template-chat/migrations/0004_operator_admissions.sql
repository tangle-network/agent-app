-- Durable duplicate suppression across Worker isolates. A lost admission is
-- never retried automatically; inspect its persisted transcript/state first.
CREATE TABLE IF NOT EXISTS operator_turn_admissions (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  refusal_json TEXT,
  PRIMARY KEY (owner_id, turn_id)
);
