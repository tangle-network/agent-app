---
"@tangle-network/agent-app": patch
---

`runRouterTurn` takes `answerByMs`: research ends that many ms after the hop started, and the model writes the answer from the tool results it has. After that time no tool round starts: the next model call after a tool round is the answer call (`tool_choice: "none"` at `reasoningEffort`, the same tools listed), a call still choosing tools is cancelled at that time and replaced by the answer call, and tool calls that arrive after it are dropped before they run. A call already writing the answer goes on and tools already running finish. The trace records a `turn.answer_by` span when the time ends research. It works with or without `toolRoundEffort`, and reaches chat routes through the Router and hybrid backend configurations.
