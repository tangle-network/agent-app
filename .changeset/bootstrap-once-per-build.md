---
"@tangle-network/agent-app": patch
---

A reused box no longer reruns the product bootstrap when nothing it depends on changed. A product may declare `bootstrapDigest(scope)`, its served build id; a reuse skips `bootstrap` when this box already ran it under the same build, harness and egress policy within the reuse trust window, and the shared reuse record carries that across isolates. A new release, a new harness or another egress policy runs the bootstrap again, and a product that declares no build bootstraps on every reuse as before. On production Tax (2026-11-15, 8 reuses of a running box) the bootstrap's box execs took 2.73-4.43 s of a 3.0-4.7 s finalize.
