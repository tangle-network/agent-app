---
"@tangle-network/agent-app": patch
---

The identity-bound key manager hands out an active child key only while it has at least `minRemainingLifetimeMs` of life left (default `DEFAULT_MIN_REMAINING_KEY_LIFETIME_MS`, 20 min: a 15 min turn plus a 5 min margin). A turn holds its key until it ends, so a key reused with less life could expire mid-turn. Below the floor the manager mints a fresh key and retires the old one at its own expiry, the same state as a refused cleanup, so a turn still holding it finishes and the old key is never revoked under it. An app whose turns run longer than 15 min passes its own floor, which must be shorter than `keyLifetimeMs`.
