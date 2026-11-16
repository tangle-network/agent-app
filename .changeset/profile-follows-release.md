---
"@tangle-network/agent-app": patch
---

A stored profile now runs the product's current prompt where its own prompt is one the product shipped. `followProductRelease(store, revision, release, productAuthorIds)` returns the stored profile with the release's system prompt when a revision by one of `productAuthorIds` wrote that prompt into its history (its import or a release refresh), and returns it unchanged when a person wrote the prompt or the history is incomplete; nothing stored is rewritten. `promptShippedByProduct` answers that question, and the D1 store's new optional `readPromptHistory` reads a revision's history in one round trip, comparing prompts in SQL. `overlayOnRelease`, `refreshBuiltinSkills` and `ProfileReleaseUpdates` move here from the GTM agent so every app resolves profiles the same way. Before this, a workspace ran the prompt it imported on its first visit through every later release: Creative workspace 086e977d still ran its 2026-11-13 prompt on 2026-11-15.
