---
"@tangle-network/agent-app": patch
---

A turn lock whose turn died with its invocation (a closed tab, a runtime limit) is reclaimed by default. Give `createDurableTurnLock` the new `turnStore` option (it must implement `listRunning`) and no product `reconcile`, and a refused acquire runs `reconcileTurnLockFromStoreAndBox`:
- An unexpired running turn on the holder's thread holds the lock. With the optional `readHolderBox` (`readHolderBoxSessions` from `/sandbox`), so does a session with an active execution on the box the turn ran work on; without it, no box is read.
- With neither, the lock is released past the 60 s terminal grace, so a turn must write its running row within 60 s of taking the lock. The chat routes write it at acquire, before `contextGate` and `beforeTurn`, and settle it on every release before the turn's stream starts.
- A turn handed to a durable completion owner (`handoffCompletion`) parks its lock, so it reads as held after the route stops renewing the row; the owner's release of the exact lock completes it.
- The routes' default lock (`createDefaultTurnLock`, from bindings or env) reads the D1 store the routes renew in, so it reclaims by default; a product that passes its own turn store keeps today's lock.
- A lock taken with durable Stop (`cancellationOf`) is judged by the owner rule on the same evidence: no running turn and no box work is abandoned and released past the same grace; an unanswered read is unknown and holds.
- A box that does not answer within 5 s (`box_read_timeout`) or fails its read (`box_unreachable`) sends a native lock to the stale-lock policy's unreachable bound, not the TTL. A store that cannot answer, and a parked release, both hold.
- The 409 diagnostics carry counts and classes only; failed reads are logged server-side by class.

`readHolderBoxSessions(find)` counts only active executions, by the sidecar's `hasActiveExecution` verdict: the runtime can return a finished session with no status, which the SDK reads as running. A session from an older sidecar without that verdict counts its `activeExecutionId`, and that fallback is logged.

`reconcileStaleTurnLock` now reads its clock once, before any probe, for every branch: the unreachable branch no longer measures the lock's age or fences its release after a slow probe.
