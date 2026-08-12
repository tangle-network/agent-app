# Design tokens

`src/theme/tokens.css` is the source of truth for every colour, radius, border strength and duration the shared shell paints with.
`src/theme/tailwind-preset.ts` maps utility class names onto those tokens.
`src/theme/theme.ts` mirrors the colours into JS for the Konva canvas, which paints to a bitmap and cannot resolve `var(--…)`.

Structural reference: [Cabinet](https://runcabinet.com) (MIT) — the oklch authoring layer, the radius-from-one-root scheme, and the three-tier border idea are theirs.
Every number below is ours: the tiers were re-measured against our surfaces, and the surface ladders were re-rung after an elevation audit measured the dark theme's deep surfaces at 1.05:1 against each other — physically imperceptible.

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
| `--neutral-94` | `oklch(0.945 0.0059 280)` — the **source** | new work; anything that needs a full colour (`color-mix`, canvas backdrop) |
| `--neutral-94-hsl` | `233.2 14.8% 93.4%` — the **mirror** | the semantic layer |
| `--border` | `var(--neutral-85-hsl)` | every consumer's existing `hsl(var(--border))`, unchanged |

CSS cannot convert oklch into a bare channel triple, so the mirror is written out rather than derived.
`tests/theme/tokens-contract.test.ts` converts each oklch stop to HSL and fails if its mirror has moved, so the two forms cannot disagree without a red test.

**What this does NOT change:** any token name, the `hsl(var(--x))` consumption pattern, the `/50` opacity modifier, `--radius-md`'s value, or any exported symbol.
`AgentAppTheme` gained two optional fields.

**What DOES change visibly on upgrade** — the elevation revision, and it is the point of the change:

1. The dark theme's surface ladder is re-rung: the canvas drops to `#0c0c15`, the card lifts to `#1c1d27`, and the border to `#3d3e46`, with the chroma band (0.014–0.018 at hue 280) carrying a deliberate cool cast. The old deep surfaces measured 1.05:1 against each other — physically imperceptible — so cards did not read as containers. They do now.
2. The light theme inverts its elevation back the right way up: the canvas is tinted (`#e5e6eb`), the page sits above it (`#ececf1`), and the card is white paper on top. Previously the card sat *below* the page.
3. `border-border` paints the soft tier in both themes — 40% in light, and 60% in dark, where the lifted border leaves room to soften (the tiers used to collapse to full strength there). Opting out is one line, below.

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

**Two chroma bands, not zero and not wandering.**

Zero was an option and it is wrong for this fleet.
The dark surfaces — the largest painted areas in these products — are deliberately cool, matching `@tangle-network/brand` (Tangle Quiet), and chroma 0 would visibly warm all of them.
The defect to avoid was never that neutrals carry a tint; it is a tint that *wanders* (the pre-oklch ramp spread 11x across stops that all read as "the same 5–7% blue").
So the tint is banded and each band is checkable:

| band | stops | chroma | hue | job |
| --- | --- | --- | --- | --- |
| dark (L ≤ 0.4) | 16, 19, 22, 24, 28, 33, 36 | 0.014–0.018, falling as L rises | 280 | the dark theme's surface ladder |
| mid | 49, 70 | 0.004 | 286 | muted text, both themes |
| light (L ≥ 0.8) | 85, 92, 94, 96 | 0.0049–0.0079 | 280 | the light theme's tinted surfaces |
| terminal | 100 | 0 | — | white; sRGB admits no chroma at L 1 |

The mid stops keep the legacy hue 286 because moving them would repaint muted text for a 6° difference that is below what sRGB can show at C 0.004.

**Why the dark band's steps are small.** The first ladder ruled `L = 0.16 + 0.03n` — equal perceptual steps, checkable, and *wrong at the bottom of sRGB*: adjacent deep rungs measured 1.05:1 against each other, which is physically imperceptible, so the dark theme's card did not read as a container on its page.
The fix is not bigger ΔL steps — at these lightnesses sRGB simply has no contrast to spend.
The fix is that separation comes from the *whole stack*: a small fill step, a border tier that survives (below), and a shadow that lifts (section 5).
The chain the band ships (strengthened 2026-08 — the first revision's 1.05→1.16
canvas→card still read as border-only separation on real displays, so the fill
rungs moved up one lightness band while keeping the border tier and the
canvas/input relationship):

```
canvas #0c0c15 → background #12131c → input #181922 → card #22232c → secondary #2c2d36 → popover #31323c → border #3d3e46
          1.052         1.058            1.160          1.140             1.090            1.060   (adjacent contrast)

canvas → card 1.246     card → popover 1.240
```

Note the new rungs the old ladder had no room for: the canvas-backdrop sits *below* the background (they used to be the same colour), and the input is *recessed* — darker than the card it sits in, where the old input floated above it.

**The stop's name is its lightness**, L × 100 rounded to the nearest integer — `--neutral-94` is L 0.945.
The rule is enforced by the contract test on whatever stops are declared; only the rungs the system uses are declared.

Both themes read the same ladder and differ only in which rung each role picks — light from the top down, dark from the bottom up.
The dark scope never redefines the ramp, and a test fails if it starts to.

### Where every neutral landed

| mode | token | was (pre-revision) | ramp stop |
| --- | --- | --- | --- |
| light | `--card` / `--popover` | `--neutral-97` (L 0.97) | `--neutral-100` — white paper |
| light | `--background` | `--neutral-100` (white) | `--neutral-94` (`#ececf1`) |
| light | `--secondary` / `--muted` / `--accent` | `--neutral-94` | `--neutral-96` (`#f3f3f7`) |
| light | `--canvas-backdrop` | `--neutral-91` | `--neutral-92` (`#e5e6eb`) |
| light | `--border` / `--input` | `--neutral-91` | `--neutral-85` (`#cccdd3`) |
| light | `--muted-foreground` | `--neutral-49` | `--neutral-49` (unchanged) |
| light | `--foreground` and the other dark inks | `--neutral-16` | `--neutral-16`, retuned into the dark band (`#0c0c15`) |
| dark | `--canvas-backdrop` | `--neutral-16` | `--neutral-16` (`#0c0c15`) |
| dark | `--background` | `--neutral-16` | `--neutral-19` (`#12131c`) |
| dark | `--input` | `--neutral-22` | `--neutral-22` (`#181922`, recessed) |
| dark | `--card` | `--neutral-19` | `--neutral-26` (`#22232c`) |
| dark | `--secondary` / `--muted` / `--accent` | `--neutral-22` | `--neutral-30` (`#2c2d36`) |
| dark | `--popover` | `--neutral-25` | `--neutral-32` (`#31323c`) |
| dark | `--border` | `--neutral-25` | `--neutral-36` (`#3d3e46`) |
| dark | every `*-foreground` | `--neutral-94` | `--neutral-94`, retuned with the light background (`#ececf1`) |
| dark | `--muted-foreground` | `--neutral-70` | `--neutral-70` (unchanged) |
| dark | `--destructive-foreground` | `--neutral-25` | `--neutral-22` |

Stops 25, 91 and 97 are gone — every role they had picked a new rung.

`--primary`, `--destructive`, `--ring`, `--success` and `--warning` keep their measured HSL exactly.
Moving them would move agent-app off the brand palette and off status colours that were tuned to clear WCAG AA as *text* on tinted chips.

### Contrast, before and after

Every text pair that carries a WCAG obligation still clears AA.

| pair | before | after |
| --- | --- | --- |
| light `--foreground` on `--background` | 19.41 | 16.53 |
| light `--foreground` on `--card` | 17.77 | 19.46 |
| light `--muted-foreground` on `--background` | 6.26 | 5.31 |
| light `--muted-foreground` on `--card` | 5.73 | 6.26 |
| light `--muted-foreground` on `--muted` | 5.24 | 5.64 |
| light `--secondary-foreground` on `--secondary` | 14.52 | 15.77 |
| dark `--foreground` on `--background` | 16.26 | 15.70 |
| dark `--foreground` on `--card` | 15.49 | 14.22 |
| dark `--foreground` on `--popover` | 13.41 | 10.65 |
| dark `--muted-foreground` on `--background` | 7.26 | 6.92 |
| dark `--muted-foreground` on `--card` | 6.92 | 6.26 |
| dark `--muted-foreground` on `--muted` | 6.48 | 5.40 |
| dark `--muted-foreground` on `--popover` | 5.98 | 4.69 |

The tightest pair — muted text on the dark popover at 4.69 — still clears 4.5; the audit pre-verified these values before a line of CSS moved.

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

## 4. Border tiers

Three strengths of the same border colour, because a divider inside a panel and the edge of a card floated on the page are not the same line.
Shipping one strength for both is what makes a UI read boxy.

| tier | light | dark | for |
| --- | --- | --- | --- |
| `--border-soft` | 40% | 60% | dividers, de-emphasised edges — what `border-border` maps to |
| `--card-edge` | 60% | 80% | a container that must read as a container |
| `hsl(var(--border))` | 100% | 100% | form-field edges (`--input`), deliberate emphasis (`border-strong`) |

### The measurement

A 1px hairline, contrast of the composited line against the surface it sits on, rendered in Chromium and read back at 1:1 pixel scale by `playground/scripts/token-render.mjs`:

| alpha | light: background | light: card | light: muted | dark: background | dark: card | dark: muted |
| --- | --- | --- | --- | --- | --- | --- |
| 22% | 1.065 | 1.098 | 1.081 | 1.086 | 1.078 | 1.060 |
| 40% | 1.125 | 1.188 | 1.143 | 1.193 | 1.169 | 1.116 |
| 60% | 1.198 | 1.309 | 1.236 | 1.320 | 1.265 | 1.173 |
| 80% | 1.269 | 1.437 | 1.321 | 1.489 | 1.389 | 1.253 |
| 100% | 1.345 | 1.584 | 1.428 | 1.716 | 1.553 | 1.339 |

### Why light stayed 40 / 60

The light surfaces moved — the card is now white paper over a tinted page, so the fill step does the containing and the soft tier only has to *confirm* it.
40% keeps a divider quiet on `--background` (1.125), where most of this package's dividers actually sit, and the card edge at 60% (1.309 on the card) reads as a different decision, short of the 1.584 that reads as a box.

### Why dark softens now (it used to collapse)

The tiers previously collapsed to full strength in dark, and the collapse was correct *for that border*: the old dark `--border` (L 0.25) measured 1.158 on its card at 100% — already at the edge of visible — so a softened tier was not a quieter line, it was no line.

The ladder revision lifted the dark border to L 0.365, and the same measurement now leaves room everywhere: the soft tier at 60% clears the 1.07 hairline floor on background (1.320), card (1.265) and muted (1.173) — the surface where the old border at *full* strength managed only 1.085.
Same method, opposite conclusion, because the border colour itself moved.
So dark runs the same three tiers as light, one step stronger: 60 / 80 / 100.
The contract test pins both ends — "harmonising" dark down to 40/60 and collapsing it back to 100/100 both go red.

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

## 5. Elevation shadows

Two foreground-tinted lifts, so elevation is a token rather than an arbitrary value at each call site:

```css
--shadow-raised:  0 1px 2px hsl(var(--foreground) / 0.05), 0 12px 28px hsl(var(--foreground) / 0.07);
--shadow-overlay: 0 2px 6px hsl(var(--foreground) / 0.06), 0 16px 40px hsl(var(--foreground) / 0.1);
```

| token | for | provenance |
| --- | --- | --- |
| `shadow-raised` | the floating composer | the values `chat-composer.tsx` already shipped, promoted unchanged |
| `shadow-overlay` | popovers and dialogs | the higher lift of the pair |

Tinted with `--foreground` rather than black for the same reason the ramp carries chroma: a black shadow over a cool-dark surface reads muddy, a foreground-tinted one reads as depth.

**Dark doubles the alpha** (0.14/0.22 raised, 0.12/0.20 overlay).
The same shadow over a near-black surface reads at roughly half its light-theme strength, so the dark theme compensates at the token — not at every component, which is where it would be forgotten.
Both values read `var(--foreground)`, so the "every concrete :root token has a dark override" guard exempts them as derived; the dark alphas are the one thing the cascade cannot derive, and a dedicated test names both tokens in both scopes for exactly that reason.

The preset registers both as `shadow-raised` / `shadow-overlay`, names Tailwind does not already own.

---

## 6. Motion

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

## 7. Foreground pairings that a theme flip inverts

The tiers above stop an edge from disappearing.
This is the other direction: a foreground token that is right against one theme's fill and illegible against the other's.
Both cases below shipped, and neither is visible in the CSS — each reads as obviously-correct until the surface under it is rendered.

### `--warning-strong`

`--warning-foreground` is dark ink for a **solid** gold chip, and it is theme-invariant because a solid gold chip is.
The approval card is not that surface: it is `bg-warning/[0.06]`, a tint that tracks the page, so the same ink measured 13.51:1 in light and **1.24:1 in dark** — the eyebrow was there in one theme and gone in the other.

No single lightness fixes it, which is the whole reason a third token exists:

| ramp | light tint `rgb(233,230,227)` | dark tint `rgb(32,29,29)` |
| --- | --- | --- |
| `hsl(41 96% 27%)` | **4.69** | 2.88 |
| `hsl(41 96% 30%)` | 3.96 | 3.41 |
| `hsl(41 96% 34%)` | 3.20 | 4.21 |
| `hsl(41 96% 38%)` (`--warning`) | 2.62 | 5.15 |
| `hsl(40 94% 56%)` | 1.48 | **9.12** |

Light needs L ≤ 27%, dark needs L ≥ 36%, and the windows do not overlap.
So `--warning-strong` re-themes (27% / 56%) where `--warning` and `--warning-foreground` deliberately do not, and the preset exposes it as `text-warning-strong` **alongside** `warning.DEFAULT` and `warning.foreground` rather than displacing either.

### `--primary-foreground` inverts in dark

Dark `--primary` is `239 84% 74%` so that primary clears AA *as text* on a `primary/10` tint.
That same lightness makes the **solid** button a light fill, and the inherited white label measured **3.02:1** on it.
Dark now takes `--primary-foreground: var(--neutral-16-hsl)` — 6.27:1 on the same fill — while light keeps white on indigo at 6.01:1.
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
- every ramp stop is named its lightness (L × 100, rounded)
- chroma is banded (0.014–0.018 at hue 280 in the dark band, ≤ 0.008 in the light band, 0 only at L 1), and the dark band's chroma falls as L rises
- the dark ladder keeps its measured separation: no adjacent pair below 1.04:1, canvas→card above 1.14:1
- every oklch stop's HSL mirror still resolves to the same colour
- every neutral semantic token points at a ramp stop rather than a loose triple
- light/dark parity, and the dark block never restates a value verbatim or redefines the ramp
- the light tiers are ordered and still resolve as a 1px line; dark runs 60/80 and both tiers clear the hairline floor on every surface they divide
- both elevation shadows are defined in both themes, dark strengthens every layer, and the preset exposes `shadow-raised` / `shadow-overlay`
- the MD3 surface ladder maps monotonically (`high` → secondary, `highest` → popover)
- the radius steps all derive from one root, `--radius-md` is still `0.5rem`, and bare `--radius` is not defined
- every duration collapses under reduced motion, to a non-zero value; the floor reaches untokenised motion; `data-motion="essential"` is exempt
- the JS mirror in `theme.ts` matches tokens.css in both modes
- the preset maps `border-border` to the soft tier, every tier survives the `/50` modifier, and every token the preset names exists
- the approval eyebrow and the solid primary button both clear AA **in both themes**, and no single warning lightness could have served both — so deleting `--warning-strong` fails rather than silently regressing one theme
- no spinner is painted in the divider tier, and the colour they use instead clears 3:1 on both surfaces

Each of those was verified by breaking the thing it guards and watching it go red.
