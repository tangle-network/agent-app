---
"@tangle-network/agent-app": patch
---

A turn lock whose holder ran in its Worker is reclaimed by default. The routes record on the lock whether the selected producer runs in this Worker (the Router lane), and `createDurableTurnLock` takes a `turnStore`: with it and no product `reconcile`, a refused acquire reclaims such a holder once its thread has no unexpired running turn, past the 60 s terminal grace (`reconcileWorkerTurnLock`). The default route lock passes the routes' turn store. A holder a box may outlive, a parked release and a store that cannot answer all hold; sandbox lanes keep their product box and session probes. Before this, one cancelled invocation (a closed tab, a runtime limit) refused every turn in the lock's scope for the 30 minute TTL (Incident 3, 2026-11-16).
