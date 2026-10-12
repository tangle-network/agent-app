---
"@tangle-network/agent-app": minor
---

Studio's model control is now the shared `ModelPicker` that chat uses, so a media model has its provider logo, published price per output and preview in the same row format as a chat model. `MediaModelOption` gains optional `outputPrice`, `previewUrl` and `capability`, which a host's `/api/media-models` can fill from the router catalog. A row with no published price shows no price. Unavailable and limited models stay selectable, and their status and reason show on the row's capability line. The studio-only `ModelPill` export is removed; use `ModelPicker`.
