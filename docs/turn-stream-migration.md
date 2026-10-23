# Turn-stream 0.52.0 migration

The Durable Object now requires an authenticated request for every endpoint and WebSocket upgrade.
Interactive turn rebroadcast has been removed; use the Sandbox session gateway for interactive replay.
Durable detached-turn rows, running-turn discovery, workspace signals, locks, and persistence extension seams remain.

## Deploy a consumer

1. Configure a random `TURN_STREAM_AUTH_SECRET` of at least 32 characters before deploying the upgraded Worker and Durable Object.
2. Pass `{ secret: env.TURN_STREAM_AUTH_SECRET }` to every lock, store, reconciliation, and broadcast adapter.
3. Pass the same value as `authSecret` to `createTurnStreamUpgradeHandler`.
4. For raw `stub.fetch` calls, mint with `mintTurnStreamToken(channelName, secret)` and set `TURN_STREAM_TOKEN_HEADER`.
5. Upgrade Worker and Durable Object code together, preserving binding names, instance names, and stored records.
6. Check workspace signals, lock acquire/release, durable replay, and any product endpoints through the consumer.

The forwarder runs the product's workspace authorization first, then injects an internal header.
Browser clients keep their existing cookie-authenticated workspace WebSocket URL and receive no capability token.
The removed `threadId` upgrade route returns 400; it does not silently subscribe to workspace signals.

