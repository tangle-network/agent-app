---
"@tangle-network/agent-app": patch
---

A Platform delegation answer that is a decision about the request (a non-authorization 4xx such as `400 DELEGATION_FAILED`) now comes back as `delegated_key.failed` with Platform's status and its `platformCode`, instead of `403 delegated_key.refused`. Only 401 and 403 are refusals. Platform's message is still never carried.
