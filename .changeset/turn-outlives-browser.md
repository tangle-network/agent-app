---
"@tangle-network/agent-app": minor
---

A chat turn can now outlive the browser that sent it. Until now, after the client left, the turn ran on only in the request's `waitUntil` drain, which Cloudflare cancels soon after the client disconnects. A turn still answering then lost its reply, and its lock waited for the reclaim.

An app opts in with two options. `createChatTurnRoutes({ turnHost: { namespace, auth } })` forwards each browser turn, unread and with its cookies, to a new object of the app's turn-stream binding (`newUniqueId`, placed with the turn lock's region) and streams that object's response. The binding's `TurnStreamDO` subclass passes `turnRoutes: env => createChatTurnRoutes(...)` with the same routes. That object runs the turn under its own `waitUntil`, so the drain still persists the answer, releases the lock and finalizes replay after the browser leaves. Authorization, the lock, the turn tap, draft persistence and Stop run there unchanged. Only the app's Worker can start a turn in that object: its capability token names the object's id.

The app needs compatibility date 2026-10-01 or later, or the compatibility flag `durable_object_io_tasks_prevent_eviction`, so the object stays alive while its pending work runs with no client connected. A turn given `executionLimits` or `cancelOnDisconnect` still runs in its own request.
