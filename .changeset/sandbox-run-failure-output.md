---
"@tangle-network/agent-app": patch
---

A `sandbox_run` that fails (`sandbox_failed`, or an unconfirmed run that did not reach its cap) now returns what the box had produced, as a capped call already did: the failure keeps its code and its recorded cause, and the model also reads the box's output so far, its latest part kept within 8,000 characters. On 2026-11-22 two GTM computer steps failed about 200 s in after fetching and extracting pricing pages, and the model, given only "That answer stopped before it finished", told the member that no page had been read.
