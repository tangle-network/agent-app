# One application improvement contract

Use the application shell for observation and delivery; do not add an optimizer,
relay, prompt cache, evaluator store, or approval queue to each product.

## Owners

Agent App adapts application execution and review to the existing owners.
Runtime owns execution, RunRecord/trace export, candidate experiments and exact
profile activation. Eval owns evaluator admission, search and statistical decisions.
Intelligence owns Subjects, retained measurement plans, experiments and lineage.
Platform owns saved profiles, current permissions and applying/restoring versions.
Router serves the approved inference policy without waiting for optimization.

An observation is not a certified improvement. A completed stream is not an
accepted deliverable. A human accepting a deliverable does not establish external
delivery, sales, payment, or another unobserved business result.

## Shared application adapter

`createApplicationIntelligence` is exported from `@tangle-network/agent-app/runtime`.
Bind a separate instance to each export/delivery authorization scope. Do not share
an instance holding one tenant's credentials or cached guidance with another tenant.
Configuration is supplied by trusted server code, never model arguments.

```ts
const intelligence = createApplicationIntelligence({
  config: () => ({
    project: 'my-app',
    apiKey: env.TANGLE_INTELLIGENCE_API_KEY ?? '',
    baseUrl: env.TANGLE_INTELLIGENCE_URL,
    effort: 'off',
    payloadAttributes: 'metadata',
  }),
  delivery: {
    enabled: () => approvedDeliveryEnabled,
    config: () => ({ target: approvedTarget, apiKey: approvedDeliveryKey }),
  },
  warn: message => logger.warn(message),
})
```

An empty explicit key disables exporting instead of falling back to a Router key.
The adapter creates no paid work. Configuring observation does not grant permission
to retain content, use another provider, run experiments, apply changes, or share
private material. Configure those existing permissions independently.

### Ordinary chat routes

For a new app, use `createApplicationIntelligenceLifecycle` from
`@tangle-network/agent-app/chat-routes` with the existing terminal lifecycle:

```ts
const routes = createChatTurnRoutes({
  ...applicationOptions,
  lifecycle: createApplicationIntelligenceLifecycle(intelligence),
  traceFlush: () => intelligence.flush(),
})
```

Compose with an existing product lifecycle rather than replacing its persistence,
billing, or domain hooks. The adapter records host execution/session/user/tenant
identity, the route's duration, explicit served attribution and reported inference
cost. A gated turn is not an execution. Missing cost remains unknown; an observed
zero remains zero. Neither completion nor failure is turned into a semantic score.
No final text or arbitrary error body is exported by this lifecycle adapter.

The generated chat app includes this binding behind
`INTELLIGENCE_OBSERVE_ENABLED=true` and a separate `TANGLE_INTELLIGENCE_API_KEY`.
Without opt-in, it creates no observer and does not use the inference credential.

### Existing custom stream producers

Use `intelligence.observeProducer({ produce, meta, signal?, cancellation? })` when
the application cannot use the shared terminal hooks. Keep the domain factory and
identity mapping in the product. Do not copy the stream observer.

The producer is constructed once and its stream is pulled only by the caller.
Native delegation preserves backpressure, queued next values, throw recovery and
cleanup that itself yields. Dynamic model getters and method receivers remain
live. Default cancellation delegates to the source. `cancellation: 'abort'` also
passes an AbortSignal to the producer and interrupts blocked reads; source cleanup
is explicitly unconfirmed when the producer ignores cancellation. This is a viewer
or stream-lifecycle observation, not a durable native-completion receipt.

Never run this adapter and the terminal lifecycle adapter as two authoritative
observations of the same execution. An omitted `meta.runId` is diagnostic only;
use the admitted host execution ID when evidence must join a work product.

### Native or durable jobs

Pass the retained Runtime `RunRecord` to `intelligence.recordRun(record)` from the
existing native completion owner. Do not infer completion from SSE exhaustion,
webhook acceptance, polling a live view, or constructing a producer.
`recordRun` preserves the provided typed evidence and returns configuration and an
explicitly unconfirmed delivery status. `flush()` and aggregate `exportStats()`
are operational diagnostics, not a per-run persisted acknowledgement. A proof
requiring durable ingestion must read back the exact run through its existing owner.

For unknown inference cost, retain Runtime's numeric subtotal with
`inferenceUsdKnown: false`; do not convert a missing field to an observed zero.
Do not invent `success: false` when no task outcome was measured, either.

### Approved guidance

`composePrompt(base)` is disabled unless the supplied delivery permission says it
is enabled. It reuses `createCertifiedDelivery`, whose `composePrompt` and
`composeProfile` share Runtime's cached source. Turning delivery off while a pull
is in flight returns the base prompt. This installs prompt guidance only; it does
not grant tools/MCP/files, change money or action permissions, replace private
memory, or act as an exact-version activation/revocation barrier.

## Complete improvement and review

Keep one persistent agent identity and create immutable candidate profile revisions.
Host-stamp the actual profile/configuration, admitted execution and available native
receipts before a work product can cite them. Review the exact displayed artifact
version through `createWorkProductRoutes`; use its stored reviewer identity and
revision. Its post-commit callback alone is not a durable delivery queue. Reconcile
observations using the product's existing retained history/outbox, not a new ledger.

Use Intelligence's existing Subject/ImprovementSpec and artifact lanes, Runtime's
candidate experiment and activation APIs, and Eval's registered comparisons.
Reuse admitted checkers before constructing new ones. Keep candidate selection
separate from fresh final confirmation. Approval must bind the exact measured
candidate and current baseline/permission revision, with the existing restore path.
No leaderboard score, telemetry callback, or prompt-cache refresh authorizes that.

## Audited consumer boundaries

| Application | Execution entry | Domain configuration retained |
|---|---|---|
| GTM | shared chat/native completion, legacy stream adapter during migration | GTM profile, workspace/thread identity, named service credential |
| Tax | shared chat and custom tax turn producer | tax profile and user/session scope |
| Legal | shared chat producer | legal profile, workspace/thread scope |
| Creative | shared chat producer and separate media jobs | creative profile and job outcome definitions |
| Insurance | cancellation-aware custom producer | required dedicated export key; no per-app relay |
| Relationships | shared chat routes | authenticated workspace roles and explicit observation opt-in |
| Hospitality | external hosted agent/Hub execution | participant consent and host completion ownership; product ingest is not agent completion |
| Physim | completed native RunRecord | simulation outcome definitions, no fabricated cost or delivery acknowledgement |

This table is source placement, not a production-rollout or demonstrated-benefit
claim. The remaining full customer loop is tracked in agent-dev-container #8286,
GTM #1143, and ADC #8607/#8608. Do not close those merely because an adapter ships.
