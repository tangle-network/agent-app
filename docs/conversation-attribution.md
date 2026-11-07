# Conversation attribution without transcript merging

`groupConversationMessages` is available from the existing browser-safe
`@tangle-network/agent-app/web` entrypoint. It is a pure L0 presentation helper:
no React, DOM, database, model loop, or provider imports.

```ts
import { groupConversationMessages } from '@tangle-network/agent-app/web'

const rows = groupConversationMessages(messagesInDisplayOrder)
for (const row of rows) {
  // Keep accessible attribution on every message, even when its visual label is hidden.
  renderMessage(row, { showSpeaker: !row.isContinuation })
}
```

Each assistant turn receives a group ID. Consecutive assistant updates, streaming
rows and `kind: 'thinking'` rows continue that group. Ordinary notices, tool rows
and progress do not create another assistant attribution. A real user message
resets it. Different `speakerId` or `conversationId` values start a new group;
provide these identities when rendering multiple agents or threads. Missing IDs
receive a display-only fallback, not a durable identity.

The helper annotates rows in display order. It does not combine content, move
messages, create timestamps, mutate inputs, change roles, or affect scheduling.
The first visible assistant row is always labeled, even if history pagination
removed the start of its turn. Run IDs are not speaker identities: a resumed run
alone does not require another label. Renderers retain original IDs and maintain
their own scroll, focus, accessibility, and streaming state.

SUPER is the reference consumer: both its operator and public chat use the same
attribution behavior. This extraction is not a claim that SUPER's custom DOM
renderer was replaced with the maintained React surface. Layout and product copy
remain application code.
