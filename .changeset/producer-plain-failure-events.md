---
"@tangle-network/agent-app": patch
---

A sandbox failure the producer words plainly (a reset provider, a refused model key) now reaches the person in those words everywhere. The forwarded `error`, `done` and `session.run.failed` events carry the plain sentence in `message`, `error` and `reason`, with the raw text moved to `details.raw`. A `warning` event with a failure the producer words plainly is no longer shown as its own warning notice; the error notice that follows carries it. Before this, the chat showed the raw "OPENCODE_ERROR: Invalid API key" and "opencode execution failed: … (exit code 1)" on either side of the plain notice.
