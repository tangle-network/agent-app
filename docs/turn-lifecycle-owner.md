# One owner for a turn's lifecycle

Status: design, with slice 1 implemented (`settleOrphanedTurns`). Owner: agent-app `/stream`.

## Problem

A product turn's state lives in five places, and each answers "is this turn still running?" differently:

| Place | Written by | Says the turn is running while |
|---|---|---|
| `turn_status` (agent-app turn store) | the turn buffer, durable observers | the row says `running`, renewed or not |
| Completion admissions (product table) | the chat route, the completion Workflow | the admission is `open` and its lease is unexpired |
| Cloudflare Workflow instance | the platform | the instance has not ended, on the script version it started with |
| Sandbox session | the sidecar | the session reports `running`, which survives a runtime restart |
| Sidecar execution ledger | the sidecar | the run is `active` |

Every settlement path joins some of these and trusts a different one. GTM's abandoned-turn sweep reads four sources in one query (messages, admissions, an analytics restart marker and `turn_status`). They drift, and on 2026-10-10 the drift was the failure:

1. **Stale running rows.** 51 `turn_status` rows stayed `running` after their Workers died; nothing ended them until a sweep was written by hand (GTM #1500, #1504).
2. **Late failure notices.** Failures were noticed 8–11 h after the turn stopped, and reported at the time they were noticed (GTM #1501).
3. **Renewal on a stale signal.** A session kept `running` across a runtime restart, so observers renewed admissions for runs the ledger had failed (agent-app #941, #943).
4. **Aborted tools counted as answers.** A run that completed after the Sandbox aborted a tool call was an answer in one place and a failure in another (agent-app #940).
5. **Workflows pinned to old code.** A settlement fix did not reach running Workflow instances, which keep the version they started on.
6. **Stops counted as failures.** A person's Stop and a failure shared one status (GTM #1481).

## Decision

The agent-app turn store is the only source of a turn's lifecycle. Every other place is evidence the store reads when it decides, never a state another component trusts.

- **One record per turn**, keyed by the turn stream id, holding: the request time, the owner and its lease, the terminal state (`answered`, `failed` or `stopped`), the terminal time, the failure code and whether Retry is offered.
- **Terminal states are written once.** A write carries the owner's lease token; a write after the lease moved, or after a terminal state, is refused. A late result from a fenced owner is kept as evidence on the record, not as a second terminal state.
- **Liveness is the lease.** An owner renews while it produces. A record whose lease expired with no terminal state is decided by the store's settlement, which reads the evidence (the session's execution ledger, then the admission) and writes one terminal state.
- **Everything else is derived.** Admissions keep their own lease for dispatch single-flight, but no sweep asks them whether a turn ended. Reports read the record: failures by request time, detection lag as terminal time minus lease expiry, Stops counted apart.

Why this rather than reconciling the five: each extra place is another writer of "done", and every incident above came from two writers disagreeing. A fenced single writer makes "exactly one terminal state" a property of the store instead of a hope about the sweeps.

## Tests: today's failures

`SETTLEMENT_SCENARIOS` in `/launch-invariants` is the acceptance set. Each product seeds them into its storage, runs its settlement, and `checkSettlementScenarios` checks the result. Every stopped scenario stopped 12 minutes before the check, so a product that settles within 15 minutes of an owner stopping has already settled it:

| Scenario | Honest end |
|---|---|
| `orphaned-stream`: running row, no owner, lease expired 12 min ago | failed, Retry |
| `abandoned-before-admission`: saved request, no admission, no stream | failed, Retry |
| `runtime-restarted`: session `running`, ledger failed with `interrupted-done` | failed |
| `completed-with-aborted-tool`: completed run, a tool `Tool execution aborted` | failed |
| `user-stop` | stopped, not counted as a failure |
| `answered` | answered |
| `live-long-turn`: owner renewing for 90 min | still open |

With settlement at lease expiry and a 15-minute cadence, the worst case is 15 minutes from lease expiry. A product that waits longer (GTM's orphan sweep waited 60 minutes) fails `orphaned-stream`.

`checkTurnSettlement` adds the cross-cutting rules: one terminal state, settlement within 15 minutes of the owner stopping, failures attributed to the request time, every failure typed and retryable.

## Slices

1. **Shared orphan settlement (this change).** `settleOrphanedTurns` in `/stream` ends every running stream nothing renewed past its 5-minute lease: a typed, retryable terminal event naming the phase it stopped in, then status `error`, written only while the row is still running and stale, without moving its update time. It returns each turn's detection lag. The store gains `listStaleRunning` and `readTail`, both bounded. Products replace their own orphan sweeps with it (GTM's `orphaned-turn-streams.ts` is the model) and schedule it alone at least every 15 minutes. Products whose durable owner does not renew the row answer `isOwned`.
2. **Fenced terminal writes.** Add `owner`, `leaseToken`, `requestedAt`, `terminalAt`, `outcome` and `failureCode` columns to `turn_status` (one additive migration that agent-app exports). `setStatus` takes the lease token; a terminal row refuses every later write. `stopped` becomes an outcome. The plan follow-up gate already fences on `leaseToken`, so it moves onto the same columns.
3. **Settlement reads the ledger, not the session.** The orphan sweep becomes the store's one settlement: for an expired lease it reads the session's execution ledger (`runs()`) as `observeNativeCompletion` does and writes the honest outcome (`interrupted-done` and aborted tools are failures). Products delete their abandoned-turn and completion-recovery joins.
4. **Derived views.** Reliability and turn-health read the record. Admissions stop answering "is it done". The sidecar tracker becomes evidence only.

Each slice ships alone and keeps the earlier behavior for products that have not adopted it.

## Cost and rollback

Slice 1 adds two optional store methods and one function; nothing calls them until a product schedules the sweep, and removing the schedule restores the previous behavior. A settled row cannot be un-settled, which is the same exposure as the hand sweeps it replaces. The guarded write leaves a stream running if its producer renewed it after the listing, but the terminal event appended just before can still land in that stream; slice 2's fence closes that gap.

Slice 2 is the risky one: a terminal fence changes what happens when a late producer finishes after its turn was declared failed. Today the late `complete` overwrites the `error`; after slice 2 the failure stands and the late answer is recorded as evidence. Products that relied on the overwrite need the late answer shown from the transcript, which they already persist.
