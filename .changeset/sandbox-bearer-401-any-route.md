---
"@tangle-network/agent-app": patch
---

`isSandboxApiBearerAuthFailure` now matches a 401 from any Sandbox API route, including list and query routes such as `/v1/sandboxes?status=stopped`. Before, only `/v1/sandboxes/{id}` routes matched, so a product whose cached key was replaced never re-minted when the rejection came from a list call. Runtime routes stay excluded.
