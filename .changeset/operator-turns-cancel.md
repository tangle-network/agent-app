---
"@tangle-network/agent-app": patch
---

Operator API turns can be cancelled. `POST /workspaces/:id/threads/:thread/turns/:turn/cancel` (`turns.cancel`, scopes `operator:read` and `operator:run`, workspace `run` access) stops a turn through the adapter's new optional `cancelTurn`, which `describe` reports as the `turns.cancel` capability; any other adapter answers 501 `operator.unsupported`. Cancelling a settled turn answers 200 with its settled state and never reaches the adapter. An unsettled turn answers 202 with the turn as read after the stop, or holds with `?wait=` until it settles; a cancelled turn settles `failed` with `OPERATOR_TURN_CANCELLED_CODE` (`turn.cancelled`). `createOperatorClient` adds `cancelTurn`.
