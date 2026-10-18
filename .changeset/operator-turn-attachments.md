---
"@tangle-network/agent-app": patch
---

Operator API turns accept `attachments`: the `ChatAttachmentInput` list an app's attachment upload route returns. `POST /workspaces/:id/turns` validates it with the chat route's rules (`parseChatAttachmentInputs`, now exported from `/chat-routes`) and passes it to the adapter's `startTurn`; `createChatOperatorAdapter` forwards it to `runTurn`, and the generated chat app refuses it because its chat route has no attachment store.
