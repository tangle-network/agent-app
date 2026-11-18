---
"@tangle-network/agent-app": patch
---

A span over the 48-attribute bound now drops the Router's `server_timing.*` detail before anything else. Since the request fingerprints (4.0.34), a model call's span had no room left for the token counts, cached tokens and finish reason set when its stream ended, so traces and the turn drawer lost them on most calls.
