---
"@tangle-network/agent-app": patch
---

Build against `@tangle-network/ui` 11.16.5, whose OpenUI node schema has no required recursive loop. The `render_ui` tool schema that agent-app bundles now passes Gemini's tool-schema check. Before, Gemini rejected every turn that offered `render_ui` with "ref loops are only supported if they include optional or nullable property values". Empty containers still fail validation before persistence.
