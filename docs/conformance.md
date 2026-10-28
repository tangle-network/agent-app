# Conformance

`agent-app-conformance` checks the basics of a deployed agent app from outside, as a customer meets them, so a broken app is found by us within hours and not by a customer.
One runner serves every product: it speaks only the browser sign-in and the [operator API](operator-api.md) that every app mounts the same way, so it knows nothing about an app's own routes.
It is a live check against a production origin, never a test of a fixture, and it is not the [launch-invariants](launch-invariants.md) report, which reads a repository. The [release canary](../create-agent-app/template-chat/README.md#release-canary) gates one release of a generated app; this monitors every deployed app, every few hours.

```sh
CONFORMANCE_EMAIL=… CONFORMANCE_PASSWORD=… \
  agent-app-conformance --app-url https://gtm.tangle.tools --auth password --workspace "GTM release canary"
```

Read the member from the environment, not from `--email` and `--password`, which a process listing shows.
`import { checkDeployedApp } from '@tangle-network/agent-app/conformance'` runs the same checks from code.

## The checks

Each check prints one JSON line when it ends: `at`, `app`, `url`, `check`, `status` (`pass`, `fail` or `blocked`), `ms`, and `cause` for a failure or `detail` for what a pass observed.
A `blocked` check depends on one that failed, so nothing was measured; it fails the run, and its cause names the check that blocked it.

| Check | Passes when |
| --- | --- |
| `sign-in` | The member signs in (`--auth password`, or `sso` through Tangle Platform) and the app accepts the session. |
| `revision` | The app says what it is running: `GET /api/health` carries `revision` (or `release.sha`, `release.tag`), or any response carries an `x-<app>-revision` or `x-<app>-version` header. `--expect-revision` also requires it to match. |
| `operator-access` | An operator key with `operator:read` and `operator:run` reaches the canary workspace. Without `CONFORMANCE_OPERATOR_KEY`, the signed-in member mints a one-hour key at `POST /api/keys`. |
| `plain-turn` | A turn on a new thread settles `succeeded` with a reply that has text. |
| `computer-turn` | A turn only the workspace computer can answer settles `succeeded` and proves it. `--computer digest` (default) asks for the SHA-256 of a fresh random nonce, which the model cannot know without running the command; the reply must hold it. `--computer file` asks the computer to save a file holding the nonce, and the app must serve that file back through `GET /api/operator/v1/workspaces/:id/file`; use it for an app whose computer step cannot run a shell. The computer turn runs on `--computer-model` (default `glm-5.3`, the flat-rate plan); the plain turn keeps the app's own model and reports it, so the served model is still checked once. |
| `key-revoke` | The key this run minted is revoked, whether or not the turns ran. |

The verdict of a turn is the settled turn the app stored, read through the operator API, so a reply that claims success without the digest or the file fails with what the reply said.
A turn that waits on a decision fails: no one answers in a conformance run.

## What an app must provide

- A canary member that can sign in, and a canary or smoke workspace the turns run in (`--workspace`, an id or exact name). Never point it at a customer's workspace.
- `/api/operator/v1` with `operator:run` enabled, and `POST /api/keys` with `DELETE /api/keys/:id` (or `DELETE /api/keys` with `{ id }`), the routes the API access page uses. An app with no key route fails `operator-access` until it has an operator key to give the runner.
- A served revision, as above.

Sign-in answers 429 with `Retry-After` are waited out twice, so a run is not red because another run signed in the same member a moment before.

## Running it on a schedule

The schedule is owned by tangle-tools `system-crons/run-app-conformance.py`, which reads the apps, origins and the vault key names of each canary member from `system-crons/app-conformance.json`, runs this CLI from the pinned published package for each app in turn, writes the receipts, and keeps one GitHub issue open in each red app's repository.
Bump `runner.version` there when this CLI changes.

Exit 0 when every check passes, 1 when any fails or is blocked, 2 on a usage error.
