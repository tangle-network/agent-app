---
"@tangle-network/agent-app": minor
---

Agent App now owns the plan follow-up attach that GTM, Tax, Legal and Creative each copied.
`/chat-routes` exports `planFollowUpExecutionId`, `parsePlanFollowUpAttach`, `resolvePlanFollowUpRequest`, `streamPlanFollowUpEvents` and `createD1PlanFollowUpGate`.
`/stream` exports `TURN_STATUS_LEASE_MIGRATION_SQL`.

Breaking changes:

- `planFollowUpTurnId(planId, revision, outcome)` now returns `plan:<id>:revision:<n>:<outcome>`. This is the turn id the Sandbox platform enqueues. The old `plan:<id>:<outcome>` collided across revisions and never matched the dispatched execution.
- `TURN_EVENTS_MIGRATION_SQL` adds `turn_status.leaseToken`. Run `TURN_STATUS_LEASE_MIGRATION_SQL` once on existing tables before using the follow-up gate.
- `runDetachedTurn` no longer takes `resetBuffer`. It clears a crashed turn through the new `TurnEventStore.resetEvents`, which the D1 and memory stores implement. Delete product-local `DELETE FROM turn_events` reset callbacks.

`agent-app-peer-check` gains a durability-owner gate. It fails when product source writes `turn_status` or `turn_events`, opens its own session-event replay, or mints a `plan-followup-` id. Name a product-only exception with `agent-app-durability-owner: <reason>`.
