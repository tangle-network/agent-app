---
"@tangle-network/agent-app": minor
---

Peer the 1.0 stack with one caret each: `@tangle-network/agent-eval` `^1.0.0`, `@tangle-network/agent-runtime` `^1.0.0`, `@tangle-network/sandbox` `^1.0.1`, `@tangle-network/hub-sdk` `^1.0.2`, `@tangle-network/agent-profile-materialize` `^1.0.0`, `@tangle-network/sandbox-ui` `^1.0.0`, `@tangle-network/agent-knowledge` `^23.0.0` and `@tangle-network/agent-interface` `^5.9.0`. The long `||` unions over 0.x windows are gone, so an app adopts a later compatible leaf release without an agent-app release. Apps on agent-eval 0.22x, Sandbox 0.69 or Runtime 0.35x stay on agent-app 0.63. The retained agent-eval 0.204-0.220 compatibility lines and their `test:eval-compat` suite are deleted with the peers that admitted them.

Every relative specifier in the published declarations is now an explicit `.js` path (`export * from './chat-message-types.js'`). A NodeNext consumer such as super-agent previously resolved none of the extensionless ones, so `@tangle-network/agent-app/web-react` exported no `ChatMessageSegment`, `ChatToolCallInfo` or `ChatUiMessage`, and the same held for every barrel not hand-written with `.js`. The build rewrites the specifiers after `tsc` and fails on one it cannot resolve, and one packed-archive NodeNext consumer test replaces the two that copied `dist/`.
