Recorded Storybook component fixtures for PR #1590. Both heads use the same existing historical locked story with `forge`, and the same deciding expectation. These are original screenshots and uncut recordings, copied without edits.

Before source: [`c339c3eaf42ed2d91f99f937d4fe673c006907b8`](https://github.com/tangle-network/agent-app/commit/c339c3eaf42ed2d91f99f937d4fe673c006907b8), tree `667e66ca64c48c825e6829840086545f653f841a`. Both locked views actually show `Select harness` instead of `forge`: product exit `1`, capture and custody exits `0`, complete journey.

After source: [`4ac8bc73134d9e3565b36d64611947bb9d3749bc`](https://github.com/tangle-network/agent-app/commit/4ac8bc73134d9e3565b36d64611947bb9d3749bc), tree `18439f179762996e88af52607afc33c264f11238`. Both locked views show `forge`: product, capture and custody exits `0`, complete journey and passing result.

| State | Before | After |
| --- | --- | --- |
| Locked desktop, 1440 × 960 px, dark | [Screenshot](before-locked-desktop-dark-1440.png) | [Screenshot](after-locked-desktop-dark-1440.png) |
| Locked phone, 390 × 844 px, light | [Screenshot](before-locked-phone-light-390.png) | [Screenshot](after-locked-phone-light-390.png) |
| Hover hint, desktop dark | [Screenshot](before-locked-hover-dark-1440.png) | [Screenshot](after-locked-hover-dark-1440.png) |
| Tab focus, desktop dark | [Screenshot](before-locked-focus-dark-1440.png) | [Screenshot](after-locked-focus-dark-1440.png) |
| Active Claude Code checked, phone light | [Screenshot](before-active-claude-code-light-390.png) | [Screenshot](after-active-claude-code-light-390.png) |
| Complete original journey | [Video, 9.12 s](before-locked-harness-journey.webm) | [Video, 8.60 s](after-locked-harness-journey.webm) |

Both journeys exercise the real locked hint/focus and pointer/keyboard nonselection, then active OpenCode → Claude Code selection and checkmark. Model and effort labels stay unchanged; Forge is absent from active choices. Owned browser/context/server closure was verified. Callback count is unobserved. This component evidence does not establish persisted-thread loading, backend/native-death behavior, Legal, production serving or full qualification. Actual Inter font reads succeeded; unused font faces are outside the claim.

[manifest.json](manifest.json) records immutable source identities and original media sizes, digests, dimensions, themes and durations.
