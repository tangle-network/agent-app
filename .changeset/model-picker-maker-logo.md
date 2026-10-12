---
"@tangle-network/agent-app": patch
---

The model picker draws a model's maker logo when the catalogue names one. `CatalogModel` and Studio's `MediaModelOption` take an optional `maker` (the brand that made the model, such as `google` for Veo served by fal); the row, the trigger and `renderProviderBadge` use it in place of `provider`, which still groups and searches. Search also matches the maker.
