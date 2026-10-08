# Agent profile inspector

The profile viewer and editor now group configuration in cards with shared Brand surface, border, and icon color roles. System prompt, appended system prompt, and project instructions retain their exact schema field names. Owner-authorized contexts can inspect and export the complete supplied JSON.

Source: `927fdb96ef01283ecf420fbead656408b6f82e3e`. Before: `c8f15809`. These captures use synthetic Storybook profiles on Beelink2, at 1440 × 1000 and 390 × 1000 browser viewports. Full-page screenshots extend vertically. They are component evidence, not production or physical-phone proof.

| Before | After | Why |
| --- | --- | --- |
| [Desktop, light](before-viewer-1440-agent-light.png) | [Desktop, light](after-viewer-1440-agent-light.png) | Cards separate profile groups from the app canvas. |
| [Desktop, dark](before-viewer-1440-agent-dark.png) | [Desktop, dark](after-viewer-1440-agent-dark.png) | One surface and border hierarchy works in both themes. |
| [Phone, light](before-viewer-390-agent-light.png) | [Phone, light](after-viewer-390-agent-light.png) | Explicit prompt labels and paths remain legible at phone widths. |
| [Phone, dark](before-viewer-390-agent-dark.png) | [Phone, dark](after-viewer-390-agent-dark.png) | Content remains contained without page overflow. |
| [Editor, desktop](before-editor-1440-agent-light.png) | [Editor, desktop](after-editor-1440-agent-light.png) | Editing uses the same cards and prompt vocabulary as viewing. |
| [Editor, phone](before-editor-390-agent-light.png) | [Editor, phone](after-editor-390-agent-light.png) | The form preserves draft and validation behavior. |

New full-profile views: [JSON tree on phone](after-tree-390-agent-light.png), [Raw on desktop](after-raw-1440-agent-dark.png), [Raw on phone](after-raw-390-agent-light.png). Raw code scrolls within its own keyboard-focusable container. [Dark editor](after-editor-390-agent-dark.png).

Original uncut walkthroughs: [desktop](profile-inspector-1440.webm), [phone](profile-inspector-390.webm). The recordings pause so the reviewer can read each state: overview, tree disclosure, extensions, Raw, copy, download, and return to overview. No production data or credentials appear. Decoded frames were inspected. Original playback remains unverified: native CUA transport failed, then the browser rejected the local file URL. The recordings are retained for later review.

[Qualification receipt](qualification.json) records checks and media hashes. Frozen install with prepare/build, typecheck, and 50 affected checks passed at the source above. Browser journeys passed in both viewports and themes, plus a long-profile phone case. Copy and downloaded JSON matched exactly and retained extensions, null values, arrays, and MCP configuration. The default overview still hides private MCP details. Keyboard tabs and disclosures, editor save, invalid-JSON save blocking, and page overflow were checked.

`showFullProfile` defaults to false. The host must authorize full inspection; it exposes the complete supplied configuration without redaction. JSON is the configured profile, not the complete runtime request. The product separately explains task, conversation, and authorized integration additions.
