# Design tokens

## Ownership

`@tangle-network/brand` owns shared color, type, radius, motion, shadow, and
status values. Agent App consumes Brand's published light-default stylesheet at
build time. The development pin selects the artifact used to generate releases;
Brand remains an optional peer for consumers that use other Brand exports.

Agent App owns its application behavior: focus treatment, composer exemptions,
message and editor aliases, arrival animation, and reduced-motion behavior.
These live in `src/theme/tokens.css`. It imports Brand's
`styles/legacy-light.css` and the checked projection in
`src/theme/compat.generated.css`. Do not import Brand's dark-default entry in
the same page or copy its palette into another Agent App file.

`src/theme/build.mjs` produces two tracked compatibility artifacts from the
published Brand CSS: HSL channels and radius ratios in
`compat.generated.css`, and the light/dark JS and bitmap snapshots in
`brand.generated.ts`. Both carry the input SHA-256. `--check` fails if either
projection is stale. `--dist` writes a self-contained
`dist/theme/tokens.css`; the public `@tangle-network/agent-app/styles` export
contains the Brand source exactly once and has no runtime CSS imports.

```sh
node src/theme/build.mjs --check
pnpm build
```

For an intentional Brand upgrade, change the development pin and lockfile,
inspect the new Brand contract, run `node src/theme/build.mjs --write`, then
review and test the generated diff. Do not edit generated values by hand.

## Public contracts

| Entry | Purpose |
| --- | --- |
| `@tangle-network/agent-app/tailwind.css` | Tailwind v4 source entry for agent apps. Imports `@tangle-network/sandbox-ui/tailwind.css` (Brand tokens, named themes and registrations, Sandbox runtime CSS, and the sources for Sandbox UI and ui), then this package's tokens, and declares the source for this package's `dist`. |
| `@tangle-network/agent-app/styles` | Light-default stylesheet with explicit dark, light, and Brand named scopes, for an app without a Tailwind compile. |
| `@tangle-network/agent-app/theme` | Browser-safe `lightTheme`, `darkTheme`, `themeToCssVars`, and concrete bitmap Canvas colors. No runtime Brand or Node import. |
| `@tangle-network/agent-app/tailwind-preset` | Existing utility names mapped to Brand roles and Agent App compatibility names. |
| `@tangle-network/agent-app/theme-contract` | Node-only source scanner for missing CSS variables and selected dangerous utility names. |

## One stylesheet entry

An agent app that compiles Tailwind imports one package file and lists no
`node_modules` paths:

```css
@import 'tailwindcss';
@import '@tangle-network/agent-app/tailwind.css';
@config '../tailwind.config.ts'; /* presets: [agentAppPreset] */

/* the app's own rules */
```

Delete the app's `@source` lines for `node_modules/@tangle-network/*/dist`,
the same globs in the Tailwind config `content`, and the `<link>` or `@import`
of `@tangle-network/sandbox-ui/styles` and `@tangle-network/agent-app/styles`.
The entry carries all of them, and every shared utility compiles once, in the
app's own layer order.

Each package declares the sources for its own `dist`; Tailwind resolves an
`@source` relative to the installed file, under pnpm and npm alike. Brand's
utility registrations arrive as `theme(default)`, so the preset decides any
name it also maps (`border-border`, `surface-container-*`), as it did when the
app's compile loaded after the precompiled Sandbox bundle. Names only Brand
registers, such as `text-eyebrow` and `bg-depth-1`, still compile.

Two values move when an app adopts the entry, because the owner's value now
applies where an extra copy of Tailwind's defaults used to win:
`rounded-full` is Brand's `999px` instead of `calc(infinity * 1px)` (the same
circle), and `rounded-2xl`/`rounded-3xl` follow this package's
`--radius-2xl`/`--radius-3xl` (18px and 22px at the default scale) instead of
Tailwind's 16px and 24px.

`tests/theme/tailwind-entry.test.ts` compiles the built entry from outside
the repo and fails if an Agent App, Sandbox UI or ui component utility is
missing, if a utility is emitted twice, or if Brand overrides the preset.

Legacy `--background`, `--card`, `--popover`, `--border`, `--input`, status,
and related values remain HSL **channels** so existing `hsl(var(--…))` callers
continue to paint. Brand's full-color MD3 surface ladder remains available as
`--md3-surface-container*`; the preset points to those actual tiers.

The field edge and well are distinct. `--input` and `border-input` refer to the
border/off-track channel; `--bg-input` and `bg-input` use Brand's recessed fill.
`AgentAppTheme.inputFill` is optional for existing custom theme objects, which
fall back to the previous card fill. `--radius-base` remains a host scaling
hook. Agent App does not declare the host-owned bare `--radius`.

The primary, success, destructive, and warning channels adapt Brand's ink
roles for existing Agent App text and solid-control usage. The corresponding
solid foregrounds are selected from Brand's own ink endpoints and checked for
AA contrast during generation. `--warning-strong` supplies the warm label on
subtle approval surfaces; a solid warning chip keeps
`--warning-foreground`. The Canvas renderer receives concrete colors generated
from Brand because its bitmap cannot resolve CSS variables.

## Scopes and overrides

An unpinned root is light. `.dark`, `.light`, `[data-theme]`, and Brand's named
themes select explicit scopes. Agent App's aliases rebind at each theme
boundary so a nested mode uses its own values. Host overrides should live on
the boundary that owns the theme and follow the package stylesheet in cascade
order. If a host changes both a field well and its utility-specific channel,
keep those values paired; `--input` remains the edge.

```css
[data-theme='customer'] {
  --card: 0 0% 100%;
  --popover: 210 20% 96%;
  --input: 210 10% 45%;
  --bg-input: #f1f3f5;
}
```

The example is a host override, not an additional Agent App default. A custom
mode that changes inherited Brand roles must also supply coherent text and
surface pairings; inspect it in the consuming product.

## Verification

`tests/theme/tokens-contract.test.ts` checks the canonical input hash,
self-contained packed stylesheet, generated freshness, required HSL and bitmap
forms, source variable references, and utility mappings. The theme-contract
scanner follows the source stylesheet's local and package CSS imports; the
installed public stylesheet has already inlined them. Focus and loading
announcement tests keep their independent accessibility protections.

Tests on the stylesheet do not prove a product layout. Capture the actual
Canvas and Chat React stories in light and dark modes at desktop and phone
widths when changing this contract. Compare the rendered surfaces, keyboard
focus, pointer controls, errors, and overflow. Pack and resolve the public
styles, theme, and preset in an isolated consumer before publication; after
publication, repeat against the anonymous registry archive.
