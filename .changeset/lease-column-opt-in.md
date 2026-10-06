---
"@tangle-network/agent-app": patch
---

`TURN_EVENTS_MIGRATION_SQL` no longer includes `turn_status.leaseToken`. Only products that admit plan follow-ups through `createD1PlanFollowUpGate` need the column, and they apply `TURN_STATUS_LEASE_MIGRATION_SQL` once. Turn-buffer schema parity tests in other products stay unchanged.

`unwrapSessionEventPayload` also drops a replayed payload's own `type` field, as GTM's attach did.
