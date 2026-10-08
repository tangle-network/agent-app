# Profile editor rebuild

Synthetic Storybook consumer on drew-gtr-pro, Chromium, light theme, captured at 1280×900 and 390×844 (2× scale, stored at 1×).
The before view is `main` at 635db71f rendering the same profile with GTM's previous props; the after view is the `ProductConfigured` story, whose GitHub and MCP ports answer like a product route, including each failure. No network access.

| View | Before | After |
| --- | --- | --- |
| Desktop, full form | [before-desktop.png](before-desktop.png) | [after-desktop.png](after-desktop.png) |
| Phone, full form | [before-phone.png](before-phone.png) | [after-phone.png](after-phone.png) |

Interaction states (desktop): [model picker](desktop-model-open.png), [harness](desktop-harness-open.png), [thinking](desktop-thinking-open.png), [repository suggestions](desktop-github-repos.png), [repository not found](desktop-github-not-found.png), [no access](desktop-github-no-access.png), [path suggestions](desktop-github-paths.png), [path missing](desktop-github-path-missing.png), [not a skill](desktop-github-not-skill.png), [checked skill](desktop-github-ok.png), [invalid SHA](desktop-github-sha-invalid.png), [MCP address refused](desktop-mcp-invalid-url.png), [MCP unreachable](desktop-mcp-unreachable.png), [file drag-over](desktop-files-dragover.png), [files dropped with refusals](desktop-files-dropped.png).
Phone: [model picker](phone-model-open.png), [checked skill](phone-github-ok.png), [MCP unreachable](phone-mcp-unreachable.png), [files dropped](phone-files-dropped.png).

Browser checks reported no page errors and no horizontal overflow at either width.
Dropped files used a real `DataTransfer` with a Markdown file, a 70 KB text file, and a PNG: the Markdown file was added under `profile-trials/`, and the other two show their size and type refusals.
