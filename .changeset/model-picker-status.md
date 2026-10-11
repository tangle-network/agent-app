---
"@tangle-network/agent-app": minor
---

ModelPicker marks a model that cannot run as asked. `CatalogModel` gains optional `status` (`available` | `limited` | `unavailable`) and `statusReason`; a limited or unavailable row shows a warning StatusPill beside the name, a muted name and preview when unavailable, and the reason under the name when the model has no capability line. Flagged rows stay selectable. Hosts stop encoding status into `capability` text.
