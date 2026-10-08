---
"@tangle-network/agent-app": patch
---

`SessionHistoryPanel` uses the shared ui controls: the search is an `Input`, the sort is a `Select`, the bulk actions are `Button`s, the session-age field is a small `Input`, each row's selector is a `Checkbox`, and the actions trigger is a ghost icon `Button`. The native select and checkboxes had rendered at browser sizes on the page background.
