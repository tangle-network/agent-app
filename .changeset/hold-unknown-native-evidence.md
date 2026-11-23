---
"@tangle-network/agent-app": patch
---

Add `unknownEvidencePolicy: 'hold'` to native stale-turn reconciliation and the default durable turn-lock adapter. Failed or unreachable holder observations then retain the lock; positive absent/stopped boxes and terminal sessions keep their existing recovery rules. The default fallback and Router owner policy are unchanged. This policy controls explicit reclaim and does not extend the lock's lease.
