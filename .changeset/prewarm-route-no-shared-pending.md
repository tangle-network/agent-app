---
'@tangle-network/agent-app': patch
---

Prewarm: the route answers `joined` at once instead of awaiting another request's warm (a cancelled request left it unsettled, and later prewarms hung 43-45 s); a warm older than `staleMs` (45 s) no longer blocks its key. `useWorkspacePrewarm` sends `{ reason: 'page-open' | 'composer-focus' }`, and `authorize` receives it.
