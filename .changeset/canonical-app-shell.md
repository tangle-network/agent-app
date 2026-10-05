---
"@tangle-network/agent-app": minor
---

Add the canonical product shell to `/workspace-react`: `AgentWorkspaceLayout` takes `product` (name, mark, home) and `workspace` (name, noun, options, list and create routes) and draws one rail top and switcher for every product — long names truncate with the full text as a tooltip, and a workspace with nowhere else to go renders as text, not a one-item menu. Add `WorkspaceList`, the shared listing page (list or grid, product fields as aligned columns, search past eight items, designed empty state, rename/delete in an overflow menu behind a confirmation, no counting copy). `PopoverSurface` accepts `side` and `align`. Explicit `logo`/`railHeaderContent` keep working for unmigrated products.
