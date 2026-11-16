---
"@tangle-network/agent-app": patch
---

The identity-bound key manager now gives every minted child key its own remote name. Platform holds one key per name, and a create under a name already held revokes the key holding it. With a stable `nameForIdentity`, the replacement minted below the reuse floor revoked the old key while a turn still held it. The manager now appends the mint's operation id when the configured name lacks it. Names that already contain the operation id, including the default, are unchanged. Each row stores the name it minted, and recovery and revoke read that stored name.
