---
'@tangle-network/agent-app': patch
---

billing: `ensureKey` revokes a workspace's expired child key before minting its renewal. The platform keeps an expired child's budget reserved on the parent until revoke, and the renewal minted first, so a fully reserved parent could never renew and the expired key held its reservation forever (Creative's worker parent: $500 cap, $500 reserved, $0 spent).
