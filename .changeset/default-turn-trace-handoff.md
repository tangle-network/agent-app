---
"@tangle-network/agent-app": patch
---

`createChatTurnRoutes` exports every turn's trace by default (`createIntelligenceTurnTraceSink({ project: projectId })`), including a turn handed to a durable owner with `handoffCompletion`, which now ends and exports when the request's live projection ends (`tangle.turn.handed_off`, failed only when the projection saw an error). Every turn writes one `agent_app_turn_trace` log line with first text, coverage and time per kind. `turnTrace: false` is the only opt-out. `runRouterTurn` marks first text on the trace it is given, so a Durable Object turn gets `first_text_ms` without its own call. `agent-app-signoff defaults` reads the default and flags an app that passes `handoffCompletion` below 0.60.221.
