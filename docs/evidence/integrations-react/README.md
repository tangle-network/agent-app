# Hub integrations controller: installed consumer evidence

The new `./integrations-react` subpath had no previous Agent App UI.
The **before** images show the published Sandbox UI controlled catalog with the same two-account fixture and no controller actions.
The **after** images show the packed Agent App candidate with the account and permission flow wired.
All media uses local fixture data; it contains no customer account or credential.

| State | Desktop, 1440 × 900 | Phone, 390 × 844 |
|---|---|---|
| Controlled catalog reference | [Before](./before/desktop.png) | [Before](./before/phone.png) |
| Agent App catalog | [After](./after/catalog-desktop.png) | [After](./after/catalog-phone.png) |
| Account detail | [After](./after/detail-desktop.png) | [After](./after/detail-phone.png) |

The [permission write](./after/policy-desktop.png), [second-account dialog](./after/connect-dialog-desktop.png), [added account](./after/added-account-desktop.png), and [light theme detail](./after/detail-light-desktop.png) show additional states.
The [uncut Chromium video](./after/interaction-uncut.webm) is 10.12 seconds at 1440 × 900.
It shows selecting Hotel B, setting `cloudbeds.rooms.update` to Ask, rereading stored policy, reloading the selected account, and adding and selecting Hotel C.
The video was inspected frame by frame after capture.

## Execution receipt

- Source base: Agent App `origin/main` `ee72c10f`; candidate branch `feat/integrations-react-controller-20261002`.
- Local packed candidate: `@tangle-network/agent-app@0.50.30` tarball SHA-256 `ce5fe7f001b56464d877e871ec43c10980cca7529ac924aa493d4596a0939416`.
  This version label is the source package value; the candidate is **not** the public 0.50.30 npm tarball.
- Exact installed view package: `@tangle-network/sandbox-ui@0.116.9`, with UI 11.12.0, Brand 1.9.1, Agent Interface 2.15.0, React and React DOM 19.2.8.
- Fresh `pnpm install --strict-peer-dependencies --ignore-scripts`: exit 0.
- Consumer `tsc --noEmit` and production Vite build: exit 0; the browser bundle was 428.65 kB before gzip.
- Packed entry import graph: two Agent App JavaScript files; external runtime imports were React, React JSX, Sandbox UI integrations, and UI primitives.
  It had no Node builtin, Hub SDK, or agent-integrations runtime import.
- Chromium result: policy PUT and at least two authorized-policy-read calls; Hotel B and its stored override survived fixture reload; Hotel C was added and selected; zero page errors and zero horizontal overflow at both viewports.
- The fixture stores policy rows in session storage to simulate a durable server across reload.
  The separate controller tests use the real Hub SDK client through `createHubSettingsRoutes` and cover its identity denial boundary.
- No live product host, real Hub provider, or public Agent App package containing this new subpath was used.

The [fixture source](./fixture/) records the browser entry and the Playwright flow.
`package.fixture.json` records the temporary local tarball install; copy it as `package.json` in a scratch consumer with that tarball beside it.
The host normally generates the UI primitive's `text-destructive-foreground` utility through its Tailwind scan.
The minimal Vite fixture includes that single utility in `preview.css` for the light theme capture.
