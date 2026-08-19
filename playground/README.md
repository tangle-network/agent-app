# agent-app playground

A dev-only demo app that renders agent-app's React surfaces from the **local build**
of this repo (`@tangle-network/agent-app` via `file:..`), so you can see and QA the
component changes that no downstream app exercises yet. Not published (it lives
outside the package `files`).

## Run

```bash
# from the repo root, build the package the playground consumes:
pnpm build
# then start the demo:
cd playground
npm install      # resolves @tangle-network/agent-app -> ../ (the built dist)
npm run dev      # http://localhost:4321
```

Routes: **`/canvas`** (DesignCanvasEditor — toolbar, layers, rulers, pages),
**`/timeline`** (sequences TimelineEditor — clips + captions, transport), **`/chat`**
(web-react chat shell — messages, tool-call + proposal cards, stream-error + Retry,
Model/Effort pickers), **`/composer`** (ChatComposer inside the real host scroll
rail — see the popover hit-test below), **`/records`** (`SessionHistoryPanel`'s
row-actions kebab and `RecordGrid`'s per-cell source popover, each mounted in a
short clipping host — the popover hit-test below covers this route too),
**`/workspace`** (the default `AgentWorkspaceLayout` +
`EntryComposer` composition with the shared profile, backend, model, thinking,
and plan controls), **`/studio`** (the #450 studio surface — `MediaTile` grid
with save-to-vault popovers, `MenuPill` filter, viewer, confirm, undo toasts;
its nav-hidden sibling **`/studio/viewer`** renders only the open
`MediaViewerModal` so the hit-test can probe the save popover from INSIDE the
viewer, the z-ladder's one browser-only case).

The workspace demo intentionally omits file uploads and `@` mentions because it
has no real upload endpoint or file index.
Product apps should pass `uploadUrl` and `mentions` only after wiring those
backends.

Toggle light/dark with the header button or `?theme=dark` on any route — this
exercises the `tokens.css` + Tailwind-preset theme contract (`./styles`,
`./tailwind-preset`). It is also the target for `bad design-audit --url http://localhost:4321/<route>`.

## Deterministic a11y / contrast audit

```bash
npm run dev            # in one shell
node scripts/a11y-axe.mjs   # axe-core over /canvas /timeline /chat /workspace × light/dark
```

Returns real WCAG violations (exact contrast ratios, missing labels/roles) with
element selectors — the trustworthy alternative to LLM "visual" audits. Prefer
this for visual QA.

## Popover hit-test audit

```bash
npm run dev                                        # in one shell
SHOT_DIR=/tmp/popover node scripts/popover-hit-test.mjs                    # /composer × light/dark
SHOT_DIR=/tmp/popover ROUTE=/records node scripts/popover-hit-test.mjs     # /records × light/dark
SHOT_DIR=/tmp/popover ROUTE=/studio node scripts/popover-hit-test.mjs          # /studio × light/dark
SHOT_DIR=/tmp/popover ROUTE=/studio/viewer node scripts/popover-hit-test.mjs   # save popover inside the open viewer
```

Opens every canonical picker mounted in `/composer`'s **host scroll rail** (or,
with `ROUTE=/records`, the session-history kebab menu and the record-grid
source popover, each in its own short clipping host) and asks the only
question that decides whether a user can use it: `document.elementFromPoint`
at the open panel's own centre must return the panel. A unit test cannot
answer it — the defect this exists for shipped with the right roles, the
right items and the right `getBoundingClientRect()`, and painted zero pixels,
because the host's clipping ancestor erased the panel. Exits non-zero on any
unreachable popover and writes one screenshot per popover when `SHOT_DIR` is
set.

Triggers are enumerated by ARIA inside `[data-popover-audit]`, so a picker added
to those hosts is covered without touching the script.

> Note: `vite.config.ts` pins `react`/`react-dom`/`react-konva`/`konva` to the
> playground's own copies — agent-app is linked by symlink, so without the alias
> Vite would resolve React from the parent repo's devDeps (v19) and mismatch
> react-konva. Keep the alias if you bump versions.
