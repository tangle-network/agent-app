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

## Removed exports

`broadcastTurnStreamEvent`, `createSegmentStore`, `appendSegmentEvent`, `replayActiveSegment`, `MAX_SEGMENT_EVENTS`, and `isTerminalRunEvent` are removed.
Terminal broadcasts no longer release locks; cooperative release and stale-lock reconciliation own that behavior.

## Rollback

Rollback the Worker and Durable Object code together to the previous consumer deployment.
Retain the secret binding; older code ignores it.
This release changes no Durable Object storage keys or migrations.
Do not rotate the secret independently between Worker and Durable Object bindings.
