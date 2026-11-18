---
"@tangle-network/agent-app": patch
---

A Router turn takes `shapeRequest(body)`, applied to each model request's decoded JSON body before it is traced, gzipped and sent. A product's `fetchImpl` reads a request of 32 KiB or more already gzipped on the Tangle Router origin, so payload policy written there (a `max_tokens` floor, a model's effort rule) skipped every large request.