Use `idFromName` or `getByName` so the object receives its named identity.
Cloudflare forwards names up to 1,024 bytes through `state.id.name`; unnamed objects fail closed.
This requires the runtime's named-object support, including an up-to-date local Wrangler.
See [Cloudflare's named-object contract](https://developers.cloudflare.com/changelog/post/2026-03-15-durable-object-id-name/).

The memory harness uses the same authentication gate with `MEMORY_TURN_STREAM_AUTH_SECRET`.
Custom harness factories receive that secret as their second argument and must pass it to their subclass.
Keep the fixed harness secret confined to tests and keyless local development.

## Optional durable Stop for Router owners

Use the existing lock and authenticated control transport for a Router turn that must accept Stop from a different Worker request.
The existing `mintTurnStreamToken` and `verifyTurnStreamToken` accept optional `TurnStreamTokenClaims` after their existing clock/lifetime arguments.
Claims bind `purpose` (`turn-control`, `turn-cancel` or `turn-recovery`) and the exact owner identity under the same secret and existing token lifetime.
The shared adapters mint these server capabilities; the DO verifies the expected purpose and identity before registering control or acting on Stop/recovery.
Legacy v1 channel tokens remain valid for normal viewers and existing operations, but cannot act as owner control, Stop or recovery authority even with exact known owner coordinates.
Viewer forwarders keep minting their existing channel token; never derive server control claims from public viewer query parameters.
`createDurableTurnLock` opts in with `cancellationOf(args)` and requires the route's `turnStreamId`.
The adapter persists that identity with the acquired lock and establishes its owner control connection before returning acquisition.
`createChatTurnRoutes` passes the effective `args.admissionSignal` to `produce`, including dispatch-first producers; pass it to `createHybridTurnProducer`, Router calls and tool I/O.
An owner connection failure before admission releases only its acquired lock generation.
Losing an active control connection aborts the signal with `turn_control_unavailable`; it cannot silently leave an uncancellable producer running.

Products with a custom lock adapter use `acquireDurableTurnLock` with `cancellation: { turnStreamId }`, then
`connectDurableTurnCancellation(namespace, identity, auth)` before returning `{ acquired: true, handle, cancellation }`.
The identity contains the exact `workspaceId`, `threadId`, `scope`, `executionId`, `lockId` and `turnStreamId` returned or retained at acquisition.
If connection setup fails, release that exact newly acquired lock and propagate the error.
The shared route closes the returned connection at cooperative settlement or native handoff; a low-level caller must close it itself.
Closing a connection never releases its lock or clears a retained Stop.
Close the connection before normal cooperative release; any release still received by an active owner aborts its effective signal because that generation no longer has execution authority.

The product authorizes Stop with its existing workspace and thread RBAC, reads the actual active lock, and calls
`requestDurableTurnCancellation(namespace, identity, auth)`.
Use `createChatTurnRoutes`' existing `cancel` target for the public endpoint: return an optional
`control: { request(capturedMetadata) }` capability bound to the server-captured exact owner.
The shared cancellation owner performs authorization and dispatch-token validation before invoking it.
The capability returns `{ requested }`; a stale target receives the existing conflict response, while acceptance reports `cancellationRequested: true`.
Acceptance never invokes native interruption or `markStopped`; the existing execution/child completion owner confirms the outcome after reconciliation.
Turns with an acquired durable control connection use that signal and skip the legacy metadata polling observer.
The DO persists cancellation before broadcasting it, and an owner that connects later receives the retained request.
`requested: true` confirms persisted intent, not remote completion.
Stop aborts the effective signal with `turn_cancel_requested`; Router cancellation retains the existing terminal error behavior.
Do not claim a native computer stopped from SDK stream abortion alone: interrupt its exact child execution and reconcile the actual receipt at the existing completion owner.

Stop does not eagerly release the lock, including when a product defers release for persistence.
The producer finishes its existing settlement before cooperative release.
Existing lock expiry and stale reconciliation remain the crash recovery owners; cancellation does not extend the lock's lifetime.
The existing product `shouldDeferLockRelease` hook also vetoes expiry deletion while an actual registered child/persistence obligation remains.
It reads the product's durable ownership without recursively loading the active lock; unknown obligations stay held and read errors cannot silently become absence.
This does not rewrite `expiresAt`: after the obligation clears, the next existing read or prune can reclaim the expired lock.
An old execution, stream or lock generation cannot cancel its successor.
Keep native completion Workflows, subscription lanes and durable jobs on their existing cancellation owner by omitting this opt-in.

For stale Router recovery, supply `probeOwner(identity)` to `reconcileStaleDurableTurnLock`.
Custom adapters using the pure `reconcileStaleTurnLock` pass `owner: { identity, probe }`.
The probe returns `{ identity, status: 'live' | 'abandoned' | 'unknown', diagnostics? }`; its returned identity must match all of the requested scope, execution, lock and stream fields.
Only positive durable proof that the outer producer and every registered native child/effect owner are quiescent permits `abandoned`.
Missing or mismatched records, an unreachable authority, absent sockets, or a terminal native thread session alone are unknown.
Router owner probes replace the native-only fallback and retain the existing terminal grace.
After the policy permits release, the interrupted-release input carries `recovery: identity`.
The DO rechecks the exact generation and vetoes recovery while its exact owner control socket is live or `shouldDeferLockRelease` reports product child/persistence ownership.
Child ownership must be registered before dispatch and cleared only after its native receipt and persistence settle.
Legacy interrupted releases without this positive recovery proof cannot release a cancellable Router lock.

The standalone `tests/turn-stream/durable-stop.integration.ts` proof bundles the actual shared route and DO into workerd through a consuming app's declared Wrangler.
It uses durable DO storage, D1 SQLite and a real local Router HTTP peer, including runtime restart and producer I/O cancellation; it makes no paid calls or model-quality claim.
Run it through that app's installed TypeScript runner with `AGENT_APP_STOP_CONSUMER_ROOT` set to its checkout.

## Removed exports

`broadcastTurnStreamEvent`, `createSegmentStore`, `appendSegmentEvent`, `replayActiveSegment`, `MAX_SEGMENT_EVENTS`, and `isTerminalRunEvent` are removed.
Terminal broadcasts no longer release locks; cooperative release and stale-lock reconciliation own that behavior.

## Rollback

Rollback the Worker and Durable Object code together to the previous consumer deployment.
Retain the secret binding; older code ignores it.
This release changes no Durable Object storage keys or migrations.
Do not rotate the secret independently between Worker and Durable Object bindings.
