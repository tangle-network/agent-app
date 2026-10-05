---
"@tangle-network/agent-app": minor
---

Add `@tangle-network/agent-app/tailwind.css`, the one stylesheet an agent app imports after `tailwindcss`. It brings in `@tangle-network/sandbox-ui/tailwind.css` (Brand tokens and registrations, Sandbox UI runtime CSS, and the sources for Sandbox UI and ui), then this package's tokens, and declares the source for this package's `dist`, so an app deletes its `node_modules` `@source` lines, the same globs in Tailwind `content`, and its `sandbox-ui/styles` and `agent-app/styles` links. Every shared utility compiles once in the app's layer order. Requires `@tangle-network/sandbox-ui` 0.125.0 or later; the peer range widens to `<0.126.0`. The chat template uses the entry. In an adopting app `rounded-full` becomes Brand's 999px (the same circle). `--radius-2xl`/`--radius-3xl` are now Tailwind's 1rem/1.5rem, the values every app already rendered.
