---
"@tangle-network/agent-app": minor
---

ModelPicker covers media models: `CatalogModel` gains optional `output` (image, video, audio, speech), `outputPrice` (USD per image, second, minute or 1K characters), `previewUrl` and `capability`. Rows show a 40 px preview for image and video models, a one-line capability under the name, and the price in the unit the output comes in; media rows drop the text-only "no tools" and context labels. `formatModelPrice` is exported for other pickers (voice, generation settings) to use the same price format.
