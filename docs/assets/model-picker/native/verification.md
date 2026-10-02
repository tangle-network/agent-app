# Native verification — 2026-10-02

PR 761 was reviewed at `68d6455c`, with evidence commit `65cb6771` retained.
Current main `bd6418be` merged cleanly; checked source is `afb06ed9`.
The only native follow-up limits content remeasurement to the model picker through an optional `PopoverSurface.contentKey`.
Other popovers retain their existing placement lifecycle.

Beelink2: Node 24.21.0, pnpm 11.24.0, Chromium from the maintained Playwright installation.

- PASS frozen install with scripts enabled, package build, and `pnpm typecheck`.
- PASS 40 tests collected in the five focused picker, popover, and AgentSessionControls suites.
- PASS `pnpm build-storybook` and [15 native browser checks](results.json) against that build.
- PASS calibrated focus regression: removing selection focus restoration fails both chip and quiet tests at the focus assertion; restoring it passes both.
- PASS source review: saved IDs remain controlled; no request implementation, ID normalization, harness policy, or provider eligibility change.

The browser check covers failure → retry → loading → results, saved-value retention, search geometry without focus loss, Tab/Shift+Tab, Enter/Space, Escape, disabled controls, inline/compact/locked session controls, and long names at 1440, 1280, 390, and 320 pixels in light/dark themes.
[Failure state](recovery-failure.png) and [320px dark menu](long-320-dark.png) were opened and visually inspected.
The reproducible script is [browser-check.mjs](browser-check.mjs); its installed Playwright path and local Storybook URL are host-specific.
Full captures and uncut video remain in `/tmp/picker761-native-browser` on Beelink2.

These checks establish local source and rendered Storybook behavior.
They do not establish publication, assistive-technology compatibility, or Builder persistence; the separately owned consumer verification follows publication.
Full signoff, generated-template checks, and unrelated suites were omitted under the authorized scoped local gate.
