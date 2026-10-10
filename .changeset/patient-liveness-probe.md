---
"@tangle-network/agent-app": patch
---

Give a reused box one longer liveness probe (30 s) before a state-preserving restart. The restart ends every session on the box, and on 2026-10-10 a GTM box that was busy with other conversations missed the 5 s probe twice, so two restarts ended nine running turns. A box that answers the longer probe is kept; one that does not is restarted as before.
