---
"@tangle-network/agent-app": patch
---

Remove expired Radix overrides from generated chat projects so the release-age resolver preserves each package's declared compatible internal dependencies. This fixes production builds where popover 1.2.0 requires focus-scope exports absent from the previously forced 1.1.16, while retaining the 72-hour release hold, strict peer checks, and zod pin.
