---
"@tangle-network/agent-app": patch
---

Composer `chip` model and effort pickers render at exactly 32px: they use a fixed `--control-height-sm` height without vertical padding, which had pushed them to 34px. A full-width `EffortPicker` in the settings panels keeps its 36px row beside the full-width harness picker.
