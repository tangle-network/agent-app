---
"@tangle-network/agent-app": patch
---

`agent-app-signoff` browser checks count only requests that reach the network. 0.60.148 counted Playwright's `request` event, which also fires for responses the browser serves from its own cache, so a run whose bundles all came from cache still reported about 1900 requests and failed `FAIL network` (creative smoke, every deploy). `meterPage(page, meter)` replaces `meterContext`: it reads Chromium's `Network.responseReceived` and skips memory-cache, disk-cache, prefetch-cache and service-worker responses; a 304 revalidation still counts. New export `reachedNetwork`. A real-Chromium test checks the meter against what a local server receives.
