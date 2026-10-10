-- Example business table for operations.json. Your real tables stay as they are.
CREATE TABLE IF NOT EXISTS vendor_invoices (
  id           bigserial PRIMARY KEY,
  vendor_name  text        NOT NULL,
  amount_cents bigint      NOT NULL CHECK (amount_cents >= 0),
  currency     text        NOT NULL,
  hours        numeric,
  description  text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
