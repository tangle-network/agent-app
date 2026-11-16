---
"@tangle-network/agent-app": minor
---

An operator turn now carries `refusedToolCalls` (tool and harness error) when the stored reply holds a tool call the harness refused, read with turn-health's `tool_call_rejected` rule, so a refusal is visible even when the turn recovered and answered. `agent-app-conformance` fails a turn that has one. Apps report it once they run this release.
