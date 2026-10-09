---
"@tangle-network/agent-app": minor
---

Email digests take titled sections: `digestEmail` now accepts `headline` and `sections` (each a heading and items; empty sections are left out) instead of one `items` list. A footer `unsubscribeUrl` adds an Unsubscribe link and the RFC 8058 one-click headers, returned on the new `EmailMessage.headers`; pass them to the mail client.
