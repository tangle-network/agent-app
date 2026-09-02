-- External OpenAI-compatible API storage from @tangle-network/agent-gateway.
-- Keep this separate from 0001 so an existing generated app can apply it.

CREATE TABLE IF NOT EXISTS agent_api_key (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  rate_limit INTEGER NOT NULL,
  daily_limit INTEGER NOT NULL,
  spending_limit_cents BIGINT,
  spent_cents BIGINT NOT NULL DEFAULT 0,
  last_used_at BIGINT,
  expires_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_api_key_user ON agent_api_key (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_api_key_hash_unique ON agent_api_key (key_hash);

CREATE TABLE IF NOT EXISTS agent_api_key_usage (
  request_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  cost_cents BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES agent_api_key(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_api_key_usage_key ON agent_api_key_usage (key_id, created_at);

CREATE TABLE IF NOT EXISTS agent_api_key_request (
  request_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  claim_sequence BIGINT NOT NULL,
  day_bucket BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES agent_api_key(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_api_key_request_sequence
  ON agent_api_key_request (key_id, claim_sequence);
CREATE INDEX IF NOT EXISTS idx_agent_api_key_request_window
  ON agent_api_key_request (key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_api_key_request_day
  ON agent_api_key_request (key_id, day_bucket);

CREATE TABLE IF NOT EXISTS agent_gateway_usage (
  request_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_slug TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER,
  tool_tokens INTEGER,
  tool_call_count INTEGER,
  provider_cost_nanodollars BIGINT,
  total_cost_nanodollars BIGINT NOT NULL,
  owner_earned_nanodollars BIGINT NOT NULL,
  platform_fee_nanodollars BIGINT NOT NULL,
  duration_ms BIGINT NOT NULL,
  settlement_basis TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_gateway_usage_agent ON agent_gateway_usage (agent_id, created_at);
