---
"@tangle-network/agent-app": minor
---

A Router turn can keep its pre-tool narration out of its answer. A `RouterTurnTool` that fetches what the answer needs declares `effect: 'lookup'`. Text a model round writes before calling such a tool ("Let me look at the brief.") is stored as a reasoning part. The turn's final text is what the model wrote after its last tool call (`RouterTurnOutcome.answer`). A turn whose only text came before the lookup keeps that text as its answer. A tool that declares nothing (a save, a send, a bridged tool) keeps the text before it as the answer. For such a tool, no stored answer changes.
