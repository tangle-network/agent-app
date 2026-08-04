/**
 * The theme contract guard. Every CSS custom property a React surface consumes
 * via `var(--…)` MUST be defined in tokens.css — otherwise a consuming app that
 * loads `@tangle-network/agent-app/styles` still renders elements transparent
 * (the var resolves to nothing) with no error. This test fails loud the moment a
 * component references an undefined token or tokens.css drops a required one.
 *
 * It also pins the parts of the token system CSS itself cannot keep honest:
 * the neutral ramp's ladder rule, the oklch source against its HSL mirror, the
 * per-mode border-tier inversion, the radius ladder's one root, the
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
  const RAMP_BASE = 0.16
  const RAMP_STEP = 0.03
  const RAMP_CHROMA = 0.004
  const RAMP_HUE = 286

  it('every stop sits on the ladder L = 0.16 + 0.03n', () => {
    const offenders: string[] = []
    for (const [key, { oklch }] of rampStops()) {
      const [lightness] = parseOklch(oklch)
      const n = (lightness - RAMP_BASE) / RAMP_STEP
      if (Math.abs(n - Math.round(n)) > 1e-9) offenders.push(`--neutral-${key}: L ${lightness} is not a rung (n = ${n})`)
      // The stop's NAME is its lightness — that is what makes the ladder legible
      // at every call site instead of only in this file.
      if (Math.abs(lightness * 100 - key) > 1e-9) offenders.push(`--neutral-${key}: name disagrees with L ${lightness}`)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('chroma is one constant, not a wandering one', () => {
    const offenders: string[] = []
    for (const [key, { oklch }] of rampStops()) {
      const [lightness, chroma, hue] = parseOklch(oklch)
      // sRGB admits no chroma at L 1 — white is the only colour there.
      const expected = lightness >= 1 ? 0 : RAMP_CHROMA
      if (chroma !== expected) offenders.push(`--neutral-${key}: chroma ${chroma}, expected ${expected}`)
      if (chroma > 0 && hue !== RAMP_HUE) offenders.push(`--neutral-${key}: hue ${hue}, expected ${RAMP_HUE}`)
    }
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
  // 22% applied to our light card) the line is not there; at 1.073 (our 40%) it
  // is. Anything the system ships as a VISIBLE edge has to clear this.
  const HAIRLINE_FLOOR = 1.07
  const LIGHT_BORDER = 91
  const LIGHT_CARD = 97
  const DARK_BORDER = 25
  const DARK_CARD = 19

  const tiers = (defs: Map<string, string>) => ({
    soft: tierStrength(defs.get('--border-soft')!),
    cardEdge: tierStrength(defs.get('--card-edge')!),
  })

  it('light runs three distinct strengths, weakest first', () => {
    const { soft, cardEdge } = tiers(rootDefs())
    expect(soft).toBeLessThan(cardEdge)
    expect(cardEdge).toBeLessThan(1)
  })

  it('dark INVERTS: both tiers are full strength', () => {
    // The load-bearing assertion. "Harmonising" dark to soften like light is
    // the exact change that erases the border, and this is what stops it.
    const { soft, cardEdge } = tiers(darkDefs())
    expect(soft).toBe(1)
    expect(cardEdge).toBe(1)
  })

  it('the shipped light tiers still resolve as a 1px line on a card', () => {
    const { soft, cardEdge } = tiers(rootDefs())
    const card = stopRgb(LIGHT_CARD)
    const border = stopRgb(LIGHT_BORDER)
    expect(contrastRatio(compositeOver(border, soft, card), card)).toBeGreaterThanOrEqual(HAIRLINE_FLOOR)
    expect(contrastRatio(compositeOver(border, cardEdge, card), card)).toBeGreaterThanOrEqual(HAIRLINE_FLOOR)
  })

  it('the same softening buys less in dark, which is why dark does not soften', () => {
    const { soft } = tiers(rootDefs())
    const lightCard = stopRgb(LIGHT_CARD)
    const darkCard = stopRgb(DARK_CARD)
    const lightSoftened = contrastRatio(compositeOver(stopRgb(LIGHT_BORDER), soft, lightCard), lightCard)
    const darkSoftened = contrastRatio(compositeOver(stopRgb(DARK_BORDER), soft, darkCard), darkCard)
    expect(darkSoftened).toBeLessThan(lightSoftened)
    expect(darkSoftened).toBeLessThan(HAIRLINE_FLOOR)
    // …and dark starts with less headroom to give away in the first place.
    const darkFull = contrastRatio(stopRgb(DARK_BORDER), darkCard)
    const lightFull = contrastRatio(stopRgb(LIGHT_BORDER), lightCard)
    expect(darkFull).toBeLessThan(lightFull)
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
  const LIGHT_PAGE = 100
  const DARK_PAGE = 16

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

  it('carries the border tiers, and dark keeps them full strength', () => {
    expect(tierStrength(lightTheme.borderSoft!)).toBe(tierStrength(rootDefs().get('--border-soft')!))
    expect(tierStrength(lightTheme.cardEdge!)).toBe(tierStrength(rootDefs().get('--card-edge')!))
    expect(tierStrength(darkTheme.borderSoft!)).toBe(1)
    expect(tierStrength(darkTheme.cardEdge!)).toBe(1)
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
