---
'@tangle-network/agent-app': patch
---

app-auth: share only resolved sessions across requests in an isolate. A read in flight was shared, so when the request that started it was cancelled, every other request with the same cookie hung until its client gave up (20 s in Hospitality production).
