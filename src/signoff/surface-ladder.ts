/**
 * Surface ladder: every card and field must step off the surface it sits on,
 * every field border must be visible against that surface, and a card's body
 * copy must stay one short line.
 *
 * Hospitality shipped cards painted the color of their parent, a search field
 * the color of the page, and cards carrying 20–40 words of body copy. Drew
 * rated it 0/10 for exactly that. This check measures the rendered page, so it
 * catches the flat step whatever token, class or override produced it.
 *
 * Rules (OKLCH lightness ×100, the same unit the brand ladder is specified in):
 * - card: a painted box with a radius of at least 6px, taller than 80px. Fails
 *   when |ΔL| against its nearest painted ancestor is under 3.
 * - field: input, textarea, [role=combobox], [role=searchbox] and
 *   .focus-field-within. Fails when |ΔL| is under 3. A transparent field inside
 *   a .focus-field-within wrapper is skipped: the wrapper is the field.
 * - field border: fails when its contrast against the field's parent is under 3:1.
 * - card copy: each body-copy element inside a card (CardDescription, a header
 *   or section paragraph: any <p>, since CardDescription carries no data-slot)
 *   fails over 12 words. The element's own text is counted, not the card's
 *   innerText, and clamped text counts in full. Chat transcript text is exempt.
 *
 * The browser half (`collectSurfaceLadder`) only reads computed colors and text;
 * the decision (`judgeSurfaceLadder`) and the color math are pure functions, so
 * they are unit-tested without a browser.
 */

import { createRequestMeter, createMeteredBrowserPage, QUIET_CHROMIUM_ARGS, type NetworkCount } from './browser-budget'

/** sRGB channels 0–255. */
export type Rgb = readonly [number, number, number]
/** sRGB channels 0–255 plus alpha 0–1. */
export type Rgba = readonly [number, number, number, number]

export interface SurfaceBox {
  readonly kind: 'card' | 'field'
  readonly label: string
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
  /** The box's own computed background (alpha may be below 1). */
  readonly fill: Rgba
  /** The nearest painted ancestor's effective (composited, opaque) color. */
  readonly parent: Rgb
  readonly parentLabel: string
  /** The field's visible border color, or null when it draws none. Cards leave it null. */
  readonly border: Rgba | null
  /** Words in the card's whole innerText, for reporting only. */
  readonly words?: number
}

export interface CopyBlock {
  readonly label: string
  /** The card the copy sits in. */
  readonly card: string
  readonly words: number
  readonly text: string
}

export interface SurfaceSample {
  readonly route: string
  readonly width: number
  readonly theme: string
  readonly boxes: readonly SurfaceBox[]
  readonly copy: readonly CopyBlock[]
}

export type SurfaceRule = 'card-step' | 'field-step' | 'field-border' | 'card-copy'

export interface SurfaceFinding {
  readonly route: string
  readonly width: number
  readonly theme: string
  readonly rule: SurfaceRule
  readonly target: string
  /** |ΔL|, contrast ratio, or word count, depending on the rule. */
  readonly value: number
  readonly limit: number
  readonly reason: string
}

export interface SurfaceLadderLimits {
  /** Minimum |ΔL| (OKLCH L ×100) for a card or field against its parent. */
  readonly minDeltaL?: number
  /** Minimum contrast ratio of a field border against the field's parent. */
  readonly minBorderContrast?: number
  /** Maximum words in one body-copy element of a card. */
  readonly maxWords?: number
}

export const SURFACE_LADDER_MIN_DELTA_L = 3
export const SURFACE_LADDER_MIN_BORDER_CONTRAST = 3
export const SURFACE_LADDER_MAX_WORDS = 12

/** Alpha-composite `top` over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, top[3]))
  return [0, 1, 2].map((i) => (top[i] as number) * a + (bottom[i] as number) * (1 - a)) as unknown as Rgb
}

function linear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** OKLab lightness of an sRGB color, ×100 (0 black … 100 white). */
export function oklchL(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linear) as [number, number, number]
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  return 100 * (0.2104542553 * Math.cbrt(l) + 0.793617785 * Math.cbrt(m) - 0.0040720468 * Math.cbrt(s))
}

