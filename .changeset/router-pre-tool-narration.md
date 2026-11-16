---
"@tangle-network/agent-app": minor
---

Keep a Router turn's pre-tool narration out of its answer. Text a model round writes before calling a tool ("Let me look at the brief.") is stored as a reasoning part, and the turn's final text is what the model wrote after its last tool call (`RouterTurnOutcome.answer`). A turn whose only text came before a tool call keeps that text as its answer. A tool that acts on the answer (save, send, create) declares `effect: 'action'` on its `RouterTurnTool`; text before it stays the answer, so a memo followed by its save is stored as the memo and the confirmation.
