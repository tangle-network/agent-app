# App defaults

Each proven improvement ships as a default inside agent-app, so a new app has it by construction and an old app gets it by bumping the pin.
`agent-app-signoff defaults` reports, for each app in a checkout, which defaults it has, which it turned off and which it replaced with a local copy.
The same report runs as the built-in `agent-app defaults` step of `agent-app-signoff`, after the repo's own steps.
It is a report: it fails only on an explicit opt-out that gives no reason.

```bash
agent-app-signoff defaults            # this checkout; builds first if you want the Worker upload measured
agent-app-signoff defaults --probe    # also ask Intelligence for each app's last exported turn (SANDBOX_API_KEY)
agent-app-signoff defaults --no-bundle --json matrix.json
```

## The rows

| Row | Has the default when | Source of the read |
|---|---|---|
| agent-app pin | the pinned version is at or above every outcome's floor (`AGENT_APP_OUTCOME_FLOORS`: turn trace 0.60.199, first text 0.60.203) | `package.json` |
| turn trace | the app wires a sink (`createIntelligenceTurnTraceSink`, or a `turnTrace: { sink }`) that does not export with `TANGLE_API_KEY` (a Router key the ingest rejects); with `--probe`, Intelligence also holds a turn from the last 30 days | source, Intelligence |
| first text | the turn owner marks it (`createChatTurnRoutes` from 0.60.203, or `trace.markFirstText()` in a Durable Object turn) and the trace is on | source |
| prewarm route | the app mounts `createWorkspacePrewarmRoute`; a local route named prewarm is a local copy | source |
| placement | a Wrangler `[placement]` names a `region` or `host`; smart placement does not pin | Wrangler config |
| tool_count p50 | reported when Intelligence has it; no ceiling is set until a measured link to first text exists | Intelligence |
| limit alarms | the server wraps its D1 binding with `withD1LimitAlarms` and builds the alarms with `createProductLimitAlarms`, not a copy of `createLimitAlarms` | source |
| Worker upload | gzip Total Upload from `wrangler deploy --dry-run` is under 80% of `LAUNCH_BUDGETS.workerUploadGzipKiB` (10 MiB) | the app's own Wrangler, after a build |

Tests, stories, scripts, docs and examples are not read as source.
An archived or non-app repo (no `@tangle-network/agent-app` dependency) reports nothing.

## Opting out

Turn a default off only for a reason a reader can check, in the app's `signoff.config.mjs`:

```js
export default {
  steps: [/* ... */],
  agentApp: {
    exemptions: {
      placement: 'Smart placement measured 40 ms slower than the default beside D1 in eu-west on 2026-10-19',
    },
  },
}
```

An exemption may name `turn-trace`, `first-text`, `prewarm`, `placement` or `limit-alarms`; a reason shorter than eight characters is a configuration error.
Passing `turnTrace: false` to `createChatTurnRoutes` is an opt-out too, and it fails the step until its exemption carries a reason.