/** WCAG 2 contrast ratio between two opaque sRGB colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const luminance = (c: Rgb) => {
    const [r, g, bl] = c.map(linear) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Signed ΔL of a box against its parent: positive when the box is lighter. */
export function surfaceDeltaL(box: Pick<SurfaceBox, 'fill' | 'parent'>): number {
  return oklchL(composite(box.fill, box.parent)) - oklchL(box.parent)
}

export function judgeSurfaceLadder(sample: SurfaceSample, limits: SurfaceLadderLimits = {}): SurfaceFinding[] {
  const minDeltaL = limits.minDeltaL ?? SURFACE_LADDER_MIN_DELTA_L
  const minBorder = limits.minBorderContrast ?? SURFACE_LADDER_MIN_BORDER_CONTRAST
  const maxWords = limits.maxWords ?? SURFACE_LADDER_MAX_WORDS
  const where = { route: sample.route, width: sample.width, theme: sample.theme }
  const findings: SurfaceFinding[] = []
  for (const box of sample.boxes) {
    const delta = surfaceDeltaL(box)
    if (Math.abs(delta) < minDeltaL) {
      findings.push({ ...where, rule: box.kind === 'card' ? 'card-step' : 'field-step', target: box.label, value: round1(Math.abs(delta)), limit: minDeltaL,
        reason: `${box.kind} is ΔL ${signed(delta)} against ${box.parentLabel} (needs |ΔL| ≥ ${minDeltaL})` })
    }
    if (box.kind === 'field' && box.border) {
      const ratio = contrastRatio(composite(box.border, box.parent), box.parent)
      if (ratio < minBorder) {
        findings.push({ ...where, rule: 'field-border', target: box.label, value: round2(ratio), limit: minBorder,
          reason: `field border is ${round2(ratio)}:1 against ${box.parentLabel} (needs ${minBorder}:1)` })
      }
    }
  }
  for (const block of sample.copy) {
    if (block.words > maxWords) {
      findings.push({ ...where, rule: 'card-copy', target: `${block.card} › ${block.label}`, value: block.words, limit: maxWords,
        reason: `card body copy is ${block.words} words (max ${maxWords}): "${block.text}"` })
    }
  }
  return findings
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
function round2(value: number): number {
  return Math.round(value * 100) / 100
}
function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${round1(value)}`
}

/**
 * Runs in the page (Playwright serializes it, so every helper lives inside).
 * Returns raw colors and text for the boxes the rules cover; `judgeSurfaceLadder` decides.
 */
export function collectSurfaceLadder(): Pick<SurfaceSample, 'boxes' | 'copy'> {
  type C4 = [number, number, number, number]
  type C3 = [number, number, number]
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const parseCache = new Map<string, C4 | null>()
  // Chromium serializes most colors as rgb()/rgba(); oklch(), lab() and color()
  // go through a canvas, which converts any CSS color to sRGB bytes.
  const parse = (css: string): C4 | null => {
    const hit = parseCache.get(css)
    if (hit !== undefined) return hit
    let out: C4 | null = null
    const m = css.match(/^rgba?\(([^)]+)\)$/)
    if (m) {
      const parts = (m[1] as string).split(/[\s,/]+/).filter(Boolean).map((p) => (p.endsWith('%') ? Number.parseFloat(p) / 100 : Number(p)))
      out = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
    } else if (ctx && css && css !== 'none') {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      out = [d[0] as number, d[1] as number, d[2] as number, (d[3] as number) / 255]
    }
    parseCache.set(css, out)
    return out
  }
  const PAINT_ALPHA = 0.1
  const blend = (top: C4, bottom: C3): C3 => [0, 1, 2].map((i) => (top[i] as number) * top[3] + (bottom[i] as number) * (1 - top[3])) as C3
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : ''
    const slot = el.getAttribute('data-slot') ? `[data-slot=${el.getAttribute('data-slot')}]` : ''
    const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''
    const classes = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter((c) => c && !c.includes(':') && !c.includes('[') && !c.includes('/')).slice(0, 3).map((c) => `.${c}`).join('')
      : ''
    return `${el.tagName.toLowerCase()}${id}${slot}${role}${classes}`
  }
  const visible = (el: Element, style: CSSStyleDeclaration, rect: DOMRect) =>
    rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0

  // Effective opaque color behind each element: its own fill composited over its parent's.
  const effective = new Map<Element, { color: C3; painter: Element | null }>()
  const canvasColor = (): C3 => {
    for (const el of [document.body, document.documentElement]) {
      const fill = parse(getComputedStyle(el).backgroundColor)
      if (fill && fill[3] >= PAINT_ALPHA) return [fill[0], fill[1], fill[2]]
    }
    return matchMedia('(prefers-color-scheme: dark)').matches ? [18, 18, 18] : [255, 255, 255]
  }
  const root = canvasColor()
  const effectiveOf = (el: Element | null): { color: C3; painter: Element | null } => {
    if (!el) return { color: root, painter: null }
    const known = effective.get(el)
    if (known) return known
    const below = effectiveOf(el.parentElement)
    const fill = parse(getComputedStyle(el).backgroundColor)
    const result = fill && fill[3] >= PAINT_ALPHA ? { color: blend(fill, below.color), painter: el } : below
    effective.set(el, result)
    return result
  }

  const fieldSelector = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), textarea, [role="combobox"], [role="searchbox"], .focus-field-within'
  const overlay = '[role="dialog"],[role="menu"],[role="listbox"],[role="tooltip"],[data-radix-popper-content-wrapper]'
  const media = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'svg', 'IFRAME', 'PICTURE'])
  const scope = Array.from(document.querySelectorAll('main, [role="main"]'))
  const roots = scope.length ? scope.filter((el) => !scope.some((o) => o !== el && o.contains(el))) : [document.body]

  const boxes: SurfaceBox[] = []
  const cards: { el: Element; label: string }[] = []
  for (const el of roots.flatMap((r) => Array.from(r.querySelectorAll('*')))) {
    if (media.has(el.tagName) || el.closest(overlay)) continue
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    if (!visible(el, style, rect)) continue
    const isField = el.matches(fieldSelector)
    const fill = parse(style.backgroundColor) ?? [0, 0, 0, 0]
    const painted = fill[3] >= PAINT_ALPHA
    const base = { label: describe(el), top: rect.top + window.scrollY, left: rect.left, width: rect.width, height: rect.height, fill: fill as Rgba }
    if (isField) {
      if (rect.width < 40 || rect.height < 20) continue
      if (!painted && el.parentElement?.closest('.focus-field-within')) continue
      const parent = effectiveOf(el.parentElement)
      const sides = ['Top', 'Bottom', 'Left', 'Right'] as const
      const side = sides.find((s) => Number.parseFloat(style.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0
        && style.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none')
      const borderFill = side ? parse(style.getPropertyValue(`border-${side.toLowerCase()}-color`)) : null
      const border = borderFill && borderFill[3] > 0 ? (borderFill as Rgba) : null
      boxes.push({ kind: 'field', ...base, parent: parent.color, parentLabel: parent.painter ? describe(parent.painter) : '(canvas)', border })
      continue
    }
    if (!painted || rect.height <= 80 || rect.width < 120) continue
    const radius = Math.max(...['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius']
      .map((p) => Number.parseFloat(style.getPropertyValue(p)) || 0))
    if (radius < 6) continue
    const parent = effectiveOf(el.parentElement)
    const words = ((el as HTMLElement).innerText || '').split(/\s+/).filter(Boolean).length
    boxes.push({ kind: 'card', ...base, parent: parent.color, parentLabel: parent.painter ? describe(parent.painter) : '(canvas)', border: null, words })
    cards.push({ el, label: base.label })
  }

  // Body copy: CardDescription, card header paragraphs and section paragraphs,
  // attributed to the innermost card that holds them. CardDescription renders a
  // bare <p> with no data-slot, so every paragraph inside a card counts; chat
  // transcript content is message text, not card copy.
  const copySelector = '[data-slot="card-description"], p'
  const transcript = '[data-timeline-step], .prose, [role="log"], pre, code'
  const copy: CopyBlock[] = []
  const seen = new Set<Element>()
  for (const el of roots.flatMap((r) => Array.from(r.querySelectorAll(copySelector)))) {
    if (seen.has(el) || el.closest(overlay) || el.closest(transcript) || el.closest(fieldSelector) || el.parentElement?.closest('[data-slot="card-description"]')) continue
    seen.add(el)
    const style = getComputedStyle(el)
    if (!visible(el, style, el.getBoundingClientRect())) continue
    let card: { el: Element; label: string } | undefined
    for (let p = el.parentElement; p && !card; p = p.parentElement) card = cards.find((c) => c.el === p)
    if (!card) continue
    // textContent, not innerText: a line clamp hides words without removing them.
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    const words = text ? text.split(' ').length : 0
    copy.push({ label: describe(el), card: card.label, words, text: text.length > 90 ? `${text.slice(0, 87)}…` : text })
  }
  return { boxes, copy }
}

export interface SurfaceLadderOptions extends SurfaceLadderLimits {
  readonly baseUrl: string
  readonly routes: readonly string[]
  readonly widths?: readonly number[]
  readonly themes?: readonly ('light' | 'dark')[]
  /** Playwright storage state (cookies, localStorage) for an authenticated app. */
  readonly storageState?: string
  /** Run in each page before the app loads, with `theme` in scope, to apply the app's own theme switch. */
  readonly themeScript?: string
  /** Write a screenshot per failing route, width and theme here. */
  readonly screenshotDir?: string
  /** Wait for this selector after navigation (default `[data-shell-header]`). */
  readonly readySelector?: string
  /** Calibration only: CSS file contents added to each page before measuring, to test a proposed override. */
  readonly injectCss?: string
}

export interface SurfacePageSummary {
  readonly route: string
  readonly width: number
  readonly theme: string
  readonly cards: number
  readonly flatCards: number
  readonly minCardDeltaL: number | null
  readonly fields: number
  readonly flatFields: number
  readonly minFieldDeltaL: number | null
  readonly weakBorders: number
  readonly copyBlocks: number
  readonly longCopy: number
  readonly maxCopyWords: number | null
  /** Median of each card's whole innerText word count (context, not a rule). */
  readonly medianCardWords: number | null
}

export interface SurfaceLadderReport {
  /** Requests the run sent and its busiest 10 s (see browser-budget.ts). */
  readonly network?: NetworkCount
  readonly samples: readonly SurfaceSample[]
  readonly pages: readonly SurfacePageSummary[]
  readonly findings: readonly SurfaceFinding[]
  readonly countsByRule: Readonly<Record<SurfaceRule, number>>
}

export function summarizeSurfacePage(sample: SurfaceSample, findings: readonly SurfaceFinding[]): SurfacePageSummary {
  const mine = findings.filter((f) => f.route === sample.route && f.width === sample.width && f.theme === sample.theme)
  const count = (rule: SurfaceRule) => mine.filter((f) => f.rule === rule).length
  const deltas = (kind: SurfaceBox['kind']) => sample.boxes.filter((b) => b.kind === kind).map((b) => Math.abs(surfaceDeltaL(b)))
  const min = (values: number[]) => (values.length ? round1(Math.min(...values)) : null)
  const cardWords = sample.boxes.filter((b) => b.kind === 'card').map((b) => b.words ?? 0).sort((a, b) => a - b)
  return {
    route: sample.route, width: sample.width, theme: sample.theme,
    cards: deltas('card').length, flatCards: count('card-step'), minCardDeltaL: min(deltas('card')),
    fields: deltas('field').length, flatFields: count('field-step'), minFieldDeltaL: min(deltas('field')),
    weakBorders: count('field-border'),
    copyBlocks: sample.copy.length, longCopy: count('card-copy'),
    maxCopyWords: sample.copy.length ? Math.max(...sample.copy.map((c) => c.words)) : null,
    medianCardWords: cardWords.length ? (cardWords[Math.floor(cardWords.length / 2)] as number) : null,
  }
}

const PHONE_HEIGHT = 844
const DESKTOP_HEIGHT = 900

/** Drive Chromium over every route × width × theme and judge each page. Needs the optional `playwright` peer. */
export async function checkSurfaceLadder(options: SurfaceLadderOptions): Promise<SurfaceLadderReport> {
  const { chromium } = await import('playwright')
  const widths = options.widths ?? [1440, 390]
  const themes = options.themes ?? ['light', 'dark']
  const browser = await chromium.launch({ args: [...QUIET_CHROMIUM_ARGS] })
  const meter = createRequestMeter()
  const samples: SurfaceSample[] = []
  const findings: SurfaceFinding[] = []
  try {
    for (const width of widths) {
      for (const theme of themes) {
        const { context, page } = await createMeteredBrowserPage(browser, {
          viewport: { width, height: width < 768 ? PHONE_HEIGHT : DESKTOP_HEIGHT },
          colorScheme: theme,
          reducedMotion: 'reduce',
          ...(options.storageState ? { storageState: options.storageState } : {}),
        }, meter, options.themeScript)
        for (const route of options.routes) {
          await meter.pace()
          await page.goto(new URL(route, options.baseUrl).toString(), { waitUntil: 'domcontentloaded' })
          await page.waitForSelector(options.readySelector ?? '[data-shell-header]', { state: 'visible', timeout: 15_000 }).catch(() => undefined)
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
          if (options.injectCss) await page.addStyleTag({ content: options.injectCss })
          await page.evaluate(() => document.fonts?.ready)
          // Let color transitions finish (reduced motion does not stop every one).
          await page.waitForTimeout(600)
          const collected = await page.evaluate(collectSurfaceLadder)
          const sample: SurfaceSample = { route, width, theme, ...collected }
          samples.push(sample)
          const found = judgeSurfaceLadder(sample, options)
          findings.push(...found)
          if (found.length && options.screenshotDir) {
            const name = `${route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'}-${width}-${theme}.png`
            // Evidence only: a screenshot that stalls must not lose the measurement.
            await page.screenshot({ path: `${options.screenshotDir}/${name}`, timeout: 10_000, animations: 'disabled' }).catch(() => undefined)
          }
        }
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
  const countsByRule: Record<SurfaceRule, number> = { 'card-step': 0, 'field-step': 0, 'field-border': 0, 'card-copy': 0 }
  for (const f of findings) countsByRule[f.rule] += 1
  return { samples, pages: samples.map((s) => summarizeSurfacePage(s, findings)), findings, countsByRule, network: meter.count() }
}

