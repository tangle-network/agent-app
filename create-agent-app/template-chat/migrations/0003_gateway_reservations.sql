CREATE TABLE IF NOT EXISTS agent_api_key_reservation (
  request_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  reserved_cents BIGINT NOT NULL,
  state TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES agent_api_key(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_api_key_reservation_key
  ON agent_api_key_reservation (key_id);
