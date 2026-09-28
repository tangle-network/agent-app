# Hosted line UI browser proof

The Builder launch page mounts `LineSetup`, `LineMembers`, and `LineBilling` from agent-app.
These captures show the integration in a local production build with harness authentication and an intercepted line API.
The API fixture supplies an owned email connection, one agent, a member, and allowance data.
This is visual and workflow evidence; it does not prove a Hub or provider turn.

Source for the refreshed Builder fixture: agent-app `4644733` tarball and Builder `7ef314c`.
The tarball SHA-256 was `29a1d0ebcd8e144bfdd64cf8257c5d880c36f772442b584cc02e7f4b4d14f730`.
Target: Chromium at `http://127.0.0.1:8807/app/launch/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, with a local harness cookie.
The route is not a public deployment.

| Viewport | Before | After setup | Members and billing | Detached and reconnect |
| --- | --- | --- | --- | --- |
| Desktop | [Before](before/desktop/launch-lines.png) | [Lines](after/desktop/launch-lines-top.png) | [Members](after/desktop/launch-lines-members.png) | [Reconnect](after/desktop/launch-lines-disconnected.png) |
| Mobile | [Before](before/mobile/launch-lines.png) | [Lines](after/mobile/launch-lines-top.png) | [Members](after/mobile/launch-lines-members.png) | [Reconnect](after/mobile/launch-lines-disconnected.png) |

The browser started with no attached line, connected the fixture's owned email identity, and claimed its verified owner address.
The UI then showed one answering line, an invited member awaiting sender consent, and an unverified line payer.
Disconnect stopped answering; reloading showed the detached line and a `Reconnect Email` action for the same identity.
The fixture kept that state during the local browser flow only.

The [desktop uncut WebM](after/desktop/workflow-visual-fixture.webm) records 13.16 seconds of browser interaction.
The [mobile uncut WebM](after/mobile/workflow-visual-fixture.webm) records 12.92 seconds.
The [desktop 2× MP4](after/desktop/workflow-visual-fixture-2x.mp4) and [mobile 2× MP4](after/mobile/workflow-visual-fixture-2x.mp4) are fast playback copies (6.68 and 6.56 seconds).
All videos start after server boot and harness authentication; they stop after the browser reload.
All four videos decode without errors and played in Chromium; playback advanced in each file.

Separate browser passes captured [desktop loading](after/desktop/launch-lines-loading.png), [empty](after/desktop/launch-lines-empty.png), and [503 error](after/desktop/launch-lines-error.png) states.
Equivalent [mobile loading](after/mobile/launch-lines-loading.png), [empty](after/mobile/launch-lines-empty.png), and [503 error](after/mobile/launch-lines-error.png) captures are included.
The error showed `Lines could not be loaded.` and Retry recovered.
Keyboard focus moved to the Disconnect confirmation action.
The [desktop browser log](after/desktop/browser-check.json) and [mobile browser log](after/mobile/browser-check.json) report no page exceptions.
The desktop primary flow recorded no browser errors; the mobile flow aborted one launch read during navigation.
The error-state passes intentionally emitted a 503 console entry, and the mobile pass also aborted one launch read.

The fixture did not exercise live Hub workspace enforcement, payment routing, provider delivery, durable member consent, or the production answered-turn path.
Those require the Hub, delegated-key, SDK, Builder release, and owned-mailbox gates tracked in the lines handoff.

## Maintained Storybook states

The `Hosted agent/Lines` stories now cover setup, members, billing, empty, loading, error, disconnect confirmation, and two reconnect identity cases.
These captures come from this branch's production Storybook build in headless Chromium at 1000 × 760.
They are visual fixtures, not provider or Hub proof.

| Theme | Setup | Members | Primary button | Active status | Invited status |
| --- | --- | --- | ---: | ---: | ---: |
| Dark | [Screenshot](storybook/story-setup-dark.png) | [Screenshot](storybook/story-members-dark.png) | 6.27:1 | 10.27:1 | 10.03:1 |
| Light | [Screenshot](storybook/story-setup-light.png) | [Screenshot](storybook/story-members-light.png) | 6.09:1 | 4.54:1 | 4.96:1 |

The [browser check](storybook/browser-check.json) records computed colors, contrast, reconnect choices, and button states.
No page exceptions occurred across these stories.
The disconnect confirmation story rendered its action and moved keyboard focus to Disconnect.
For two numbers on one WhatsApp connection, only the detached line's provider number appeared as a reconnect choice.
In the manual-number story, an empty or different ID kept Reconnect disabled; the exact ID enabled it.

The [retry and focus browser check](storybook/retry-focus-check.json) exercises keyboard confirmation and recovery after a successful write with a failed next read.
The browser showed [setup Retry](storybook/story-refresh-error-setup.png) and [member Retry](storybook/story-refresh-error-members.png) while stale mutation actions were disabled.
Retry recovered connect, disconnect, and invite views without a page exception.
Keep returned focus to the original trigger for both confirmation types.
After a successful disconnect or removal deleted that trigger, focus moved to the section heading.
