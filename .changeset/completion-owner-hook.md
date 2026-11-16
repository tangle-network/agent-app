---
"@tangle-network/agent-app": minor
---

A product on the shared sandbox backend can now hand a turn to a durable owner, so the answer outlives the request (a closed tab, a lost connection). `ChatTurnDefaultBackend.completionOwner` is called after the box is resolved and the turn lock is held, before the prompt is dispatched. It registers preset-cloudflare's `createNativeCompletionOwner` and calls `args.handoffCompletion()`. `ChatTurnProduceArgs.lock()` reads the route's lock handle for the owner's payload. `NativeCompletionOwnerOptions.redact` applies the turn's registered secret values to the transcript the owner stores. Reference consumer: creative-agent, which registers the same owner from its own producer.
