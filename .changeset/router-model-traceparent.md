---
'@tangle-network/agent-app': patch
---

Model requests propagate W3C traceparent using the turn's existing OTLP trace ID and the current model.call span ID, so Router spans join the application trace. Preserve fetch header precedence, tracestate, authentication, bodies and cancellation signals; each retry names its own model span.
