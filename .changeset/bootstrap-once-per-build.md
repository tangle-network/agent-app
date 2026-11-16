---
"@tangle-network/agent-app": patch
---

A reused box no longer reruns the product bootstrap it already ran under the same build. A product may declare `bootstrapDigest(scope)`, its served build id; after a successful bootstrap the box keeps a marker file for that build, harness, egress policy and scope in the agent's home, and a reuse that finds it skips the bootstrap with one exec. A new release, harness, egress policy or scope, a wiped home or a replaced box runs the bootstrap again, and a product that declares no build bootstraps on every reuse as before. On production Tax (2026-11-15, 8 reuses of a running box) the bootstrap's box execs took 2.73-4.43 s of a 3.0-4.7 s finalize; a marker read is one exec of about 0.3 s.
