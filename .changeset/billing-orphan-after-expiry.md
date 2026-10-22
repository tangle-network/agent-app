---
'@tangle-network/agent-app': patch
---

billing: a durable provisioning row with no remote child is marked orphaned once its key expiry (plus 5 minutes of clock skew) has passed. Before, a create that crashed on a non-idempotent provider stayed revocation_pending forever, and because issuance refuses while cleanup is pending, that owner could never get a key again. Before expiry the recovery fence is unchanged.
