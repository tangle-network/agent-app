---
"@tangle-network/agent-app": minor
---

Preserve saved harness locks and reject unknown explicit selections rather than silently falling back. Add server-owned start/resume availability sets and typed HarnessSelectionError failures. Known harness identity and historical readability remain separate from deployment availability; draining harnesses may resume without accepting new sessions.
