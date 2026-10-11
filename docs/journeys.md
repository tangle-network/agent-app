# Recorded journeys

A journey drives an agent app's real UI the way a person does, as a test identity, and records it: a captioned video, a highlights cut of at most three minutes, desktop and phone screenshots, a scrubbed Playwright trace, and every chat turn's timings and outcome.
They live in `@tangle-network/agent-app/journeys`, so every app proves its product flows with the same recorder, the same turn scorer and the same report.
The `prove-journeys` skill runs the method end to end: record each flow in parallel, review the evidence skeptically, and write one INDEX.md with a ranked fix list.

GTM's recorded journeys on 2026-10-11 proved 2 of its 4 minimum-customer-path checks, and the hand-built harness that recorded them scored 6 of 6 failed turns "completed".
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
       assistant: '.gtm-assistant-markdown',
       status: '[role="status"]',
       failureText: [/stopped before finishing/i, /unable to connect to the sandbox/i],
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

Evidence is read from the whole transcript region, not from the reply alone, and only evidence that appeared after Send counts: an earlier failure in the thread does not fail a later turn, and a Retry whose new failure repeats the old card's words still counts.
Failure-marked elements are read with `textContent`, so a typed code inside a collapsed details panel counts.
A turn that shows any failure is not a pass; read `failures` to tell a dead turn from a degraded one.

## The report

`agent-app-journeys index <folder>` finds every journey folder under it (any folder with a `timings.json` or a `video/` folder) and writes INDEX.md: highlights first, the critic's scorecard, the ranked fixes (verified failures by rank, each with evidence, likely cause, fix, number to beat and the test that proves it), every recorded turn with its outcome, every video with its length, and what stayed unproven.
`--critic` takes the skeptical reviewer's JSON (`CriticResult`); without it the index still lists the videos and the scored turns.
