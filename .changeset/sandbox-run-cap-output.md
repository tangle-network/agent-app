---
"@tangle-network/agent-app": patch
---

A `sandbox_run` stopped at its cap returns what the box had produced by then. `SandboxTaskOptions` takes `produced(read)`, and the runner hands it a reader of the box's output so far; the capped call's `sandbox_unconfirmed` failure then carries that output to the model, its latest part kept within 8,000 characters, while `onFailure` keeps only the short cause. `createComputerOutput()` folds a box run's raw prompt events (the agent's text and each tool call's input and output) into that text. agent-app's shell computer step reports through it; a product's own `run` creates one, passes it each event it consumes, and hands `read` to `step.produced`. A cap with no output reported keeps the old message.
