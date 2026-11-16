---
"@tangle-network/agent-app": minor
---

`createChatTurnRoutes({ redactValues })`: a product registers the secret values a turn could expose (a credential it placed in its box's environment). Every occurrence becomes `[redacted]` in the live stream, the turn buffer, the draft and the stored row. Matching is by value, never by pattern; values under 8 characters are ignored. `valueRedactor` is exported so a product can redact its own history reads the same way. Before this, a credential that an agent wrote into a tool call was streamed and stored as written.
