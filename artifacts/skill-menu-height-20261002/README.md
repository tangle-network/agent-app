# Shared skill menu proof

Local Storybook source on Beelink1, 2026-10-02.
Baseline: `e5a053f6` plus the same 36-skill story used for the changed capture.
Changed composer SHA-256: `b5fb37bbf858d34756503717f18c2792bc564d5a1e9be8d80bb212346b8dc107`.
Target: `chatcontrols-chatcomposerslash--skills-with-file-mentions`.
These captures prove the shared component, not the hosted GTM deployment or agent execution.

| Viewport | Theme | Before menu height | After menu height | Before | After | Interaction video |
|---|---|---:|---:|---|---|---|
| 1280 × 900 | light | 686px | 330px | [Image](before-1280-agent-light.png) | [Image](after-1280-agent-light.png) | [Play](after-1280-agent-light.webm) |
| 1280 × 900 | dark | 686px | 330px | [Image](before-1280-agent-dark.png) | [Image](after-1280-agent-dark.png) | [Play](after-1280-agent-dark.webm) |
| 390 × 844 | light | 630px | 330px | [Image](before-390-agent-light.png) | [Image](after-390-agent-light.png) | [Play](after-390-agent-light.webm) |
| 390 × 844 | dark | 630px | 330px | [Image](before-390-agent-dark.png) | [Image](after-390-agent-dark.png) | [Play](after-390-agent-dark.webm) |

The panel displays eight 40px rows, keeps all 36 choices, and remains 320px wide.
Each uncut video types `/skill`, presses ArrowDown 34 times, selects with Enter, inserts an `@app` file mention, and removes the skill.
The selected row stays visible during navigation; each viewport has no horizontal page overflow.
Videos use 100ms between browser actions at normal playback speed.
All screenshots were inspected, and all videos were opened and played to completion.

Beelink gate: merged current `origin/main`, frozen install with scripts enabled, typecheck, and 129 existing affected tests passed.
The six test files cover composer, mention fallback, rich mentions, slash commands, portal clipping, and shared popover placement.
No new unit tests, dependencies, or keyboard implementation were added.
