# One application improvement contract

Agent App owns application assembly, not a second optimization engine. Products
supply domain profiles, business objectives, authorized evidence, and persistence
ports. Runtime executes; Eval owns measurement and comparison decisions;
Intelligence retains improvement workflows/evidence; Platform owns current
permission checks and applying/restoring the exact approved profile. Router
serves a published policy and never waits for an improvement job.

## Observe existing execution

`produceChatTurnWithIntelligence` is exported from the existing server-only
`@tangle-network/agent-app/chat-routes` subpath. It decorates a producer without
pulling or buffering its stream and preserves all declared producer projections,
including methods on class-backed/frozen producers. Use each product's existing
Runtime client, credential source and flush hook. Do not widen retention scope.

```ts
import { produceChatTurnWithIntelligence } from '@tangle-network/agent-app/chat-routes'

// Inside the authenticated produce(args) hook. The host resolves permissions;
// neither the model nor browser supplies execution identity or observation keys.
const observation = resolveAuthorizedObservation(args.context)
if (!observation) return produce(args)
return produceChatTurnWithIntelligence({
  produce: () => produce(args),
  client: () => observation.client,
  sessionId: args.identity.sessionId,
  userId: args.identity.userId,
  runId: args.executionId,
  model: observation.requestedModel,
})
```

The client is resolved only after consumed execution terminates. Metadata is
captured before asynchronous construction. No prompt, output, tool argument,
private exception, success score, final spend or served-model receipt is inferred.
Use the existing trace-flush hook after consumption. Lifecycle observation is
best effort, not a durable completion receipt or a confirmed exported record.

`observeChatTurnStream` works on an already-created native async generator,
including non-chat event protocols. It forwards next, return, throw and disposal
without a relay. A returned source may yield cleanup before ending; the observer
waits for that terminal result. Pre-start close still reaches factory-owned
cleanup without claiming the agent executed. It neither adds abort authority nor
cancels an outstanding read itself: retain an existing abort-aware transport.
Do not double-wrap an execution. Native completion/workflow owners still own
work that outlives a viewer or process.

For scoring each live job against an outcome contract and routing failures to the profile or capability lever, read [live-outcome-optimization.md](live-outcome-optimization.md).

## Keep the complete evidence chain

| Stage | Existing owner | Product supplies |
| --- | --- | --- |
| Execution | Runtime, native completion, chat-routes | Authorized tools and exact resolved profile/run |
| Output | Work-product or existing domain store | Artifact kind and immutable revision |
| Review | Work-product route/service | Authenticated reviewer and displayed version |
| Outcome | Existing authorized ingest/outbox | Domain claim and source/version binding |
| Comparison | Eval and Intelligence | Frozen measurement plan and permitted candidate |
| Apply/restore | Runtime activation and Platform | Current authority and exact baseline |

Stream exhaustion, persistence, reviewer acceptance, external delivery and
controlled task-quality confirmation are different facts. A reviewer decision
names the displayed version through the existing version-fenced service. Its
postcommit callback is not durable delivery: reconcile from retained history
through the existing job/outbox, not another feedback database or scheduler.

Freeze the measurement plan independently of the candidate. Reuse tests/schemas
and admitted checkers before constructing new code. Repeated selection consumes
selection data; activation requires fresh final confirmation and current user
permissions. Keep failed and unknown observations. A leaderboard is a projection
of comparable evidence, not activation authority or a universal agent score.

Data use, experiment spend, automatic application and cross-tenant sharing stay
separately authorized. Credentials/private memory are not shareable profiles.
Selecting a profile does not replace the persistent agent identity or silently
reconfigure an active conversation. A new app ships this same contract even when
observation is disabled: enabling export still requires its host's approval.

## Verification and adoption

Run `node scripts/prove-chat-intelligence.mjs` against the built public entrypoint.
`--source` is a diagnostic source mode with controlled tracing, not an installed
Runtime/exporter proof. Run the normal docs generator, full package gates and
committed-source signoff. Consumers must install the actual published compatible
release through the normal package manager; do not invent versions or locks.
Keep the owning Runtime idle-flush correction in the installed cohort.

The adapter is one shared component of improvement. Verify outcome delivery,
fresh comparisons, exact activation/restore, and actual benefit on each app's
real hosted execution owner before calling its full loop complete.
