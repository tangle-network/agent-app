# Line setup choice display proof

The prior [application setup screenshot](../../docs/proofs/application-line-verification-waiting-mobile.png) shows the empty Lines section and two one-option selects ahead of phone verification.
The changed [mobile application setup](application-mobile-dark.png) shows the owned iMessage identity and conversation as values.
The [desktop single-choice state](single-desktop-light.png) shows the same behavior for an email line.
The [multiple-choice state](multiple-desktop-light.png) keeps both selectors and visible keyboard focus.
The [mixed-channel state](email-mobile-dark.png) labels the selected identity as Email via Owned Inkbox, despite sharing `@research` with iMessage.

Local Storybook ran at `http://127.0.0.1:6317` on Node 24.18.0.
Playwright Chromium opened the actual Storybook iframe at 390 and 900 CSS pixels.
The single-choice states had zero comboboxes and no empty Lines heading.
The multiple-choice state had two comboboxes; Home selected `conn_inkbox:0`, ArrowDown selected `conn_support:0`, and the target remained `agent_support`.
In the application story, Start phone test, two verification checks, Connect iMessage, reload, and Disconnect succeeded.
The [reopened state](application-reopened-mobile-dark.png) retained its Disconnect line action.
After disconnect, that action disappeared and focus returned to Connect a line.

The three focused component tests failed against the unchanged source before the patch.
After the patch, all three passed and `pnpm run typecheck` passed.
These Storybook fixtures prove the shared component behavior; they do not exercise a real provider or Builder deployment.
