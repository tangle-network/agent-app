---
"@tangle-network/agent-app": patch
---

`createSandboxVaultSync` gains the options GTM's box↔Vault sync needs, so GTM can delete its copy: a deletion policy (`deletes: { guard }` keeps GTM's mass-deletion guard; rename-only stays the default), `exclude`, a `writeText` hook, an `afterWrite` hook, a per-call copy budget with a `deferred` result, `skipFilesAlreadyOnBox`, `skipOversizeFiles` (recorded in `skipped`), and `provenance`, `onPhase`, `onStage` and `canonicalPathsOnly` on a call. Hydration can leave the warm-path decision and the sync record to its caller (`recordSync: false`).

Reconcile records a box copy the Vault already holds (`convergedChanges`), or an earlier revision of it, instead of parking a conflict. Fixed for every product: a sync root that is a hidden directory listed no files; a binary the box changed did not clear the warm-path record; a walk dropped the on-disk hash of an unchanged binary; a pass whose deletes were refused no longer rewrites the baseline; and a failed warm-record invalidation now fails the reconcile instead of being logged.