export function formatSurfaceLadderReport(report: SurfaceLadderReport): string {
  const c = report.countsByRule
  const lines = [
    `surface ladder: ${report.pages.length} pages, ${report.findings.length} failures (card-step ${c['card-step']}, field-step ${c['field-step']}, field-border ${c['field-border']}, card-copy ${c['card-copy']})`,
    '  route | width | theme | cards flat/total (min |ΔL|) | fields flat/total (min |ΔL|) | weak borders | long copy/blocks (max words) | median card words',
  ]
  for (const p of report.pages) {
    lines.push(`  ${p.route} | ${p.width} | ${p.theme} | ${p.flatCards}/${p.cards} (${p.minCardDeltaL ?? '–'}) | ${p.flatFields}/${p.fields} (${p.minFieldDeltaL ?? '–'}) | ${p.weakBorders} | ${p.longCopy}/${p.copyBlocks} (${p.maxCopyWords ?? '–'}) | ${p.medianCardWords ?? '–'}`)
  }
  for (const f of report.findings) lines.push(`  FAIL ${f.rule} ${f.route} @${f.width} ${f.theme}: ${f.target} ${f.reason}`)
  if (!report.findings.length) lines.push('  ok: every card and field steps off its parent, field borders read, and card copy is one short line')
  return lines.join('\n')
}
