# Integration account cards

Source: `35662143a29b538234bf8e2f440f23ce0b0ba39e`; baseline `804b327ad0185b309dc6e983c9d7e68632684473` plus the same 24-account fixture.
Target: source Storybook `integrations-hub-catalog--many-accounts`, Beelink2 Chromium. These are fictional accounts and in-memory host callbacks, not production credentials or backend persistence evidence.

| View | Before | Accounts | Add integration |
|---|---|---|---|
| Desktop, 1280 × 850, light | [Before](before-desktop-light.png) | [Accounts](accounts-desktop-light.png) | [Catalog](catalog-desktop-light.png) |
| Desktop, 1280 × 850, dark | [Before](before-desktop-dark.png) | [Accounts](accounts-desktop-dark.png) | [Catalog](catalog-desktop-dark.png) |
| Phone, 390 × 844, light | [Before](before-phone-light.png) | [Accounts](accounts-phone-light.png) | [Catalog](catalog-phone-light.png) |
| Phone, 390 × 844, dark | [Before](before-phone-dark.png) | [Accounts](accounts-phone-dark.png) | [Catalog](catalog-phone-dark.png) |

All images opened and inspected. The catalog previously started at y=1677 desktop /3465 phone; it now starts at y=192 /264 after one tab click. Four browser journeys verified all 24 accounts, long names, search including no matches, pointer and keyboard tab changes, no horizontal overflow, enable → manage → remove → reopen, and no page errors.

[Uncut phone dark recording](flow-phone-dark.webm): captured by Playwright; Chrome opened the video and its first frame was inspected, but the playback click timed out and then the browser-control session reset. Full playback remains **unchecked**. This video demonstrates fixture state, not durable writes. Original recordings for all four journeys are retained under the owner’s `~/.local/state/agent-work/account-cards-1966/after/`.

Existing upstream limitation: Resend’s black icon is low contrast in the dark catalog. Its visible text label remains readable; this change does not alter Sandbox UI's provider icon registry.

Beelink gate: frozen install, typecheck, 99 affected integration/Vault tests, build. Negative probe disabled tab selection and restored the bad modal label: tests failed; restoring source passed all 99. Full runtime sign-off was not run for this scoped UI change. Builder adoption separately verifies durable per-agent access through its actual local Worker and D1.
