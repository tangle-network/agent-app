---
"@tangle-network/agent-app": patch
---

Add `isSandboxApiTransientFailure`: a 500, 502, 503 or 504 from a Sandbox API control-plane route, such as `A sandbox backend did not answer` on a list or `Failed to resume project: fetch failed`, excluding runtime routes, missing boxes, box configuration and host capacity. Products can retry these once. `formatSandboxProvisioningUserMessage` now tells the user to send the message again for these, and its generic fallback no longer claims the sandbox service is not configured.
