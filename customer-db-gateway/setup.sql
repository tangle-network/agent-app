-- Run once as your database administrator. It creates:
--   1. tangle_gateway_audit: one row for every call the agent makes, readable by you, append-only for the gateway;
--   2. tangle_agent: the login the gateway uses, with access to nothing until you grant it.
-- Replace the password, then grant only the tables your operations need (example at the end).

CREATE TABLE IF NOT EXISTS tangle_gateway_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  request_id  text        NOT NULL,
  token_id    text        NOT NULL,
  operation   text        NOT NULL,
  access      text        NOT NULL CHECK (access IN ('read', 'write')),
  arguments   jsonb       NOT NULL,
  outcome     text        NOT NULL CHECK (outcome IN ('ok', 'error')),
  row_count   integer,
  error       text,
  duration_ms integer     NOT NULL,
  client_ip   text
);
CREATE INDEX IF NOT EXISTS tangle_gateway_audit_at ON tangle_gateway_audit (at DESC);

DO $$ BEGIN
  CREATE ROLE tangle_agent LOGIN PASSWORD 'replace-me' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The gateway may add audit rows but never read, change or delete them.
REVOKE ALL ON tangle_gateway_audit FROM tangle_agent;
GRANT INSERT ON tangle_gateway_audit TO tangle_agent;
GRANT USAGE ON SEQUENCE tangle_gateway_audit_id_seq TO tangle_agent;

-- Example grants for examples/operations.json. Grant column by column where you can:
--   GRANT SELECT (id, vendor_name, amount_cents, currency, hours, description, status, created_at) ON vendor_invoices TO tangle_agent;
--   GRANT INSERT (vendor_name, amount_cents, currency, hours, description) ON vendor_invoices TO tangle_agent;
--   GRANT USAGE ON SEQUENCE vendor_invoices_id_seq TO tangle_agent;
--
-- To cut the agent off at the database: ALTER ROLE tangle_agent NOLOGIN; then restart the gateway,
-- because NOLOGIN refuses new connections but leaves its open pooled connections running.
