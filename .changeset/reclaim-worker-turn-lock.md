---
"@tangle-network/agent-app": patch
---

A turn lock whose turn died with its invocation (a closed tab, a runtime limit) is reclaimed by default. With the new `turnStore` and `readHolderBox` options and no product `reconcile`, `createDurableTurnLock` uses `reconcileTurnLockFromStoreAndBox`:
- An unexpired running turn on the holder's thread holds the lock. So does a session with an active execution on the box the turn ran work on, read with `readHolderBoxSessions`.
- With neither, the lock is released past the 60 s terminal grace.
- A box that does not answer within 5 s is reported unreachable, so the stale-lock policy's own bound applies, not the TTL. A store that cannot answer, and a parked release, both hold.
- The 409 diagnostics carry counts and classes only.

`readHolderBoxSessions(find)` counts only active executions: the runtime can return a finished session with no status, which the SDK reads as running. Before this, one cancel refused every turn in the lock's scope for the 30 minute TTL (Incident 3, 2026-11-16).
