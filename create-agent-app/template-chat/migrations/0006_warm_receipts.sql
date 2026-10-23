-- Shared keyed prewarm receipts; historical warm state is never inferred.
CREATE TABLE IF NOT EXISTS warm_receipts (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  report TEXT
);
CREATE INDEX IF NOT EXISTS warm_receipts_by_expiry ON warm_receipts (expires_at);
