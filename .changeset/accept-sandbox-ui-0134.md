---
"@tangle-network/agent-app": patch
---

Accept `@tangle-network/sandbox-ui` 0.134, which adds `WorkspaceSurface`, `WorkspaceSurfaceFrame` and `WorkspaceArtifactView` and removes no export, so every workspace page can sit on the chat's floating panel. The Studio composer becomes a field like `ChatComposer` (`focusFieldWithin` on the `--well` fill) and the Vault tree search takes the field well and border inside a `data-slot="card"` tree, so both step off their surface (`agent-app-signoff surface-ladder`). The theme projection is regenerated from brand 1.24.1.

`SessionHistoryPanel` takes `showHeader={false}` for a host whose page already has a header row (a `WorkspaceSurface`), so a history page keeps one header.
