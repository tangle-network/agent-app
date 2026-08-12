/**
 * The theme contract guard. Every CSS custom property a React surface consumes
 * via `var(--…)` MUST be defined in tokens.css — otherwise a consuming app that
 * loads `@tangle-network/agent-app/styles` still renders elements transparent
 * (the var resolves to nothing) with no error. This test fails loud the moment a
 * component references an undefined token or tokens.css drops a required one.
 *
 * It also pins the parts of the token system CSS itself cannot keep honest:
 * the neutral ramp's two-band rule, the oklch source against its HSL mirror,
 * the per-mode border-tier strengths, the radius ladder's one root, the
 * reduced-motion collapse, and the JS mirror in src/theme/theme.ts.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import agentAppPreset from '../../src/theme/tailwind-preset'
import { darkTheme, lightTheme, themeToCssVars, type AgentAppTheme } from '../../src/theme/theme'
import { checkThemeContract } from '../../src/theme-contract/index'
import { compositeOver, contrastRatio, hslTripleToOklch, oklchToRgb, type Rgb } from './oklch'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cssPath = join(repoRoot, 'src', 'theme', 'tokens.css')
const REACT_PKGS = ['design-canvas-react', 'sequences-react', 'studio-react', 'web-react']
const REQUIRED_ALIASES = [
  '--bg-input', '--text-primary', '--text-secondary', '--text-muted',
  '--text-danger', '--border-default', '--brand-primary',
]

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** Extract the body of the first brace-balanced block whose header matches `re`. */
function blockBody(css: string, re: RegExp): string {
  const start = css.search(re)
  if (start < 0) throw new Error(`no block matching ${re}`)
  const open = css.indexOf('{', start)
  let depth = 0
  let i = open
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) break
  }
  return css.slice(open + 1, i)
}

/** Map of `--name` → trimmed value for every declaration in a block body. */
function blockDefs(body: string): Map<string, string> {
  const defs = new Map<string, string>()
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) if (m[1] && m[2]) defs.set(m[1], m[2].trim())
  return defs
}

/**
 * A value that reads another token re-themes through the cascade — whether it
 * spells that as `hsl(var(--card))`, `calc(var(--radius-base) * 0.8)` or
 * `color-mix(…, var(--border) 40%, …)`. Only a value with no token reference at
 * all is a literal the dark scope has to restate.
 */
