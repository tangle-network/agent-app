# Application line setup browser proof

The source at `b9abba2c7c46162db457875d9e419b9177785548` ran in Storybook on GTR with Chromium 153.0.8010.12 at 1100 × 850.
The fixture used the source-built Sandbox SDK from agent-dev-container #8499.
It stores one sample line in browser session storage; it does not call Hub or a provider.

In the interactive story, I nominated `owner@example.com`, set eight messages per day, confirmed delegation, and connected the sample mailbox.
I reloaded the browser tab and observed the same answering line and conversation.

![Saved line after browser reload](application-line-reopened.png)

I opened the disabled-grants story, disconnected the saved line, and observed the empty state without a connect form.
The disabled state keeps the disconnect action available while the line exists.

![Disconnected line with new grants disabled](application-line-disconnected.png)

This proves the rendered browser flow and browser-session persistence of the fixture.
It does not prove a native attachment, live provider delivery, or a completed application task.
