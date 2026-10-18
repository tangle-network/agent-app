---
"@tangle-network/agent-app": patch
---

Operator API turns accept `attachments`: the `ChatAttachmentInput` list an app's attachment upload route returns. `POST /workspaces/:id/turns` validates it with the chat route's rules (`parseChatAttachmentInputs`, now exported from `/chat-routes`) and passes it to `startTurn` of an adapter that sets `acceptsAttachments: true`, which `describe` reports as the `turns.attachments` capability. Any other adapter answers 501 `operator.unsupported`, so existing adapters never drop files silently. `createChatOperatorAdapter` takes the same option and forwards the list to `runTurn`.
