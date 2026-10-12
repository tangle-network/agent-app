---
"@tangle-network/agent-app": patch
---

`create-agent-app` chat template ships `web/public/_headers`, so a new app serves its content-hashed `/assets/*` bundles with `Cache-Control: public, max-age=31536000, immutable` (Workers Static Assets reads `_headers` from `dist/client`). Live agent apps served them `public, max-age=0, must-revalidate`, so every visit revalidated about 110 bundles. `index.html` keeps revalidating, so a deploy is picked up on the next load. `vite.config.mjs` now copies `web/public` (`publicDir: 'public'`).
