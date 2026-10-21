---
"@tangle-network/agent-app": patch
---

`agent-app-peer-check --sync-floors` recomputes agent-app's own Tangle peer floors after an adoption moves their pins: a moved pin outside its committed floor gains one window for its own line instead of agent-eval's widened span over untested minors.
`pnpm run adopt:sync` runs it after copying the root pins into both create-agent-app templates.
