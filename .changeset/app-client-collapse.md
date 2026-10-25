---
"@tangle-network/agent-app": minor
---

Shared client pieces that products had copied: `./web` ships the typed chat-failure parsers (`parseChatHttpErrorResponse`, `parseChatStreamError`, `parseChatStreamErrorEvent`, `parseRetryAfterSeconds`) with product readiness-gap labels and per-code messages injected; `./web-react/terminal` ships `SandboxTerminalPanel`; `./web-react` ships `DurablePlanFlowCard` (the durable plan card on the auto-restoring flow, with Continue for a pending effect and Retry for a failed follow-up attach), `usePlanModeSelection` and `useModels`; `./teams/members-api` adds `getInviteDetails` and `./teams-react` adds `InviteTokenPage` for the `/invite/:token` route.

The chat-failure module also exports `buildHttpChatStreamError` and the `ChatStreamError` / `ChatStreamErrorOptions` types. `useModels` takes `{ enabled, url }` (default `/api/models`); a cache hit ends any in-flight load, a URL with no cache entry starts empty, and `reload()` bypasses the cache once.

Migrating from an app copy:
- `useModels(enabled)` becomes `useModels({ enabled, url })`.
- Pass `codeMessages` and readiness labels to every chat-error parser call; they fall back to the raw text without them.
- `SandboxTerminalPanel` defaults `isActive` to true; pass it for panels mounted while hidden. Pass `heading` and `connectionKey` where the copy used a different heading level or connection key.
- `DurablePlanFlowCard` `attachFollowUp` is `(receipt, plan, decision)`.
- `InviteTokenPage` takes `signUpPath` and `appPath`.
