# Chat-first default proof

These captures exercise the composed Agent App Storybook examples.
They do not prove a deployed product's authenticated conversation flow.

Execution target: `drew-gtr-pro`, Node 24.18.0, headless Chromium at `/usr/bin/google-chrome`.
Before source: `c5f8807d`.
After source: the story changes in this pull request.

| State | Desktop | Mobile |
| --- | --- | --- |
| Before, dark | [Capture](./before-desktop.png) | [Capture](./before-mobile.png) |
| Default, dark | [Capture](./desktop-default.png) | [Capture](./mobile-default.png) |
| Default, light | [Capture](./desktop-light.png) | [Capture](./mobile-light.png) |
| Optional actions | [1024px capture](./narrow-desktop-actions.png) | [Open menu](./mobile-actions-menu.png) |

The [execution receipt](./conditional-receipt.json) covers callbacks present and absent at 1024, 1280, and 390 pixels.
The transcript container starts at the top edge in every case.
Optional controls clear the first message by 48 pixels.
Keyboard Share opens its fixture panel; pointer Chat actions opens its fixture panel.
Both panels close through their Close control.
Mobile navigation opens with Enter and closes through its backdrop.
No page errors occurred.

The fixture panels test callbacks; they do not send a conversation or modify product settings.
The default examples omit those controls when callbacks are absent.
The rendered examples contain no repeated title, synthetic prompt, or fabricated connection indicator.