const derivesFromToken = (value: string) => /var\(\s*--/.test(value)

/**
 * tokens.css with its comments removed. The file documents its own decisions in
 * prose that quotes token names (`var(--name)`, `--radius-base: var(--radius)`),
 * and a declaration parser reading that prose both invents references that do
 * not exist and swallows the declaration after an unterminated one.
 */
const css = () => readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rootDefs = () => blockDefs(blockBody(css(), /:root\s*\{/))
const darkDefs = () => blockDefs(blockBody(css(), /\[data-theme=['"]dark['"]\]\s*,\s*\.dark\s*\{/))

describe('theme token contract', () => {
  it('every CSS var referenced by a React surface is defined in tokens.css', () => {
    // Consumes the exported checker (single source of truth) against agent-app's
    // OWN React surfaces — the same walk a consumer app runs on its own source.
    const { missing } = checkThemeContract({
      srcDirs: REACT_PKGS.map((p) => join(repoRoot, 'src', p)),
      tokensCss: cssPath,
    })
    const rendered = missing.map((m) => `${m.varName} (used in ${m.referencedIn})`)
    expect(rendered, `Undefined CSS vars referenced in components:\n${rendered.join('\n')}`).toEqual([])
  })

  it('every var() tokens.css references is defined by tokens.css', () => {
    // The semantic layer now reads the ramp (`--border: var(--neutral-91-hsl)`),
    // so the file has internal references of its own. A typo in one resolves to
    // nothing and paints the surface transparent with no error — the same
    // failure the check above catches for components, one layer earlier.
    const defined = new Set([...rootDefs().keys(), ...darkDefs().keys()])
    const referenced = [...css().matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]!)
    const dangling = [...new Set(referenced)].filter((name) => !defined.has(name))
    expect(dangling, `tokens.css references tokens it never defines:\n${dangling.join('\n')}`).toEqual([])
  })

  it('tokens.css defines every canonical alias the canvas/sequences packages consume', () => {
    const root = rootDefs()
    expect(REQUIRED_ALIASES.filter((v) => !root.has(v))).toEqual([])
  })

  // Every CONCRETE :root token (a literal value that reads no other token) must
  // have a dark override, or the dark theme silently inherits the light value.
  // Derived values re-theme automatically through the cascade, so they're exempt.
  // THEME_INVARIANT lists literals intentionally identical across themes.
  //
  // The focus ring's GEOMETRY is theme-invariant on purpose: a keyboard user
  // does not need a thicker ring in the dark, and duplicating `2px` into the
  // dark block would create a second place to change it. Only its COLOUR varies,
  // and that one is derived (`hsl(var(--ring))`), so it re-themes through the
  // cascade and is already exempt above.
  //
  // Radius and motion are geometry and timing, not colour: a surface does not
  // travel further, or land more softly, because the theme is dark.
  const THEME_INVARIANT = [
    '--radius-base',
    '--focus-ring-width', '--focus-ring-offset',
    // Dark text on a gold chip in both themes — the chip's fill is what moves.
    '--warning-foreground',
    '--duration-instant', '--duration-fast', '--duration-base', '--duration-slow',
    '--ease-standard', '--ease-entrance', '--ease-exit',
    // Entrance choreography is timing and distance for the same reason: text
    // does not resolve out of a deeper blur, and a row does not travel further,
    // because the theme is dark.
    '--duration-stream', '--duration-arrive', '--ease-expo',
    '--stagger-step', '--stagger-index', '--arrive-distance', '--stream-blur',
  ]
  // The ramp is mode-independent BY CONSTRUCTION — one ladder, and the two modes
  // differ only in which stop each role picks. Restating it in the dark scope
  // would be the bug, not the fix.
  const isRampStop = (name: string) => name.startsWith('--neutral-')

  it('every concrete :root token has a dark override (light/dark parity)', () => {
    const root = rootDefs()
    const dark = darkDefs()

    const concrete = [...root].filter(([, v]) => !derivesFromToken(v)).map(([k]) => k)
    const missing = concrete.filter(
      (k) => !dark.has(k) && !THEME_INVARIANT.includes(k) && !isRampStop(k),
    )
    expect(
      missing,
      `Concrete :root tokens lacking a [data-theme="dark"] override (dark inherits the light value):\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it('the dark block never restates a token verbatim', () => {
    // A dark declaration earns its place by saying something DIFFERENT. An
    // identical one is dead weight that will drift from the light value it was
    // copied from. (`--border-soft` is redefined in dark on purpose — with a
    // different formula, which is exactly the distinction this makes.)
    const root = rootDefs()
    const dark = darkDefs()
    const restated = [...dark].filter(([k, v]) => root.get(k) === v).map(([k]) => k)
    expect(
      restated,
      `Dark tokens byte-identical to their :root value (delete them; the cascade already carries them):\n${restated.join('\n')}`,
    ).toEqual([])
  })

  it('the ramp is never redefined in the dark scope', () => {
    const restated = [...darkDefs().keys()].filter(isRampStop)
    expect(
      restated,
      `The neutral ramp is one ladder shared by both modes; dark must pick stops, not redefine them:\n${restated.join('\n')}`,
    ).toEqual([])
  })
})

/** `--neutral-91` / `--neutral-91-hsl` → { 91: { oklch, triple } }. */
function rampStops(): Map<number, { oklch: string; triple?: string }> {
  const stops = new Map<number, { oklch: string; triple?: string }>()
  for (const [name, value] of rootDefs()) {
    const m = /^--neutral-(\d+)(-hsl)?$/.exec(name)
    if (!m) continue
    const key = Number(m[1])
    const entry = stops.get(key) ?? { oklch: '' }
    if (m[2]) entry.triple = value
    else entry.oklch = value
    stops.set(key, entry)
  }
  return stops
}

const parseOklch = (value: string): [number, number, number] => {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value)
  if (!m) throw new Error(`not a plain oklch() literal: ${value}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

describe('the neutral ramp', () => {
  const DARK_BAND_MAX_L = 0.4
  const DARK_BAND_HUE = 280
  const DARK_BAND_CHROMA: readonly [number, number] = [0.014, 0.018]
  const LIGHT_BAND_MAX_CHROMA = 0.008
  const LIGHT_BAND_HUES = [280, 286]

  it('every stop is named its lightness', () => {
    // The stop's name is its oklch lightness × 100, rounded to the nearest
    // integer — that is what keeps the ladder legible at every call site
    // instead of only in this file.
    const offenders: string[] = []
    for (const [key, { oklch }] of rampStops()) {
      const [lightness] = parseOklch(oklch)
      if (Math.abs(lightness * 100 - key) > 0.5) offenders.push(`--neutral-${key}: name disagrees with L ${lightness}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('chroma is banded, not wandering', () => {
    // The dark band (the dark theme's surface ladder) carries the deliberate
    // cool cast at hue 280; the light band stays near-neutral. The legacy mid
    // stops keep hue 286 — at C 0.004 the 6° is below what sRGB can show.
    const offenders: string[] = []
    for (const [key, { oklch }] of rampStops()) {
      const [lightness, chroma, hue] = parseOklch(oklch)
      // sRGB admits no chroma at L 1 — white is the only colour there.
      if (lightness >= 1) {
        if (chroma !== 0) offenders.push(`--neutral-${key}: chroma ${chroma} at L 1, expected 0`)
        continue
      }
      if (lightness <= DARK_BAND_MAX_L) {
        const [lo, hi] = DARK_BAND_CHROMA
        if (chroma < lo || chroma > hi) offenders.push(`--neutral-${key}: dark-band chroma ${chroma}, expected ${lo}–${hi}`)
        if (hue !== DARK_BAND_HUE) offenders.push(`--neutral-${key}: dark-band hue ${hue}, expected ${DARK_BAND_HUE}`)
      } else {
        if (chroma > LIGHT_BAND_MAX_CHROMA) offenders.push(`--neutral-${key}: light-band chroma ${chroma} > ${LIGHT_BAND_MAX_CHROMA}`)
        if (!LIGHT_BAND_HUES.includes(hue)) offenders.push(`--neutral-${key}: light-band hue ${hue}, expected one of ${LIGHT_BAND_HUES}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('the dark ladder keeps its measured separation', () => {
    // The audit that shaped this band measured the OLD deep surfaces at
    // 1.05:1 between adjacent rungs — physically imperceptible, so cards did
    // not read as containers. The chain floor keeps a future retune from
    // quietly re-flattening it, and the canvas→card span is the hierarchy the
    // fix exists for. Measured on the shipped stops: chain steps 1.052 /
    // 1.058 / 1.160 / 1.140 / 1.090 / 1.060, canvas→card 1.246.
    const CHAIN_FLOOR = 1.04
    const CANVAS_TO_CARD = 1.14
    const band = [...rampStops()]
      .map(([key, { oklch }]) => ({ key, rgb: oklchToRgb(parseOklch(oklch)), l: parseOklch(oklch)[0] }))
      .filter((s) => s.l <= DARK_BAND_MAX_L)
      .sort((a, b) => a.l - b.l)
    expect(band.length).toBeGreaterThanOrEqual(7)
    const offenders: string[] = []
    let prevChroma = Infinity
    for (let i = 0; i < band.length; i++) {
      const [, chroma] = parseOklch(rampStops().get(band[i]!.key)!.oklch)
      if (chroma > prevChroma) offenders.push(`--neutral-${band[i]!.key}: chroma rises as the band lifts`)
      prevChroma = chroma
      if (i > 0) {
        const step = contrastRatio(band[i - 1]!.rgb, band[i]!.rgb)
        if (step < CHAIN_FLOOR) offenders.push(`--neutral-${band[i - 1]!.key} → --neutral-${band[i]!.key}: ${step.toFixed(3)} < ${CHAIN_FLOOR}`)
      }
    }
    const canvasToCard = contrastRatio(stopRgb(16), stopRgb(26))
    if (canvasToCard < CANVAS_TO_CARD) offenders.push(`canvas→card ${canvasToCard.toFixed(3)} < ${CANVAS_TO_CARD}`)
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('every oklch stop has an HSL mirror that still resolves to the same colour', () => {
    // The mirror exists so a pinned consumer's `hsl(var(--border))` keeps
    // working. CSS cannot derive it, so this is the only thing between the two
    // forms and silent drift.
    const offenders: string[] = []
    for (const [key, { oklch, triple }] of rampStops()) {
      if (!triple) {
        offenders.push(`--neutral-${key}: no --neutral-${key}-hsl mirror`)
        continue
      }
      const [sourceL, sourceC] = parseOklch(oklch)
      const [mirrorL, mirrorC] = hslTripleToOklch(triple)
      // Tolerance covers the one decimal place the triple is written to, not drift:
      // the shipped mirrors land within 0.0006 L of their source.
      if (Math.abs(mirrorL - sourceL) > 0.002) {
        offenders.push(`--neutral-${key}-hsl: L ${mirrorL.toFixed(4)} vs source ${sourceL}`)
      }
      if (Math.abs(mirrorC - sourceC) > 0.001) {
        offenders.push(`--neutral-${key}-hsl: chroma ${mirrorC.toFixed(4)} vs source ${sourceC}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('every neutral semantic token points at a ramp stop instead of a loose literal', () => {
    // The point of a ramp is that nothing sits between its rungs. A hand-written
    // triple in the semantic layer is how the old ladder lost its spacing.
    const stops = new Set([...rampStops().keys()].map((k) => `--neutral-${k}-hsl`))
    const CHROMATIC = ['--primary', '--destructive', '--ring', '--success', '--warning', '--warning-foreground', '--warning-strong', '--success-foreground']
    const offenders: string[] = []
    for (const [scope, defs] of [['light', rootDefs()], ['dark', darkDefs()]] as const) {
      for (const [name, value] of defs) {
        if (name.startsWith('--neutral-') || CHROMATIC.includes(name)) continue
        if (!/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(value)) continue // not a bare channel triple
        offenders.push(`${scope} ${name}: literal triple "${value}" — use one of ${[...stops].join(' / ')}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

/** The full colour a ramp stop paints. */
function stopRgb(stop: number): Rgb {
  const entry = rampStops().get(stop)
  if (!entry) throw new Error(`no --neutral-${stop} in tokens.css`)
  return oklchToRgb(parseOklch(entry.oklch))
}

/** The mix fraction of `color-mix(in oklch, hsl(var(--border)) N%, transparent)`, or 1 for full strength. */
function tierStrength(value: string): number {
  if (/^hsl\(\s*var\(--border\)\s*\)$/.test(value)) return 1
  const m = /color-mix\(\s*in oklch\s*,\s*hsl\(var\(--border\)\)\s+([\d.]+)%\s*,\s*transparent\s*\)/.exec(value)
  if (!m) throw new Error(`not a --border tier expression: ${value}`)
  return Number(m[1]) / 100
}

describe('border tiers', () => {
  // Calibrated against the rendered 1px hairline: at 1.039 contrast (Cabinet's
  // 22% applied to our old light card) the line is not there; at 1.072 (our old
  // 40%) it is. Anything the system ships as a VISIBLE edge has to clear this.
  const HAIRLINE_FLOOR = 1.07
  const LIGHT_BORDER = 85
  const LIGHT_CARD = 100
  const DARK_BORDER = 36
  const DARK_CARD = 24

  const tiers = (defs: Map<string, string>) => ({
    soft: tierStrength(defs.get('--border-soft')!),
    cardEdge: tierStrength(defs.get('--card-edge')!),
  })

  it('light runs three distinct strengths, weakest first', () => {
    const { soft, cardEdge } = tiers(rootDefs())
    expect(soft).toBeLessThan(cardEdge)
    expect(cardEdge).toBeLessThan(1)
  })

  it('dark runs the same three tiers, one step stronger', () => {
    // The tiers USED to collapse to full strength in dark — the old border
    // (L 0.25) measured 1.158 on its card at 100%, so any softening erased the
    // line. The ladder revision lifted the border to L 0.365, which buys the
    // room to soften: 60% on the new card reads 1.292 in this test's composite
    // model (1.265 rendered). "Harmonising" dark back to light's 40/60 — or
    // collapsing it to 100/100 again — both fail here.
    const { soft, cardEdge } = tiers(darkDefs())
    expect(soft).toBe(0.6)
    expect(cardEdge).toBe(0.8)
  })

  it('the shipped light tiers still resolve as a 1px line on a card', () => {
    const { soft, cardEdge } = tiers(rootDefs())
    const card = stopRgb(LIGHT_CARD)
    const border = stopRgb(LIGHT_BORDER)
    expect(contrastRatio(compositeOver(border, soft, card), card)).toBeGreaterThanOrEqual(HAIRLINE_FLOOR)
    expect(contrastRatio(compositeOver(border, cardEdge, card), card)).toBeGreaterThanOrEqual(HAIRLINE_FLOOR)
  })

  it('the shipped dark tiers clear the hairline floor on every surface they divide', () => {
    // The premise that collapsed the old tiers is gone: in this test's
    // composite model, 60% reads above the floor on background /
    // card / muted / popover — all above the floor the old FULL-strength
    // border could not clear on muted (1.085).
    const { soft, cardEdge } = tiers(darkDefs())
    const border = stopRgb(DARK_BORDER)
    for (const surface of [19, 26, 30, 32].map(stopRgb)) {
      expect(contrastRatio(compositeOver(border, soft, surface), surface)).toBeGreaterThanOrEqual(HAIRLINE_FLOOR)
      expect(contrastRatio(compositeOver(border, cardEdge, surface), surface)).toBeGreaterThanOrEqual(HAIRLINE_FLOOR)
    }
  })
})

describe('elevation shadows', () => {
  /** The alpha of every layer in a `0 1px 2px hsl(var(--foreground) / 0.05), …` value. */
  const alphas = (value: string) => [...value.matchAll(/\/\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1]))

  it('both themes define both elevation tokens', () => {
    // Both values read var(--foreground), so the parity guard above exempts
    // them as "derived" — but the dark ALPHA is a deliberate doubling the
    // cascade cannot derive, so this guard names them directly.
    for (const name of ['--shadow-raised', '--shadow-overlay']) {
      expect(rootDefs().has(name), `${name} missing from :root`).toBe(true)
      expect(darkDefs().has(name), `${name} missing from the dark scope`).toBe(true)
    }
  })

  it('dark strengthens every layer against the near-black surfaces', () => {
    // The same shadow over a near-black surface reads at roughly half its
    // light-theme strength, so dark compensates at the token rather than at
    // every component.
    for (const name of ['--shadow-raised', '--shadow-overlay']) {
      const light = alphas(rootDefs().get(name)!)
      const dark = alphas(darkDefs().get(name)!)
      expect(dark.length, `${name} layer count`).toBe(light.length)
      expect(light.length, `${name} should be a two-layer ambient`).toBe(2)
      dark.forEach((a, i) => expect(a, `${name} layer ${i}: dark ${a} vs light ${light[i]}`).toBeGreaterThan(light[i]!))
    }
  })

  it('the preset exposes them as shadow-raised / shadow-overlay utilities', () => {
    const boxShadow = agentAppPreset.theme.extend.boxShadow
    expect(boxShadow.raised).toBe('var(--shadow-raised)')
    expect(boxShadow.overlay).toBe('var(--shadow-overlay)')
  })
})

/**
 * Text/fill pairings that a theme flip can silently invert.
 *
 * The border tiers above guard an edge from DISAPPEARING. This guards the other
 * direction: a foreground token that is correct against one theme's fill and
 * illegible against the other's. Both cases below shipped and were caught by
 * rendering the real approval card, not by reading the CSS — a token named
 * `--warning-foreground` reads as obviously-correct next to `--warning`, and a
 * theme-invariant `--primary-foreground` reads as obviously-correct until the
 * fill it sits on is re-themed lighter.
 *
 * Ratios are computed over the SAME surfaces the browser composited, so a
 * regression here is a regression a user would see:
 *   approval card = page + `bg-warning/[0.06]`
 *   solid button  = `bg-primary` at full strength
 */
describe('foreground pairings clear AA in BOTH themes', () => {
  const AA_SMALL = 4.5
  const TINT_ALPHA = 0.06
  const LIGHT_PAGE = 94
  const DARK_PAGE = 19

  const triple = (defs: Map<string, string>, name: string): Rgb => {
    const raw = defs.get(name)
    if (raw === undefined) throw new Error(`no ${name} in tokens.css`)
    const resolved = raw.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (whole, ref: string) => rootDefs().get(ref)?.trim() ?? whole)
    return oklchToRgb(hslTripleToOklch(resolved))
  }

  const scope = (mode: 'light' | 'dark') =>
    mode === 'light' ? rootDefs() : new Map([...rootDefs(), ...darkDefs()])

  for (const [mode, page] of [['light', LIGHT_PAGE], ['dark', DARK_PAGE]] as const) {
    const defs = () => scope(mode)

    it(`${mode}: the approval eyebrow is legible on the warning tint`, () => {
      const surface = compositeOver(triple(defs(), '--warning'), TINT_ALPHA, stopRgb(page))
      expect(contrastRatio(triple(defs(), '--warning-strong'), surface)).toBeGreaterThanOrEqual(AA_SMALL)
    })

    it(`${mode}: the solid primary button's label is legible on its own fill`, () => {
      const fill = triple(defs(), '--primary')
      expect(contrastRatio(triple(defs(), '--primary-foreground'), fill)).toBeGreaterThanOrEqual(AA_SMALL)
    })
  }

  it('no single warning lightness could have served both themes', () => {
    // Why `--warning-strong` re-themes while `--warning-foreground` does not.
    // Each theme's shipped value is measured against the OTHER theme's tint; if
    // either crossed, one token would do and this one should be deleted.
    const lightTint = compositeOver(triple(rootDefs(), '--warning'), TINT_ALPHA, stopRgb(LIGHT_PAGE))
    const darkTint = compositeOver(triple(scope('dark'), '--warning'), TINT_ALPHA, stopRgb(DARK_PAGE))
    const lightInk = triple(rootDefs(), '--warning-strong')
    const darkInk = triple(scope('dark'), '--warning-strong')
    expect(contrastRatio(lightInk, darkTint)).toBeLessThan(AA_SMALL)
    expect(contrastRatio(darkInk, lightTint)).toBeLessThan(AA_SMALL)
  })

  it('themeToCssVars falls back to the pairing the surface used before the token existed', () => {
    const bare: AgentAppTheme = { ...lightTheme, warningStrong: undefined }
    expect(themeToCssVars(bare)['--warning-strong']).toBe(lightTheme.warningForeground)
  })

  it('a busy spinner is never painted in a divider token', () => {
    // `border-border` resolves to the SOFT tier, which exists to be barely
    // visible. That is right for a rule between rows and wrong for the only
    // thing on screen saying a fetch is running — the async block's spinner
    // measured 1.10:1 light / 1.20:1 dark while it used that token. Scanned
    // rather than asserted on one file so the next spinner inherits the rule.
    const offenders = walk(join(repoRoot, 'src'))
      .filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, i) =>
            /animate-spin/.test(line) && /\bborder-border\b/.test(line)
              ? [`${file.slice(repoRoot.length + 1)}:${i + 1}`]
              : [],
          ),
      )
    expect(offenders, `Spinners painted in the divider tier:\n${offenders.join('\n')}`).toEqual([])
  })

  for (const [mode, surface] of [['light', LIGHT_PAGE], ['dark', DARK_PAGE]] as const) {
    it(`${mode}: the spinner's colour clears the 3:1 a meaningful graphic needs`, () => {
      expect(contrastRatio(triple(scope(mode), '--primary'), stopRgb(surface))).toBeGreaterThanOrEqual(3)
    })
  }

  it('the preset exposes the tier without displacing DEFAULT or foreground', () => {
    const warning = agentAppPreset.theme.extend.colors.warning
    expect(warning.DEFAULT).toBe('hsl(var(--warning))')
    expect(warning.foreground).toBe('hsl(var(--warning-foreground))')
    expect(warning.strong).toBe('hsl(var(--warning-strong))')
  })
})

describe('radius ladder', () => {
  it('every step derives from the one root', () => {
    const root = rootDefs()
    const steps = [...root].filter(([k]) => k.startsWith('--radius-') && k !== '--radius-base')
    expect(steps.length).toBeGreaterThan(0)
    const offenders = steps.filter(([, v]) => !/var\(\s*--radius-base\s*\)/.test(v)).map(([k]) => k)
    expect(offenders, `Radius steps not derived from --radius-base:\n${offenders.join('\n')}`).toEqual([])
  })

  it('--radius-md still resolves to the 0.5rem consumers already ship against', () => {
    // gtm-agent reads --radius-md for its composer send button and the bridged
    // sandbox-ui MD3 components read it too. Restructuring onto one root is only
    // non-breaking if this number does not move.
    const root = rootDefs()
    const base = Number(/^([\d.]+)rem$/.exec(root.get('--radius-base')!)![1])
    const m = /calc\(\s*var\(\s*--radius-base\s*\)\s*\*\s*([\d.]+)\s*\)/.exec(root.get('--radius-md')!)
    expect(m, `--radius-md is not "calc(var(--radius-base) * n)": ${root.get('--radius-md')}`).not.toBeNull()
    expect(base * Number(m![1])).toBeCloseTo(0.5, 10)
  })

  it('does not define bare --radius, which products already own', () => {
    // This file is linked UNLAYERED, so a `:root { --radius }` here beats the
    // `@layer base` definition tax-agent and legal-agent each ship — silently
    // reproportioning their whole chrome on upgrade.
    expect(rootDefs().has('--radius')).toBe(false)
  })
})

describe('motion', () => {
  const reducedBody = () => blockBody(css(), /@media\s*\(prefers-reduced-motion:\s*reduce\)/)

  it('every duration token collapses under prefers-reduced-motion', () => {
    const durations = [...rootDefs().keys()].filter((k) => k.startsWith('--duration-'))
    expect(durations.length).toBeGreaterThan(0)
    const reduced = blockDefs(blockBody(reducedBody(), /:root\s*\{/))
    const missing = durations.filter((k) => !reduced.has(k))
    expect(
      missing,
      `Durations that keep running when the user asked for reduced motion:\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it('the collapsed durations are non-zero so transitionend still fires', () => {
    // A 0s transition fires no transitionend, and any component awaiting one to
    // unmount or advance a state machine hangs forever.
    const reduced = blockDefs(blockBody(reducedBody(), /:root\s*\{/))
    for (const [name, value] of reduced) {
      if (!name.startsWith('--duration-')) continue
      expect(Number.parseFloat(value), `${name} collapsed to ${value}`).toBeGreaterThan(0)
    }
  })

  it('the floor reaches transitions that read no token, and exempts essential motion', () => {
    const body = reducedBody()
    expect(body).toMatch(/transition-duration:\s*1ms\s*!important/)
    expect(body).toMatch(/animation-duration:\s*1ms\s*!important/)
    expect(body).toContain("[data-motion='essential']")
  })

  it('the one endless essential animation answers reduced motion instead of running', () => {
    // `data-motion="essential"` exempts an element from the floor so a
    // meaning-carrying animation is not collapsed into a 1ms flash. It is not a
    // licence to sweep forever at a reader who asked for less motion, and the
    // waiting label is the only exempt animation with NO end condition, so it
    // owes its own answer: stop moving, and re-state what the movement said as a
    // static difference a settled label does not have.
    const shimmer = blockBody(reducedBody(), /\.agent-shimmer\s*\{/)
    expect(shimmer, 'the sweep must stop').toMatch(/animation:\s*none/)
    expect(shimmer, 'and the label must still read as in-flight').toMatch(/text-decoration:\s*underline/)
  })

  it('each composite pairs a duration token with an easing token', () => {
    const root = rootDefs()
    const composites = [...root].filter(([k]) => k.startsWith('--motion-'))
    expect(composites.length).toBeGreaterThan(0)
    for (const [name, value] of composites) {
      expect(value, `${name} should read a --duration-* token`).toMatch(/var\(\s*--duration-/)
      expect(value, `${name} should read an --ease-* token`).toMatch(/var\(\s*--ease-/)
    }
  })
})

describe('the JS mirror in src/theme/theme.ts', () => {
  // Konva paints to a bitmap and cannot resolve var(--…), so the canvas reads
  // its colours from these objects. If they drift from tokens.css the canvas
  // renders in a theme the rest of the app abandoned — and nothing errors.
  const CAMEL: Record<string, keyof AgentAppTheme> = {
    '--background': 'background', '--foreground': 'foreground',
    '--card': 'card', '--card-foreground': 'cardForeground',
    '--popover': 'popover', '--popover-foreground': 'popoverForeground',
    '--primary': 'primary', '--primary-foreground': 'primaryForeground',
    '--secondary': 'secondary', '--secondary-foreground': 'secondaryForeground',
    '--muted': 'muted', '--muted-foreground': 'mutedForeground',
    '--accent': 'accent', '--accent-foreground': 'accentForeground',
    '--destructive': 'destructive', '--destructive-foreground': 'destructiveForeground',
    '--border': 'border', '--input': 'input', '--ring': 'ring',
    '--success': 'success', '--success-foreground': 'successForeground',
    '--warning': 'warning', '--warning-foreground': 'warningForeground',
    '--warning-strong': 'warningStrong',
  }

  /** Substitute one level of `var(--neutral-NN-hsl)` back to the literal it names. */
  const resolve = (value: string) =>
    value.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (whole, name: string) => rootDefs().get(name)?.trim() ?? whole)

  /** The tokens a mode actually resolves: its own declarations over the :root ones. */
  const scopeDefs = (mode: 'light' | 'dark') =>
    mode === 'light' ? rootDefs() : new Map([...rootDefs(), ...darkDefs()])

  for (const [mode, theme] of [['light', lightTheme], ['dark', darkTheme]] as const) {
    it(`${mode} triples match tokens.css`, () => {
      const defs = scopeDefs(mode)
      const offenders: string[] = []
      for (const [cssName, key] of Object.entries(CAMEL)) {
        const cssValue = resolve(defs.get(cssName)!)
        if (cssValue !== theme[key]) offenders.push(`${cssName}: css "${cssValue}" vs theme.ts "${String(theme[key])}"`)
      }
      expect(offenders, offenders.join('\n')).toEqual([])
    })

    it(`${mode} canvas backdrop matches tokens.css`, () => {
      expect(resolve(scopeDefs(mode).get('--canvas-backdrop')!)).toBe(theme.canvasBackdrop)
    })
  }

  it('carries the same border tiers as tokens.css, in both modes', () => {
    expect(tierStrength(lightTheme.borderSoft!)).toBe(tierStrength(rootDefs().get('--border-soft')!))
    expect(tierStrength(lightTheme.cardEdge!)).toBe(tierStrength(rootDefs().get('--card-edge')!))
    expect(tierStrength(darkTheme.borderSoft!)).toBe(tierStrength(darkDefs().get('--border-soft')!))
    expect(tierStrength(darkTheme.cardEdge!)).toBe(tierStrength(darkDefs().get('--card-edge')!))
  })

  it('themeToCssVars never emits a softer edge than the theme asked for', () => {
    // The tiers are optional on AgentAppTheme so an existing consumer literal
    // still type-checks. The fallback has to be the SAFE direction: an unset
    // tier under-draws an edge, it never erases one.
    const bare: AgentAppTheme = { ...lightTheme, borderSoft: undefined, cardEdge: undefined }
    const vars = themeToCssVars(bare)
    expect(vars['--border-soft']).toBe(`hsl(${lightTheme.border})`)
    expect(vars['--card-edge']).toBe(`hsl(${lightTheme.border})`)
  })
})

describe('the Tailwind preset', () => {
  const borderColor = agentAppPreset.theme.extend.borderColor
  const colors = agentAppPreset.theme.extend.colors

  it('maps border-border onto the soft tier — the one edit that reaches every call site', () => {
    expect(borderColor.border).toContain('var(--border-soft)')
    expect(borderColor['card-edge']).toContain('var(--card-edge)')
    expect(borderColor.strong).toBe('hsl(var(--border))')
  })

  it('keeps the opacity modifier compiling on every tier', () => {
    // Pointing a utility straight at `var(--border-soft)` makes Tailwind DROP
    // `border-border/50` rather than emit it un-modified — verified against
    // Tailwind 3.4.19: the class simply does not appear in the output, the
    // element falls back to currentColor, and nothing errors. This package has
    // 18 such usages. `<alpha-value>` is what keeps them generating.
    // `hsl(var(--x))` needs no placeholder — Tailwind parses it and injects the
    // alpha itself. A value it CANNOT parse must carry `<alpha-value>` or the
    // modified class is dropped.
    for (const [name, value] of Object.entries(borderColor)) {
      const survives = value.includes('<alpha-value>') || /^hsl\(var\(--[a-z0-9-]+\)\)$/.test(value)
      expect(survives, `borderColor.${name} = "${value}" drops its /50 modifier`).toBe(true)
    }
  })

  it('leaves the form-field edge and the raw colour scale at full strength', () => {
    // A form field's edge is a control affordance, not a divider; and
    // `bg-border` paints a rule whose whole job is to be seen.
    expect(borderColor).not.toHaveProperty('input')
    expect(colors.border).toBe('hsl(var(--border))')
    expect(colors.input).toBe('hsl(var(--input))')
  })

  it('climbs the MD3 surface ladder monotonically', () => {
    // card < secondary < popover on the dark ladder (L 0.26 / 0.30 / 0.32).
    // Mapping high→popover / highest→secondary INVERTED the top two rungs —
    // the picker floating above the composer painted DARKER than it.
    expect(colors['surface-container']).toBe('hsl(var(--card))')
    expect(colors['surface-container-high']).toBe('hsl(var(--secondary))')
    expect(colors['surface-container-highest']).toBe('hsl(var(--popover))')
  })

  it('adds radius and motion under names Tailwind does not already own', () => {
    // Reusing `md`/`lg` would silently resize 302 existing `rounded-*` usages,
    // because the token ladder and Tailwind's utility ladder share names at
    // different values (`--radius-md` is 8px, `rounded-md` is 6px).
    const TAILWIND_RADIUS = ['none', 'sm', 'DEFAULT', 'md', 'lg', 'xl', '2xl', '3xl', 'full']
    expect(Object.keys(agentAppPreset.theme.extend.borderRadius).filter((k) => TAILWIND_RADIUS.includes(k))).toEqual([])
    const TAILWIND_EASE = ['linear', 'in', 'out', 'in-out', 'DEFAULT']
    expect(
      Object.keys(agentAppPreset.theme.extend.transitionTimingFunction).filter((k) => TAILWIND_EASE.includes(k)),
    ).toEqual([])
    // Tailwind's own duration scale is numeric keys plus DEFAULT.
    expect(
      Object.keys(agentAppPreset.theme.extend.transitionDuration).filter((k) => /^\d+$/.test(k) || k === 'DEFAULT'),
    ).toEqual([])
  })

  it('every token the preset names is defined in tokens.css', () => {
    const defined = new Set(rootDefs().keys())
    const referenced = [...JSON.stringify(agentAppPreset).matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]!)
    const dangling = [...new Set(referenced)].filter((name) => !defined.has(name))
    expect(dangling, `The preset maps utilities onto tokens tokens.css never defines:\n${dangling.join('\n')}`).toEqual([])
  })
})

describe('no status-palette literals outside the allowlist', () => {
  // Tailwind palette literals (bg-green-500, text-rose-300, …) bypass the token
  // system and won't re-theme. The var()-completeness guard above can't see them.
  // This enforces ADOPTION: status colors must use the semantic tokens
  // (success/warning/destructive, or the --text-danger/--text-warning aliases).
  // Allowlist = deliberate NON-status palettes (clip kind-coding, print bleed).
  const ALLOW = [
    'sequences-react/components/TimelineClipChip.tsx', // video/audio/agent kind-coding
    'design-canvas-react/components/BleedTrimOverlay.tsx', // print bleed (red convention)
    'studio-react/type-config.ts', // media-type kind-coding (image/video/avatar/speech/transcription)
  ]
  const PALETTE = /(text|bg|border|ring|fill|stroke)-(rose|amber|emerald|green|red|yellow|lime|orange)-[0-9]/

  it('every status color uses a semantic token, not a raw palette literal', () => {
    const offenders: string[] = []
    for (const pkg of REACT_PKGS) {
      for (const file of walk(join(repoRoot, 'src', pkg))) {
        const rel = file.replace(repoRoot + '/src/', '')
        if (ALLOW.some((a) => rel.endsWith(a))) continue
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (PALETTE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`)
        })
      }
    }
    expect(
      offenders,
      `Status colors must use tokens (success/warning/destructive). Offenders:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
