---
"@tangle-network/agent-app": patch
---

Every event `createSandboxChatProducer` yields now leaves through one person-facing filter, so no failure reason, tool list, request route or model failover trail reaches a client by any path.

A raw harness error (an `error`, `error.message` or an error item, such as a `turn.failed`), a failed `status` or `done`, a `session.run.failed` and a `session.error` read the failed-turn sentence like the terminal error, with the reason logged once at warn and kept for the route's hooks. A harness warning that carries harness text (its wrapper, a tool list, a stack, a URL or API path, a failover trail) is dropped and logged once as a `harness_warning`; any other warning keeps its notice in its own words, as before.

A model failover trail (`All N model(s) failed. …`) is read for its last attempt only, never its model ids. Every sentence a person reads, plain or in its own words, is cleaned of the harness wrapper, a tool list, a request's method and path, a URL, an API path and an HTTP status; the Router's refusal is its first sentence, and own words that clean to almost nothing read the failed-turn sentence with their code kept. A thrown failure keeps its HTTP status on the error event, so a 402 reads the same on the wire as in the text.

A raw harness tool event, a recovered assistant row and a live tool part never carry the list of every tool, while a completed tool's output (a document it read) and every tool input stay whole. A plainly worded failure no longer puts its raw text in `details.raw`, and `onTurnComplete`'s `failureReason` now carries the real reason for plainly worded failures too. With `redactValues`, the route's failure hooks still receive the real reason, redacted. A protected turn whose settlement check fails after its answer still ends failed, as before, but the person reads "The answer above is complete." when the turn shows answer text, and the failed-turn sentence when it does not. A provider retry notice quotes the provider's words cleaned, and an HTML error page as its status. A closed-set `reason` code on a failure event stays as it is.
