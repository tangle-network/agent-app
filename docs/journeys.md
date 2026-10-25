# Recorded journeys

A journey drives an agent app's real UI the way a person does, as a test identity, and records it: a captioned video, a highlights cut of at most three minutes, desktop and phone screenshots, a scrubbed Playwright trace, and every chat turn's timings and outcome.
They live in `@tangle-network/agent-app/journeys`, so every app proves its product flows with the same recorder, the same turn scorer and the same report.
The `prove-journeys` skill runs the method end to end: record each flow in parallel, review the evidence skeptically, and write one INDEX.md with a ranked fix list.

GTM's recorded journeys proved 2 of its 4 minimum-customer-path checks, and the hand-built harness that recorded them scored 6 of 6 failed turns "completed".
This kit is that harness made app-agnostic, with the scoring rule fixed: see [How a turn is scored](#how-a-turn-is-scored).

## Adopt the kit

1. Add `journeys.config.mjs` at the app root, beside `launch-invariants.config.mjs`.

   ```js
   import { defineJourneys } from '@tangle-network/agent-app/journeys'

   export default defineJourneys({
     app: 'gtm',
     baseUrl: 'https://gtm.tangle.tools',
     identities: {
       owner: { emailEnv: 'GTM_CHAT_SMOKE_EMAIL', passwordEnv: 'GTM_CHAT_SMOKE_PASSWORD', signIn: 'password' },
       member: { emailEnv: 'PLATFORM_WORKFLOW_SMOKE_EMAIL', passwordEnv: 'PLATFORM_WORKFLOW_SMOKE_PASSWORD', signIn: 'tangle' },
     },
     chat: {
       transcript: '#main-content',
       assistant: '.gtm-assistant-markdown',
       failureText: [/stopped before finishing/i, /Chat responses require a running sandbox/i],
       stoppedText: [/You stopped this turn/i],
       threadPath: /^\/app\/(?<workspaceId>[^/]+)\/chat\/(?<threadId>[0-9a-f]{32})\/?$/,
       runningTurns: ({ workspaceId, threadId }) => `/api/chat/running?workspaceId=${workspaceId}&threadId=${threadId}`,
     },
   })
   ```

   The config names environment variables; it never holds a credential.
   `signIn: 'tangle'` signs in through the app's "Log in with Tangle" route; `'password'` uses the app's own email sign-in.
   The `chat` defaults are agent-app's own components (`ChatComposer`, the transcript's failure rows), so an app on the shared composer needs only what it renders itself: its assistant text, its failure-card copy, its thread URL and, when it has one, its running-turns endpoint.
   `JOURNEYS_BASE_URL` points the same journeys at a local stack.

2. Install the optional `playwright` peer, and have `ffmpeg` and `ffprobe` on the host that records.

3. Write a journey script. It runs with Node's type stripping, so it may be a `.ts` file.

   ```ts
   import { startJourney } from '@tangle-network/agent-app/journeys'

   const j = await startJourney('core-path')
   try {
     const page = await j.open('founder', 'member')               // recorded, already signed in
     await j.step('Founder opens a new thread', () => page.goto(`/app/${WS}/chat/new`), page)
     await j.shot('first-screen', page)                           // first-screen-desktop.png + -phone.png
     const t = await j.sendNew(page, 'Research the three competitors most likely to lose me deals…')
     // t: { outcome, error, failures, firstProgressS, firstTextS, completeS, replyChars, stages, threadId, replyFile }
     await j.wait('Waiting for the file list', () => page.getByText('knowledge').waitFor({ timeout: 60_000 }), page)
     await j.sendInThread(page, 'Cut it to one page.', { stopAfter: 'first-text' }) // presses Stop like a person
   } finally {
     await j.finish()                                             // always: videos, captions, scrubbed trace, timings
   }
   ```

   `j.step` adds a chapter and times the step; `j.mark` adds a bare chapter; `j.wait` marks a span that the highlights cut speeds up and labels with its real length.
   `j.click`, `j.type` and `j.typePrompt` act at a person's pace with a visible pointer; `typePrompt` types a line break as Shift+Enter, because Enter sends.
   `j.checkChatContract(page)` reports which chat parts the page shows without sending anything; run it once on a new app before trusting its turn timings.
   A journey sends at most `maxTurns` chat turns (default 6).

4. Run it with the credentials in the process environment.

   ```bash
   agent-app-journeys env-names                 # the variable names to load from the host's vault
   agent-app-journeys run journeys/core-path.ts
   agent-app-journeys frames core-path founder  # one PNG per chapter, to look at before judging
   agent-app-journeys index ~/flows/2026-10-11 --critic ~/flows/2026-10-11/critic-result.json
   ```

