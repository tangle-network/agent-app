---
"@tangle-network/agent-app": patch
---

A workspace child-key mint that dies after Platform's create, before its row records the key, no longer blocks that member's issuance until the key expires. The mint now writes its remote name into the placeholder key id (`provisioning:<operation>:<name>`) before the create, so the next `ensureKey` from any process finds the half-created key by that name, revokes it (no turn can hold a key whose create never returned) and mints a fresh one. This works for every store, including one without a `name` column, and no consumer has to rebuild the name: `legacyNameForRecord` is now needed only for rows written before this release.
