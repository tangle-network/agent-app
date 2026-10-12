---
"@tangle-network/agent-app": patch
---

Expose the codec-parsed persisted draft through VaultPane's existing artifact seam so document editors can distinguish saved content from live edits. Keep writes single-flight, retain failed and newer drafts, and reject stale or read-only save and restore callbacks.
