---
"@tangle-network/agent-app": patch
---

`agent-app-signoff` `workspace-surface`, `shell-alignment` and `surface-ladder` stay inside the shared edge limit when run against a live site: Chromium runs with prerender and speculative prefetch off, the zone's `/cdn-cgi/speculation` rules are aborted, each context's requests are counted and a navigation waits while the last 10 s already holds 250, and every report prints its request total and busiest 10 s (`report.network`).
