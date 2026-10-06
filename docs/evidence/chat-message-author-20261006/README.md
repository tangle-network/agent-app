# ChatMessages with several people

The `Chat/ChatMessages` stories `Multi-party (client view)`, `Multi-party (attorney view)` and `Quiet multi-party` render `ChatMessages` with one intake thread: a client (Maria Lopez), an attorney (Jane Doe) and the agent.

Captured with Playwright 1.63 Chromium from a static Storybook build on beelink2-wsl, at 1280px (1x) and 360px (2x), full page, in the `agent-light` and `agent-dark` themes. No capture had horizontal overflow.
The after images are from fe203f24.
The before images are the same stories, built from the same tree with `src/web-react/index.tsx` taken from main (4586a5e7). That version ignores `author`, so the attorney's messages render as the client's.

| File | Shows |
| --- | --- |
| `before-multi-party-*` | Every human message is a right-aligned "USER" bubble; Jane cannot be told from Maria. |
| `after-multi-party-*` | Maria's messages keep the "USER" label and inverse bubble. Jane's sit on cards under her avatar, name and "Attorney" tag. The agent's name and "AI" tag replace the "AGENT" label, next to the model meta. |
| `after-multi-party-attorney-view-agent-light-360` | The same thread on Jane's screen: her messages move to the right and Maria is named. |
| `after-quiet-multi-party-agent-dark-360` | Quiet chrome keeps every name except the reader's. |
