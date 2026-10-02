# Canonical Brand theme: rendered evidence

These captures use the package's source Storybook stories for the actual React
Canvas editor and Chat approval message. `after/` contains light and dark
desktop (1440 px) and phone (390 px) screenshots. `interactive/` records
pointer and keyboard checks: Canvas zoom changed 63% → 73% → 63% by pointer
then Enter, and Chat details expanded, Reject received keyboard focus and a
pointer callback, at desktop and phone widths. All checked pages had no
browser errors or horizontal overflow; see the JSON reports beside the images.

The `before/` Canvas desktop images came from the old theme at the same story
and viewport. The old Storybook import order left its Canvas stage at 0 × 0:
the unscoped `.hidden` utility followed the responsive `.sm:block`. To compare
the palettes on the real document, the baseline browser received only the
equivalent responsive display rule that this PR now supplies through stylesheet
order. Its source theme colors were unchanged. `before/results.json` records
that comparison correction. The PR's `after/` screenshots use the committed
Storybook stylesheet order with no browser override.

| Surface | Light | Dark |
| --- | --- | --- |
| Canvas desktop | [image](after/canvas-agent-light-1440.png) | [image](after/canvas-agent-dark-1440.png) |
| Canvas phone | [image](after/canvas-agent-light-390.png) | [image](after/canvas-agent-dark-390.png) |
| Chat desktop | [image](after/chat-agent-light-1440.png) | [image](after/chat-agent-dark-1440.png) |
| Chat phone | [image](after/chat-agent-light-390.png) | [image](after/chat-agent-dark-390.png) |

The packed archive check is executable with `pnpm test:theme:packed`. It packs
Agent App, extracts the archive into a fresh consumer without Brand installed,
resolves `/styles`, `/theme`, `/tailwind-preset`, and `/theme-contract`, then
paints the exported CSS in Chromium at both widths and motion preferences. It
checks light/dark/nested/named scopes, field well versus edge, AA contrast for
the primary control and approval warning, focus, animation reduction, errors,
and overflow. Its report and two captures can be written to a chosen path:

```sh
pnpm test:theme:packed /tmp/agent-app-theme-packed
```

Changing `src/theme/tailwind-preset.ts` so `bg-input` used the border role
instead of Brand's field well made `tokens-contract.test.ts` fail (1 of 7
tests); restoring the implementation made the focused theme suite pass 19/19.
