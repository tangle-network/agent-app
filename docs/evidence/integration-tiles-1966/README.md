# Hub integration tiles

Checked source `ec88ef4a` includes main `3a469194` and its account-list change. This is a synthetic Storybook consumer on Beelink2, not a connected production account. The Cards story is the unchanged default and serves as the before view. The Tiles story exercises the new host option. The Storybook decorator selects each theme.

| Viewport/theme | Default cards | Icon tiles |
| --- | --- | --- |
| Desktop 1280×850, light | [Before](cards-desktop-light.png) | [After](tiles-desktop-light.png) |
| Desktop 1280×850, dark | [Before](cards-desktop-dark.png) | [After](tiles-desktop-dark.png) |
| Phone 390×844, light | [Before](cards-phone-light.png) | [After](tiles-phone-light.png) |
| Phone 390×844, dark | [Before](cards-phone-dark.png) | [After](tiles-phone-dark.png) |

[Uncut desktop interaction](interaction-desktop-light.webm) shows both layouts, searching Telegram, opening its connection dialog with Enter, and dismissing it with Escape. No key is entered and no connection is created. Screenshots were inspected at readable scale. Provider logos are awaited before the final screenshot capture.

Beelink2 checks against the final merged source:

- `pnpm install --frozen-lockfile`, including package prepare/build, passed.
- `pnpm typecheck` passed.
- `pnpm exec vitest run src/integrations-react/integrations-react.test.tsx` passed all 28 checks.
- Browser checks at both viewports and themes passed. They assert tile geometry, no document overflow, search filtering, keyboard dialog open, and Escape close. [Geometry receipts](browser-receipt.json).
- Removing `layout={props.layout}` produced the expected geometry failure, 1.8053 ratio against the 1.5 maximum. [Negative result](negative.txt). Restoring the forwarding passed. [Restored result](restored.txt).

Scoped UI qualification was used. Full package signoff, live OAuth, live API-key submission, and Builder's published adoption are outside this record. The first browser probe used a nested Connect button locator, but the maintained tile itself is the button; its timeout was corrected to exercise the actual keyboard target.
