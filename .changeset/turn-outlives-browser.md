---
"@tangle-network/agent-app": minor
---

A chat turn can now outlive the browser that sent it. Until now, after the client left, the turn ran on only in the request's `waitUntil` drain, which Cloudflare cancels soon after the client disconnects. A turn still answering then lost its reply, and its lock waited for the reclaim.

An app opts in with two options. `createChatTurnRoutes({ turnHost: { namespace, auth } })` forwards each browser turn, with its cookies, to a new object of the app's turn-stream binding (`newUniqueId`, placed with the turn lock's region) and streams that object's response. The binding's `TurnStreamDO` subclass passes `turnRoutes: env => createChatTurnRoutes(...)` with the same routes. That object runs the turn under its own `waitUntil`, so the drain still persists the answer, releases the lock and finalizes replay after the browser leaves. Authorization, the lock, the turn tap, draft persistence and Stop run there unchanged. Only the app's Worker can start a turn in that object: its capability token names the object's id.

Some turns still run in the request. A request with neither a `Cookie` nor an `Authorization` header is refused there by `authorize` without creating an object. A turn given `executionLimits` or `cancelOnDisconnect: true` stays there too. If the object cannot be reached, the turn runs in the request as before, logged once as `turn_host_unavailable`.

Deploying it:
- Use compatibility date 2026-10-01 or later, or the compatibility flag `durable_object_io_tasks_prevent_eviction`, so the object stays alive while the turn's work is pending and no client is connected.
- The whole turn's CPU time counts against the one forwarded request. Set `limits.cpu_ms` (up to 300000) for long turns.
- A code deploy resets active objects under the `immediate` update strategy. Give the turn-stream class a `deferred` code update strategy whose `max_delay` covers your longest turn. Cloudflare lets in-flight requests finish without access to the object's own storage, which a hosted turn never uses.
- The class's `turnRoutes` must pass `ctx` through unchanged. Its `hosted` mark stops the object forwarding the turn again.
