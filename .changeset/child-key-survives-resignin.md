---
"@tangle-network/agent-app": patch
---

A workspace child key survives the same member's next sign-in. The identity-bound key manager matched the active child on the source credential too (`sourceKeyId`, `sourceKeyFingerprint`). Every sign-in presents a new one, so a second sign-in revoked the child that a running reply held, and the reply died on its next Router call (Incident 3, 2026-11-16). An active child is now reused when its workspace, owner, product and Platform user match (`sameOwner`). Recovering a half-provisioned row still requires the exact minting source. A different Platform user still gets a new key. A read-back that cannot answer neither rotates nor revokes.
