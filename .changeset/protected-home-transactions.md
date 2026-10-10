---
"@tangle-network/agent-app": patch
---

Require the current `expectedHead` for protected-home whole-file writes and deletions, and update the shipped tools, instructions and disposable proof together. Stale or missing revisions are refused before new mutation. Preserve atomic append semantics with explicit unconfirmed-retry guidance, validate complete pending journals before replay, and fsync deletion and journal-cleanup directories.

For applications that already opt into protected homes, add trusted identity binding and locked portable snapshot/reconcile operations using the existing fixed paths, Git and journal. Snapshot receipts attest exact local committed bytes and range-scoped deletion history since an immutable base; they do not attest remote durability. Native harness memory defaults and optional provider choices are unchanged.