## Rules every journey keeps

- Sign-in happens over HTTP and is cached per identity, so no frame shows a login form. Never press Sign out in a shared session; a journey that signs out opens its context with `{ fresh: true }`.
- `finish()` scrubs each trace (cookies, authorization headers, token query values, auth and session bodies, every password, cookie value and identity email) and then re-reads every output file, inside the zips too. It throws `REFUSING …` if a password or cookie value survived; copy nothing from that folder.
- After that scan, `finish()` removes stale recorder-owned media, screenshots and turn replies from earlier runs of the same journey id. Other evidence files are left untouched; a failed finish does not prune the previous run.
- Raw recordings and unscrubbed traces stay in the state directory on the recording host (`~/.local/state/agent-app-journeys/<app>`).
- Use test identities and test workspaces only, and press nothing that sends, posts, schedules, publishes, approves or pays for something outside the app.

## How a turn is scored

`scoreTurn` decides each turn from what the person saw, in this order:

| Outcome | When |
|---|---|
| `not-sent` | The send never reached the app. |
| `stopped` | A stop line appeared (`stoppedText`), or the journey pressed Stop and the turn ended. |
| `failed` | Failure evidence appeared during the turn: a failure-marked element, a failure line (`failureText`) anywhere in the transcript, or a new Retry control. |
| `timeout` | The turn was still running when the wait ended. |
| `empty` | The turn ended with no new reply text. |
| `completed` | The turn ended with reply text and no failure evidence. |

A turn has ended when, for two reads in a row, no Stop control shows and no status line has changed for 20 seconds, and the app's running-turns endpoint, when configured, lists none; a notice left on the page after a Stop (GTM's "Request was interrupted by the user") therefore does not hold the turn open.
Evidence is read from the transcript region, not from the reply alone, and only what follows the turn's own message counts once the page shows it; the turn's `evidenceScope` records `after-prompt`, or `whole-transcript` when the page never showed the prompt and only evidence that appeared after Send counts.
So an earlier failure in the thread does not fail a later turn, even when the page re-renders it after Send (GTM's stopped-turn card renders above the next message), and a Retry whose new failure repeats the old card's words still counts.
Failure-marked elements are read with `textContent`, so a typed code inside a collapsed details panel counts.
The default failure lines include agent-app's own sandbox failure copy, so an app adds only the copy it renders itself.
A turn that shows any failure is not a pass; read `failures` to tell a dead turn from a degraded one.

## The report

`agent-app-journeys index <folder>` finds every journey folder under it (any folder with a `timings.json` or a `video/` folder) and writes INDEX.md: highlights first, the critic's scorecard, the ranked fixes (verified failures by rank, each with evidence, likely cause, fix, number to beat and the test that proves it), every recorded turn with its outcome, every video with its length, and what stayed unproven.
`--critic` takes the skeptical reviewer's JSON (`CriticResult`); without it the index still lists the videos and the scored turns.

## The readiness board

Every app's flows share one board, [Agent App Readiness](https://claude.ai/artifact/KLbML9ey4e4LvU6F2BjmuL), and one row schema: a `flows` row carries `app`, `flowId`, `status` (`pass`, `fail`, `stall`, `blocked-host`, `blocked`, `skipped`, `unrecorded`), the blocker, the first-text and done times, video, trace and evidence links, and the commit the run served; `meta/<app>` carries the run's origin, commit and time. Rows written before the board was shared have no `app` and belong to Hardware, at their bare flow id and `meta/board`; Hardware's runner passes `--legacy-ids` to keep writing there.

A run's runner writes a `summary.json` (`updatedAt`, `origin`, `sha`, and `journeys: [{ id, status, reason?, firstTextS?, completeS?, videoUrl?, traceUrl?, evidenceUrl? }]`), and `agent-app-journeys scoreboard summary.json --app <app> [--versions versions.json]` turns it into the batch of writes for the board's store. Pass the current version of every row that already exists (`{ "flows/casework-C3": 2, "meta/casework": 1 }`, read from the store first): those rows are merged, so the flow text and pass bar a person wrote survive, and anything the run no longer has, such as an old blocker, is cleared. A row with no version is created; the store refuses that write if the row exists after all, so nothing a person wrote is replaced. Only http(s) links are written; a host path is dropped with a warning.

Classify before you write: `stall` is a click-stability timeout with no app error in the trace; `blocked-host` is a failure whose trace shows `net::ERR_NETWORK_CHANGED` or requests that never got a response; `fail` is a wrong outcome or an app error.
