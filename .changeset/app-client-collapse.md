---
"@tangle-network/agent-app": minor
---

Shared client pieces that products had copied: `./web` ships the typed chat-failure parsers (`parseChatHttpErrorResponse`, `parseChatStreamError`, `parseChatStreamErrorEvent`, `parseRetryAfterSeconds`) with product readiness-gap labels and per-code messages injected; `./web-react/terminal` ships `SandboxTerminalPanel`; `./web-react` ships `DurablePlanFlowCard` (the durable plan card on the auto-restoring flow, with Continue for a pending effect and Retry for a failed follow-up attach), `usePlanModeSelection` and `useModels`; `./teams/members-api` adds `getInviteDetails` and `./teams-react` adds `InviteTokenPage` for the `/invite/:token` route.
