---
"@tangle-network/agent-app": patch
---

`createSandboxVaultSync` gains the options GTM's box↔Vault sync needs, so GTM can delete its copy: a deletion policy (`deletes: { guard }` keeps GTM's mass-deletion guard; rename-only stays the default), `excludeDirs` (pruned from the scan), a `writeText` hook, `skipFilesAlreadyOnBox`, `skipOversizeFiles` (recorded in `skipped`), and per call `provenance`, `onPhase`, `onStage` and `canonicalPathsOnly` on reconcile and `progress` (a copy budget with a `deferred` result, plus the paths written, shared across a retry), `onStage` and `recordSync: false` on hydrate.

Behavior changes for every product: reconcile records a box copy the Vault already holds (`convergedChanges`, optional on the result) or an earlier revision of it, instead of parking a conflict or re-creating it; a failed warm-record invalidation now fails the reconcile instead of being logged; under the deletion guard, a pass whose deletes were refused leaves the baseline untouched. Fixed: a sync root that is a hidden directory listed no files; a binary the box changed did not clear the warm-path record; a walk dropped the on-disk hash of an unchanged binary.
