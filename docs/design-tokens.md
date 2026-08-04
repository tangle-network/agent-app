# Design tokens

`src/theme/tokens.css` is the source of truth for every colour, radius, border strength and duration the shared shell paints with.
`src/theme/tailwind-preset.ts` maps utility class names onto those tokens.
`src/theme/theme.ts` mirrors the colours into JS for the Konva canvas, which paints to a bitmap and cannot resolve `var(--…)`.

Structural reference: [Cabinet](https://runcabinet.com) (MIT) — the oklch authoring layer, the radius-from-one-root scheme, and the three-tier border idea with its per-mode inversion are theirs.
Every number below is ours: the tiers were re-measured against our surfaces and two of the four decisions came out differently.

---

## The hard constraint: nothing a pinned consumer already writes may stop resolving

Four products install this package at a pinned version and read its tokens from their own Tailwind configs and CSS.
legal-agent and gtm-agent each write `hsl(var(--border))` by hand — a Tailwind v4 `@theme` block (`--color-border: hsl(var(--border))`) plus a scrollbar-thumb rule, and gtm two more `border-color` overrides.
tax-agent maps the rest of the shadcn palette the same way in its `tailwind.config.ts` and takes `border` from this preset.

So the migration to oklch could not simply restate `--border` as an `oklch()` literal.
`hsl(oklch(0.91 0.004 286))` is not a colour; it resolves to nothing, the border paints transparent, and **nothing errors** — the exact failure class `src/theme-contract` exists to catch.

The shape that satisfies the constraint:

| layer | form | who reads it |
| --- | --- | --- |
| `--neutral-91` | `oklch(0.91 0.004 286)` — the **source** | new work; anything that needs a full colour (`color-mix`, canvas backdrop) |
| `--neutral-91-hsl` | `239.6 5.2% 88.7%` — the **mirror** | the semantic layer |
| `--border` | `var(--neutral-91-hsl)` | every consumer's existing `hsl(var(--border))`, unchanged |

CSS cannot convert oklch into a bare channel triple, so the mirror is written out rather than derived.
`tests/theme/tokens-contract.test.ts` converts each oklch stop to HSL and fails if its mirror has moved, so the two forms cannot disagree without a red test.

**What this does NOT change:** any token name, the `hsl(var(--x))` consumption pattern, the `/50` opacity modifier, `--radius-md`'s value, or any exported symbol.
`AgentAppTheme` gained two optional fields.

**What DOES change visibly on upgrade,** and there are exactly two things:

1. `border-border` now paints the soft tier in light mode (see [Border tiers](#4-border-tiers-that-invert-per-mode)). In dark it is unchanged, because the tiers collapse there. This is the point of the change; opting out is one line, below.
2. Every neutral moved to its nearest ramp rung. The largest move is ΔL 0.0124 in oklch lightness, which is at or under one just-noticeable difference for a flat area; brand hues did not move at all. Full table in [the ramp](#2-chroma-discipline-and-the-ladder).

---

## 1. oklch, not HSL

HSL lightness is not perceptually uniform and HSL saturation is not chroma, so evenly-spaced HSL numbers are not evenly-spaced greys.
Measured on the ramp this replaced — the same nominal "S 5–7%" across every neutral:

| token | HSL | oklch chroma |
| --- | --- | --- |
| `--card` (light) | `240 7% 97%` | 0.0014 |
| `--border` (light) | `240 6% 89%` | 0.0045 |
| `--muted-foreground` (light) | `240 5% 38%` | 0.0154 |

An 11x chroma spread across values that all read as "the same 5–7% blue tint".
The ramp visibly gained blue as it darkened, and nothing in the file said so.

The mirror shows the same fact from the other side: holding chroma at a constant 0.004 needs `S 17.2%` at L 0.97 and `S 1.3%` at L 0.49.
Those two numbers describe the *same* tint.

---

## 2. Chroma discipline and the ladder

**One constant chroma, not zero.** `0.004` at hue `286`.

Zero was the other option and it is wrong for this fleet.
The dark surfaces — the largest painted areas in these products — are deliberately cool, matching `@tangle-network/brand` (Tangle Quiet), and chroma 0 would visibly warm all of them.
The defect was never that the neutrals carried a tint; it was that the tint wandered by 11x.
So the tint stays and stops moving.

The terminal stop is chroma 0 because sRGB admits no chroma at L 1 — white is the only colour there.

**The ladder.** One rule, checkable, and the stop's name is its lightness:

```
L = 0.16 + 0.03n        n = 0 … 28
--neutral-16  --neutral-19  --neutral-22  --neutral-25  …  --neutral-97  --neutral-100
```

**Step size 0.03**, base 0.16, terminal 1.00.
0.03 is not arbitrary: fitting the fifteen distinct neutrals this replaced against every uniform step from 0.02 to 0.07 put the best possible fit at 0.0289 with a worst error of 0.0075, and 0.03 — a step you can hold in your head, whose every rung is a two-decimal number — costs 0.0041 more.

Only the ten rungs the system uses are declared.
A ramp token nobody paints with is dead weight; the *rule* is the ladder, and the test enforces it on whatever is declared.

Both themes read the same ladder and differ only in which rung each role picks — light from the top down, dark from the bottom up.
The dark scope never redefines the ramp, and a test fails if it starts to.

### Where every neutral landed

| mode | token | was | ramp stop | ΔL |
| --- | --- | --- | --- | --- |
| light | `--background` / `--popover` | `0 0% 100%` (L 1.0000) | `--neutral-100` (L 1.00) | +0.0000 |
| light | `--card` | `240 7% 97%` (L 0.9759) | `--neutral-97` (L 0.97) | -0.0059 |
| light | `--secondary` / `--muted` / `--accent` | `240 6% 93%` (L 0.9439) | `--neutral-94` (L 0.94) | -0.0039 |
| light | `--canvas-backdrop` | `240 7% 90%` (L 0.9190) | `--neutral-91` (L 0.91) | -0.0090 |
| light | `--border` / `--input` | `240 6% 89%` (L 0.9115) | `--neutral-91` (L 0.91) | -0.0015 |
| light | `--muted-foreground` | `240 5% 38%` (L 0.4784) | `--neutral-49` (L 0.49) | +0.0116 |
| light | `--secondary-foreground` / `--accent-foreground` | `0 0% 10%` (L 0.2156) | `--neutral-22` (L 0.22) | +0.0044 |
| light | `--foreground` / `--card-foreground` / `--popover-foreground` | `0 0% 5%` (L 0.1579) | `--neutral-16` (L 0.16) | +0.0021 |
| dark | every `*-foreground` | `240 6% 93%` (L 0.9439) | `--neutral-94` (L 0.94) | -0.0039 |
| dark | `--muted-foreground` | `240 4% 62%` (L 0.6894) | `--neutral-70` (L 0.70) | +0.0106 |
| dark | `--popover` | `240 4% 13%` (L 0.2439) | `--neutral-25` (L 0.25) | +0.0061 |
| dark | `--border` | `240 3% 13%` (L 0.2450) | `--neutral-25` (L 0.25) | +0.0050 |
| dark | `--destructive-foreground` | `0 0% 12%` (L 0.2376) | `--neutral-25` (L 0.25) | +0.0124 |
| dark | `--secondary` / `--muted` / `--accent` / `--input` | `240 5% 11%` (L 0.2218) | `--neutral-22` (L 0.22) | -0.0018 |
| dark | `--card` | `240 5% 8%` (L 0.1894) | `--neutral-19` (L 0.19) | +0.0006 |
| dark | `--background` / `--canvas-backdrop` | `240 8% 5%` (L 0.1540) | `--neutral-16` (L 0.16) | +0.0060 |

`--canvas-backdrop` and `--border` now share a rung; they were 0.0075 apart and never touch.

`--primary`, `--destructive`, `--ring`, `--success` and `--warning` keep their measured HSL exactly.
Moving them would move agent-app off the brand palette and off status colours that were tuned to clear WCAG AA as *text* on tinted chips.

### Contrast, before and after

Every text pair that carries a WCAG obligation still clears AA.

| pair | before | after |
| --- | --- | --- |
| light `--foreground` on `--background` | 19.47 | 19.42 |
| light `--muted-foreground` on `--background` | 6.61 | 6.27 |
| light `--muted-foreground` on `--muted` | 5.60 | 5.25 |
| light `--secondary-foreground` on `--secondary` | 14.84 | 14.52 |
| dark `--foreground` on `--background` | 16.61 | 16.27 |
| dark `--foreground` on `--popover` | 13.82 | 13.42 |
| dark `--muted-foreground` on `--background` | 7.03 | 7.26 |
| dark `--muted-foreground` on `--muted` | 6.19 | 6.48 |

Light muted text gives up the most (5.60 → 5.25 at its tightest) and stays well clear of 4.5; dark muted text gains.

---

## 3. Radius from one root

```css
--radius-base: 0.625rem;
--radius-sm:  calc(var(--radius-base) * 0.6);  /* 0.375rem — 6px  */
--radius-md:  calc(var(--radius-base) * 0.8);  /* 0.5rem   — 8px  */
--radius-lg:  var(--radius-base);              /* 0.625rem — 10px */
--radius-xl:  calc(var(--radius-base) * 1.4);  /* 0.875rem — 14px */
--radius-2xl: calc(var(--radius-base) * 1.8);  /* 1.125rem — 18px */
--radius-3xl: calc(var(--radius-base) * 2.2);  /* 1.375rem — 22px */
```

The root is pinned at `0.625rem` by an existing consumer, not by taste: `--radius-md` shipped as `0.5rem`, gtm-agent reads it for its composer send button, the bridged sandbox-ui MD3 components read it too, and `0.625 x 0.8 = 0.5` exactly.
A test asserts that product, so a future change to the root that moves `--radius-md` goes red.

### Why the root is `--radius-base` and not `--radius`

Two of the four products already own `--radius` — tax-agent sets `0.5rem`, legal-agent `0.625rem` — and both do it inside `@layer base`.
This file is loaded as a plain linked stylesheet, which is **unlayered**, and an unlayered declaration beats any layered one.
Shipping `:root { --radius }` here would therefore silently seize a token products already drive their own scales from, reproportioning their entire chrome on upgrade.

A product that wants its own root to drive this ladder opts in with one line:

```css
:root { --radius-base: var(--radius); }
```

### Why `rounded-md` was not remapped

The token ladder and Tailwind's utility ladder share names at different values — `--radius-md` is 8px, `rounded-md` is 6px.
Remapping would silently resize 302 existing `rounded-*` usages across four products.
The preset instead adds three semantic names Tailwind does not own:

| utility | token | px |
| --- | --- | --- |
| `rounded-control` | `--radius-sm` | 6 |
| `rounded-card` | `--radius-lg` | 10 |
| `rounded-surface` | `--radius-2xl` | 18 |

---

## 4. Border tiers that invert per mode

Three strengths of the same border colour, because a divider inside a panel and the edge of a card floated on the page are not the same line.
Shipping one strength for both is what makes a UI read boxy.

| tier | light | dark | for |
| --- | --- | --- | --- |
| `--border-soft` | 40% | **100%** | dividers, de-emphasised edges — what `border-border` maps to |
| `--card-edge` | 60% | **100%** | a container that must read as a container |
| `hsl(var(--border))` | 100% | 100% | form-field edges (`--input`), deliberate emphasis (`border-strong`) |

### The measurement

A 1px hairline, contrast of the composited line against the surface it sits on, rendered in Chromium and read back at 1:1 pixel scale by `playground/scripts/token-render.mjs`:

| alpha | light: background | light: card | light: muted | dark: background | dark: card | dark: muted |
| --- | --- | --- | --- | --- | --- | --- |
| 22% | 1.060 | 1.044 | 1.026 | 1.031 | 1.020 | 1.012 |
| 40% | 1.108 | 1.072 | 1.036 | 1.057 | 1.048 | 1.023 |
| 60% | 1.176 | 1.120 | 1.063 | 1.108 | 1.081 | 1.046 |
| 100% | 1.311 | 1.205 | 1.102 | 1.212 | 1.158 | 1.085 |

### Why light is 40 / 60 and not the reference's 22 / 55

The reference's light `--card` is `oklch(1 0 0)` — the *same colour as its background*, 1.000 contrast.
Its card edge is the only thing separating a card from the page, so 22% for a divider and 55% for a card edge is the right split for that system.

Ours is not that system.
Our light `--card` is L 0.97 on a L 1.00 background, a fill step of 1.091 on its own, so the edge only has to confirm a container the fill already suggests.
That argues for a *weaker* card edge — and the measurement argues the other way for the soft tier, because that same darker card leaves a hairline less room: at 22% a divider on `--card` sits at 1.044 and is simply not visible.

So both numbers moved, in opposite directions from the reference:

- **soft 40%** — the point at which a divider still resolves on `--card` (1.072), which is where most of this package's dividers actually sit.
- **card edge 60%** — far enough above the soft tier (1.176 vs 1.108) to read as a different decision, and short of the 1.311 that reads as a box.

The two candidate values in between, 35% and 45%, are within measurement noise of their neighbours on `--card`; the render is what separated them, not the ratio.

### Why dark inverts

The same measurement on the dark ramp forces the opposite answer.
Dark `--border` (L 0.25) is *already* at the edge of visible at full strength — 1.212 on background, 1.158 on card, 1.085 on muted.
Applying the light soft tier takes those to 1.057 / 1.048 / 1.023, which is not a quieter line, it is no line.

A tier system that erases the thing it is tiering is worse than no tiers, so dark collapses the three to one.
The load-bearing test is `dark INVERTS: both tiers are full strength` — "harmonising" dark to soften like light is the exact change that erases the border, and that test is what stops it.

### The preset is the lever

`border-border` appears 151 times across 35 files in this package alone, and again in every consumer.
17 of those lines also carry a shadow; 9 are `shadow-lg` and 2 `shadow-xl` on genuinely floating overlays, but 6 are `shadow-sm` on cards that do not float — a full-strength edge and a lift, doing the same job twice.
Editing 151 call sites to say `border-soft` is the same change spelled 151 times, and the next component written would still say `border-border`.

So the remap lives in one place:

```ts
borderColor: {
  border: tier('--border-soft'),      // border-border
  'card-edge': tier('--card-edge'),   // border-card-edge
  strong: 'hsl(var(--border))',       // border-strong
}
```

`colors.border` is untouched, so `bg-border` — a rule whose whole job is to be seen — stays full strength, and `border-input` is untouched because a form field's edge is a control affordance, not a divider.

**`tier()` is not cosmetic.** Pointing a utility straight at `var(--border-soft)` makes Tailwind **drop** `border-border/50` from the output entirely rather than emit it un-modified — verified against Tailwind 3.4.19.
The element then falls back to `currentColor` and nothing errors.
This package has 18 such usages.
Wrapping the token in a `color-mix` that consumes `<alpha-value>` keeps the token as the source *and* composes with the modifier: bare gives 100% of the tier, `/50` gives half of it.

### Why `src/theme-contract` was not extended to cover the tier utilities

That checker's utility list is deliberately narrow: it names only the families that have actually shipped **invisible**, which are all backgrounds (`bg-card`, `bg-popover`, the `surface-container` ladder).
A missing token in a background paints transparent and nothing errors.

A missing tier token does not do that.
Measured in Chromium: `border: 1px solid color-mix(in oklch, var(--missing) …)` falls back to `currentColor` — on an element with `color: rgb(10, 20, 30)` the border computes to exactly `rgb(10, 20, 30)`.
A hard border in the text colour is loud, and the same is already true of the `hsl(var(--x))` border form.
Adding loud failures to a list whose stated scope is silent ones would dilute the one thing it promises.

### Opting out

| you want | do this |
| --- | --- |
| the old single strength, everywhere | `:root { --border-soft: hsl(var(--border)); --card-edge: hsl(var(--border)); }` |
| the old `border-border` only | in your Tailwind config: `borderColor: { border: 'hsl(var(--border))' }` |

A Tailwind v4 app defines its own `--color-border` inside `@theme` and this preset cannot reach it.
To adopt the tiers there, point that one line at the tier: `--color-border: var(--border-soft);`.

---

## 5. Motion

There were no motion tokens.
64 transitions in this package ran on Tailwind's implicit 150 ms and default curve, with one `duration-300` and no named easing anywhere.
Nothing was wrong; nothing was decidable either.

```css
--duration-instant: 90ms;    --ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
--duration-fast:   150ms;    --ease-entrance: cubic-bezier(0.22, 1, 0.36, 1);
--duration-base:   240ms;    --ease-exit:     cubic-bezier(0.4, 0, 1, 1);
--duration-slow:   360ms;
```

| duration | for |
| --- | --- |
| `instant` 90ms | a control acknowledging a pointer (hover/active colour) |
| `fast` 150ms | a state change on a control already on screen |
| `base` 240ms | a surface arriving or leaving (popover, panel, disclosure) |
| `slow` 360ms | a full-height surface travelling (drawer, sheet, sidebar) |

A x1.5-ish ladder rather than round numbers, because what a user perceives is the ratio.
`fast` is 150 ms deliberately: it is what those 64 transitions already run at, so adopting the token is a rename, never a retune.

Entrances decelerate hard and land softly; state changes decelerate normally; exits **accelerate** away, because someone who dismissed a thing is done with it and should not wait for it to glide out.

Three composites are what components actually reach for:

```css
--motion-control: var(--duration-fast)    var(--ease-standard);
--motion-surface: var(--duration-base)    var(--ease-entrance);
--motion-dismiss: var(--duration-instant) var(--ease-exit);

/* transition: background-color var(--motion-control); */
```

Tailwind names are wired too — `duration-instant|fast|base|slow`, `ease-standard|entrance|exit` — alongside Tailwind's own numeric durations and in/out curves, not displacing them.

No animation library. Keyframes and transitions only.

### Reduced motion, at the token layer and at the floor

```css
@media (prefers-reduced-motion: reduce) {
  :root { --duration-instant: 1ms; --duration-fast: 1ms; --duration-base: 1ms; --duration-slow: 1ms; }

  *:where(:not([data-motion='essential'], [data-motion='essential'] *)) {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }

  html { scroll-behavior: auto !important; }
}
```

Two rules covering two populations.
Collapsing the duration **tokens** is what makes motion built on this system honour the preference for free — a component that wrote `var(--motion-surface)` needs no media query of its own and gets no chance to forget one.
The universal rule under it is the floor for everything that predates the tokens: the 64 transitions here and every component in a consumer's own app, none of which read a token.

**1ms, not 0.** A zero-duration transition fires no `transitionend`, and any component awaiting one to unmount or advance a state machine hangs forever.

**`!important` here, where the `:focus-visible` floor deliberately did not use it.**
Focus styling is a design decision a component is entitled to make differently.
Reduced motion is not a design decision — it is an explicit request from the person using the product, and a component overriding it is a defect.
Motion that genuinely carries meaning (a determinate progress bar, a live-status pulse) opts out with `data-motion="essential"`, which covers the element and its subtree; `:where()` keeps the selector at zero specificity so a consumer's own `!important` can still win.

Measured in Chromium, both preference states:

| | normal | reduce |
| --- | --- | --- |
| transition reading `var(--motion-surface)` | 0.24s | 0.001s |
| transition reading no token (`opacity 400ms ease`) | 0.4s | 0.001s |
| the same, under `data-motion="essential"` | 0.4s | 0.4s |

---

## 6. Foreground pairings that a theme flip inverts

The tiers above stop an edge from disappearing.
This is the other direction: a foreground token that is right against one theme's fill and illegible against the other's.
Both cases below shipped, and neither is visible in the CSS — each reads as obviously-correct until the surface under it is rendered.

### `--warning-strong`

`--warning-foreground` is dark ink for a **solid** gold chip, and it is theme-invariant because a solid gold chip is.
The approval card is not that surface: it is `bg-warning/[0.06]`, a tint that tracks the page, so the same ink measured 13.51:1 in light and **1.24:1 in dark** — the eyebrow was there in one theme and gone in the other.

No single lightness fixes it, which is the whole reason a third token exists:

| ramp | light card `rgb(251,248,240)` | dark card `rgb(27,22,16)` |
| --- | --- | --- |
| `hsl(41 96% 28%)` | **5.17** | 3.27 |
| `hsl(41 96% 30%)` | 4.67 | 3.63 |
| `hsl(41 96% 34%)` | 3.77 | 4.50 |
| `hsl(41 96% 38%)` (`--warning`) | 3.07 | 5.51 |
| `hsl(40 94% 56%)` | 1.67 | **10.11** |

Light needs L ≤ 30%, dark needs L ≥ 34%, and the windows do not overlap.
So `--warning-strong` re-themes (28% / 56%) where `--warning` and `--warning-foreground` deliberately do not, and the preset exposes it as `text-warning-strong` **alongside** `warning.DEFAULT` and `warning.foreground` rather than displacing either.

### `--primary-foreground` inverts in dark

Dark `--primary` is `239 84% 74%` so that primary clears AA *as text* on a `primary/10` tint.
That same lightness makes the **solid** button a light fill, and the inherited white label measured **3.02:1** on it.
Dark now takes `--primary-foreground: var(--neutral-16-hsl)` — 6.44:1 on the same fill — while light keeps white on indigo at 6.01:1.
This is a visible change to every solid primary button in dark across the fleet, and it is the only value that makes the label readable.

### A divider token is not a graphic

`AsyncView`'s busy spinner was `border-2 border-border`, which resolves to the **soft** tier — a token tuned to be barely there.
On its own panel it measured 1.10:1 in light and 1.20:1 in dark, against the 3:1 a meaningful graphic needs, and it is the only signal that a fetch is running.
It is now `border-primary` (5.89:1 / 6.17:1), which is also what the composer's send spinner already used.

---

## Reproducing the numbers

```bash
cd playground && npm install
node scripts/token-render.mjs                 # contrast tables + chain + motion, PASS/FAIL
node scripts/token-render.mjs --out /tmp/x    # also writes the tier sweep PNG
```

It reads `src/theme/tokens.css` from disk and resolves everything through a real browser, so it measures the whole `--border` → ramp stop → triple → `hsl()` → `color-mix()` chain rather than a re-implementation of it.
Colours are rasterised on a canvas before being read: `getComputedStyle` keeps a `color-mix(in oklch, …)` in oklch form, and reading three oklch components as if they were RGB bytes is how the script first reported a pale grey hairline at 20.97:1 against white.

## What the tests hold

`tests/theme/tokens-contract.test.ts`:

- every `var(--…)` a React surface references is defined, and every `var(--…)` tokens.css references is defined by tokens.css
- every ramp stop sits on `L = 0.16 + 0.03n`, and its name equals its lightness
- chroma is the one constant (0 only at L 1), hue is the one hue
- every oklch stop's HSL mirror still resolves to the same colour
- every neutral semantic token points at a ramp stop rather than a loose triple
- light/dark parity, and the dark block never restates a value verbatim or redefines the ramp
- the light tiers are ordered and still resolve as a 1px line; **dark keeps both at full strength**; the same softening measurably buys less in dark
- the radius steps all derive from one root, `--radius-md` is still `0.5rem`, and bare `--radius` is not defined
- every duration collapses under reduced motion, to a non-zero value; the floor reaches untokenised motion; `data-motion="essential"` is exempt
- the JS mirror in `theme.ts` matches tokens.css in both modes
- the preset maps `border-border` to the soft tier, every tier survives the `/50` modifier, and every token the preset names exists
- the approval eyebrow and the solid primary button both clear AA **in both themes**, and no single warning lightness could have served both — so deleting `--warning-strong` fails rather than silently regressing one theme
- no spinner is painted in the divider tier, and the colour they use instead clears 3:1 on both surfaces

Each of those was verified by breaking the thing it guards and watching it go red.
