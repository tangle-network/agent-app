---
"@tangle-network/agent-app": patch
---

A workspace child key survives the same member's next sign-in when the app uses agent-app's own provisioner (`createDelegatedKeyProvisioner`). The identity-bound key manager matched the active child on the source credential too (`sourceKeyId`, `sourceKeyFingerprint`). Every sign-in presents a new one, so a second sign-in revoked the child that a running reply held. An active child is now reused when its workspace, owner, product and Platform user match. A different Platform user still gets a new key, and the old child is revoked at once. A read-back that cannot answer neither rotates nor revokes.

Cleanup acts through the child's own slot. `DurableWorkspaceKeyProvisioner.revokeKey(id, slot?)` receives the row's name, minting source and Platform user, and `createDelegatedKeyProvisioner` retires a child minted under an earlier source through `/v1/keys/auto-provisioned/revoke-slot` with that source, never the current one. A refused cleanup no longer blocks issuance: a child that Platform reports gone, spent or expired is retired at once, and a live one is retired at its own expiry. A transient failure still blocks issuance until a retry succeeds. `getKey` now reads every permanent `invalidReason` as gone (`key_hierarchy_too_deep`, `team_member_unrecorded`, `attribution_unresolved`, `billing_account_missing`, `account_not_found`, `product_mismatch`, `key_attribution_missing`, `key_provisioner_unknown`, `key_name_not_product_specific`), so the next use mints a fresh key.

An app whose own provisioner reads the child back with the source key, rather than by id, still rotates the child on each sign-in until that provisioner changes.
