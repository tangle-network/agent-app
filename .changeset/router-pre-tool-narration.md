---
"@tangle-network/agent-app": patch
---

Keep a Router turn's pre-tool narration out of its answer. Text a model round writes before calling a tool ("Let me look at the brief.") is stored as a reasoning part, and the turn's final text is what the model wrote after its last tool call (`RouterTurnOutcome.answer`). A turn whose only text came before a tool call keeps that text as its answer.
