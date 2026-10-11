---
"@tangle-network/agent-app": minor
---

`agent-app-signoff workspace-surface`: every route must render exactly one shared floating panel (`[data-workspace-surface]`, from sandbox-ui `WorkspaceSurface` or `WorkspaceLayout surface="inset"`) whose first row is an inset `ShellHeader`. It fails a page with its own skeleton, two panels, a flat header or a header that is not the first row. Same options as `shell-alignment`.
