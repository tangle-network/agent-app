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
Model/Effort pickers).

Toggle light/dark with the header button or `?theme=dark` on any route — this
exercises the `tokens.css` + Tailwind-preset theme contract (`./styles`,
`./tailwind-preset`). It is also the target for `bad design-audit --url http://localhost:4321/<route>`.

> Note: `vite.config.ts` pins `react`/`react-dom`/`react-konva`/`konva` to the
> playground's own copies — agent-app is linked by symlink, so without the alias
> Vite would resolve React from the parent repo's devDeps (v19) and mismatch
> react-konva. Keep the alias if you bump versions.
