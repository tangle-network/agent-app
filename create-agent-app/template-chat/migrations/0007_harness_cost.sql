-- cost_usd is the Platform ledger charge; this is the harness's own reported token cost.
ALTER TABLE message ADD COLUMN harness_cost_usd REAL;
