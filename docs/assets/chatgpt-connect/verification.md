# ChatGPT connection UI verification — 2026-10-02

The optional `chatgpt-react` export provides one shared Connect to ChatGPT surface.
GTM and Creative installed examples reuse it with distinct kit metadata and native
enrollment identity fixtures. This is local installed-package/browser evidence,
not a claim that either fixture is connected to ChatGPT or publicly listed.

## Source and package

- Base: `0e4eb71c` (Agent App 0.51.16, including model-picker PR #761).
- Component source: `ca46454c`; final evidence commits only retain artifacts.
- Beelink1 checkout: `/home/drew/code/_wt/agent-app-chatgpt-connect-20261002`.
- [Installation receipt](installation.json) records the full source commit,
  tarball SHA-256, installed version, scratch consumer and browser input graph.
- `npm pack` ran the existing prepare/build hook. A fresh npm consumer installed
  that tarball with React 19.2.8, UI 11.12.0, Brand 1.10.0 and agents kit 0.1.0.
  The kit's real metadata factory produced both public configurations.
- The public component/style/Brand imports bundle for browsers without native
  enrollment, Sandbox, agent-runtime or OAuth runtime code. Enrollment is a
  type-only reference. No dependencies or lockfile entries changed.

## Checked gate and stop condition

The scoped gate was current-base merge, frozen Beelink install, package
build/typecheck, affected tests, and a real installed consumer/browser pass.

- `pnpm install --frozen-lockfile`: pass; existing prepare hook built the package.
- `pnpm typecheck`: pass.
- Focused Vitest run: 57 tests across the new component, browser-safe subpaths,
  export/Knip-entry freshness and test-quality gates, all passing.
- `pnpm knip`: pass (existing configuration hints only).
- `pnpm docs:gen`: generated public API/CODEMAP files with the maintained tool.
- Five deliberate regressions failed their focused tests: retaining setup on an
  enrollment switch; inferring connected state; accepting a non-ChatGPT registered
  destination; exposing native details by default; and mislabelling the generic
  Plugins destination. Source was restored; all eight component tests passed.
- Fresh installed consumer typecheck and browser bundle: pass.
- Browser: both apps × light/dark × 1440/390 widths, eight passing combinations.
  Keyboard activation, native details disclosure, exact URL copying, controlled
  checking/error recovery, no inferred connection, and no horizontal overflow.
  Eight WCAG 2 A/AA and 2.1 AA Axe scans: zero violations; zero page errors.
- 15 screenshots and two original-speed recordings (2.60 and 2.64 seconds) retained and
  visually inspected. The initial dark example applies its theme before paint.

[Browser receipt](browser-proof.json) contains the measured state. Raw command
outputs are under [logs](logs/). Full source signoff, randomized whole-package
suites, generated scaffold matrices and Storybook's full build were not run for
this scoped optional UI change. No PR CI or hosted Codex review was awaited.

## Media

- [GTM desktop dark initial](gtm-dark-1440-initial.png)
- [Creative mobile light initial](creative-light-390-initial.png)
- [GTM desktop light setup](gtm-light-1440-setup.png)
- [GTM desktop dark setup](gtm-dark-1440-setup.png)
- [GTM mobile light setup](gtm-light-390-setup.png)
- [GTM mobile dark setup](gtm-dark-390-setup.png)
- [Creative desktop light setup](creative-light-1440-setup.png)
- [Creative desktop dark setup](creative-dark-1440-setup.png)
- [Creative mobile light setup](creative-light-390-setup.png)
- [Creative mobile dark setup](creative-dark-390-setup.png)
- [Native connection details](connection-details.png)
- [Checking](creative-checking.png), [host-confirmed state fixture](creative-connected.png),
  [error](creative-error.png), [supplied-link fixture](registered-link-fixture.png)
- [GTM original recording](gtm-dark-1440-original.webm)
- [Creative original recording](creative-light-390-original.webm)

## Boundaries and handoff

The [current OpenAI guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
was checked on 2026-10-02: Security and login → Developer mode; ChatGPT Plugins →
plus; name/description/public MCP URL; sign-in/tool review; new chat/tools menu.
Account/workspace policy can restrict this flow. A verified registered URL is
used exactly when supplied; the component never constructs an app ID/install
link. The registered fixture uses the existing generic Plugins URL and a test
record ID, which proves the rendering branch only.

The host owns public metadata, the authorized enrollment, current user/workspace
state, and an optional reliable status callback. If it cannot verify connection
state, it should omit the callback and use the setup flow. This PR adds no
network/OAuth/provisioning/auth/grants/backend/routing/phone/billing behavior.

Root delivery owns package release, Builder's real consumer adoption, and any
hosted ChatGPT connection proof. This branch has not published, deployed or
merged the feature. Rollback removes the optional mount/imports; existing
tool-only clients and non-React consumers are unaffected.
