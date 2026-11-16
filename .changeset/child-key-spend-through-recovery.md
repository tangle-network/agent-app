---
"@tangle-network/agent-app": patch
---

Recovery of a spend-through child-key mint replays the exact original create: the provisioning row keeps the requested budget and its placeholder id marks spend-through, so a provisioner that checks request equality under one idempotency key accepts the replay. A child counts as spend-through only when the provisioner confirms it (`spendThrough: true` in the create result; the Platform provisioner sets it when Platform granted no budget of its own). A provisioner that ignores the flag minted a sized child, which rotates when spent as before.
