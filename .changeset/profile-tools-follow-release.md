---
"@tangle-network/agent-app": patch
---

Profile self-edit and custom profiles use the text a turn runs. `profileTools` and `createTextProfile` take an optional `followRelease(revision)` (usually `followProductRelease`): `profile.read` shows the followed text, a `profile.update` that hands back the shown system prompt keeps the stored one (so the profile keeps following releases), and a new custom profile stores no system prompt, so it runs the product's current one at every release instead of a stored copy of the baseline's (a read path that shows it must read through the same `followRelease`). Before this, an agent's self-edit stored an earlier release's prompt as its own and the workspace silently stopped following releases. `forgetBootstrap(box)` removes a box's bootstrap markers, so a product whose turn failed on something the bootstrap provides repairs the box on its next start instead of within a day.
