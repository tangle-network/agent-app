/**
 * Ground truth for the token decisions a static file cannot settle.
 *
 * Three questions the CSS itself cannot answer, and one browser can:
 *
 *  1. At what alpha does a 1px hairline still RESOLVE on each surface? The
 *     border tiers in tokens.css are 40% / 60% in light and full strength in
 *     dark, and those numbers came from looking at this sweep at 1:1 pixel
 *     scale — not from copying a reference implementation whose card had no
 *     fill contrast of its own. A contrast ratio narrows the candidates; only
 *     the render decides between 35% and 45%.
 *  2. Does the whole substitution chain resolve? `--border` names a ramp stop
 *     which names a channel triple which an `hsl()` wraps which a `color-mix()`
 *     softens. Nothing errors if a link is wrong — the surface just paints
 *     nothing, which is the failure class the theme contract exists for.
 *  3. Does reduced motion actually reach a transition? The token collapse only
 *     covers motion that reads a token; the floor under it has to catch the
 *     rest, and `data-motion="essential"` has to survive both.
 *
 * Reads src/theme/tokens.css directly, so it measures what the package ships.
 *
 *   node scripts/token-render.mjs                 # table + PASS/FAIL, no files
 *   node scripts/token-render.mjs --out /tmp/dir  # also writes the sweep PNGs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const tokensCss = resolve(here, '..', '..', 'src', 'theme', 'tokens.css')
const outIndex = process.argv.indexOf('--out')
const outDir = outIndex > -1 ? process.argv[outIndex + 1] : null

const ALPHAS = [22, 30, 35, 40, 45, 55, 60, 70, 100]
/** Surface pairs a 1px hairline actually has to survive on. */
const SURFACES = [
  ['background', 'hsl(var(--background))'],
  ['card', 'hsl(var(--card))'],
  ['muted', 'hsl(var(--muted))'],
]

// Inlined rather than linked: a page served from about:blank cannot load a
// file:// stylesheet, and inlining also guarantees the measurement runs against
// the bytes on disk rather than a stale build.
const sweepPage = () => `<!doctype html><meta charset="utf-8">
<style>
${readFileSync(tokensCss, 'utf8')}
</style>
<style>
  body { margin: 0; font: 11px/1.4 ui-sans-serif, system-ui, sans-serif; width: 900px; }
  .pane { padding: 14px 18px 18px; background: hsl(var(--background)); color: hsl(var(--foreground)); }
  .cap { font-size: 9px; opacity: .55; letter-spacing: .05em; margin-bottom: 5px; }
  .band { display: flex; gap: 10px; }
  .col { flex: 1; }
  .surf { padding: 9px 10px; border-radius: var(--radius-lg); }
  .rows > div { padding: 5px 2px; }
  .rows > div + div { border-top: 1px solid var(--edge); }
  .box { border: 1px solid var(--edge); border-radius: var(--radius-md); padding: 7px 9px; margin-top: 8px; }
</style>
<script>
  const ALPHAS = ${JSON.stringify(ALPHAS)}
  const SURFACES = ${JSON.stringify(SURFACES)}
  addEventListener('DOMContentLoaded', () => {
    for (const [mode, attr] of [['light', ''], ['dark', ' data-theme="dark"']]) {
      let html = \`<div class="pane"\${attr}><div class="cap">\${mode.toUpperCase()} — 1px hairline at candidate alphas of --border</div>\`
      for (const [label, fill] of SURFACES) {
        html += \`<div class="cap">on \${label}</div><div class="band">\`
        for (const a of ALPHAS) {
          html += \`<div class="col"><div class="cap">\${a}%</div>
            <div class="surf" style="background: \${fill}; --edge: color-mix(in oklch, hsl(var(--border)) \${a}%, transparent)">
              <div class="rows"><div>Form 1040</div><div>W-2</div><div>1099-INT</div></div>
              <div class="box" style="background: hsl(var(--popover))">Card edge</div>
            </div></div>\`
        }
        html += '</div>'
      }
      document.body.insertAdjacentHTML('beforeend', html + '</div>')
    }
  })
</script>`

/** WCAG contrast between two [r, g, b] byte triples. */
function contrast(a, b) {
  const lum = ([r, g, b]) => {
    const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewportSize: { width: 900, height: 900 }, deviceScaleFactor: 1 })
await page.setContent(sweepPage())
await page.waitForTimeout(150)

if (outDir) {
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'token-tier-sweep.png')
  await page.screenshot({ path: file, fullPage: true })
  console.log(`sweep → ${file}\n`)
}

/**
 * The sRGB bytes a 1px hairline actually delivers, and the surface behind it.
 *
 * The colour is resolved by the browser (so the whole `--border` -> ramp stop ->
 * triple -> `hsl()` -> `color-mix()` chain is exercised, not re-implemented) and
 * then RASTERISED on a canvas. `getComputedStyle` keeps a `color-mix(in oklch, …)`
 * in oklch form, and reading three oklch components as if they were RGB bytes is
 * how this script first reported a pale grey hairline at 20.97:1 against white.
 * The canvas is what forces the answer into the space the eye receives, and it
 * composites the alpha over the surface while it is at it.
 */
const measure = (mode, alpha, fill) =>
  page.evaluate(([m, a, f]) => {
    const host = document.createElement('div')
    if (m === 'dark') host.setAttribute('data-theme', 'dark')
    host.style.background = f
    const line = document.createElement('div')
    line.style.background = a === null ? 'var(--border-soft)' : `color-mix(in oklch, hsl(var(--border)) ${a}%, transparent)`
    host.append(line)
    document.body.append(host)
    const hairline = getComputedStyle(line).backgroundColor
    const surface = getComputedStyle(host).backgroundColor
    host.remove()

    const raster = (fills) => {
      const canvas = new OffscreenCanvas(1, 1)
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, 1, 1)
      for (const value of fills) {
        ctx.fillStyle = value
        ctx.fillRect(0, 0, 1, 1)
      }
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b]
    }
    return { composited: raster([surface, hairline]), surface: raster([surface]) }
  }, [mode, alpha, fill])

let failures = 0
for (const mode of ['light', 'dark']) {
  console.log(`\n=== ${mode.toUpperCase()} — contrast of the composited 1px line against its surface ===`)
  console.log(['alpha', ...SURFACES.map(([l]) => l.padStart(12))].join('  '))
  for (const alpha of ALPHAS) {
    const cells = []
    for (const [, fill] of SURFACES) {
      const { composited, surface } = await measure(mode, alpha, fill)
      cells.push(contrast(composited, surface).toFixed(3).padStart(12))
    }
    console.log([String(alpha).padStart(5), ...cells].join('  '))
  }
  // What the package SHIPS, resolved through --border-soft rather than a literal.
  const shipped = []
  for (const [, fill] of SURFACES) {
    const { composited, surface } = await measure(mode, null, fill)
    shipped.push(contrast(composited, surface).toFixed(3).padStart(12))
  }
  console.log(['ship'.padStart(5), ...shipped].join('  '), ' ← --border-soft as shipped')
}

console.log('\n=== substitution chain ===')
const paint = (expr) =>
  page.evaluate(([e]) => {
    const el = document.createElement('div')
    el.style.color = e
    document.body.append(el)
    const out = getComputedStyle(el).color
    el.remove()
    return out
  }, [expr])

for (const [name, expr] of [
  ['--border via the ramp', 'hsl(var(--border))'],
  ['--border-soft', 'var(--border-soft)'],
  ['--card-edge', 'var(--card-edge)'],
]) {
  const value = await paint(expr)
  // An unresolvable var() computes to nothing, which paints as fully transparent
  // — the exact failure that ships invisible instead of erroring.
  const resolved = value !== '' && value !== 'rgba(0, 0, 0, 0)'
  if (!resolved) failures++
  console.log(`${resolved ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${value || '<nothing>'}`)
}

// --radius-md is the one number a restructure onto a single root must not move:
// gtm-agent and the bridged sandbox-ui components already ship against 8px.
const radius = await page.evaluate(() => {
  const el = document.createElement('div')
  el.style.borderRadius = 'var(--radius-md)'
  document.body.append(el)
  const out = getComputedStyle(el).borderRadius
  el.remove()
  return out
})
if (radius !== '8px') failures++
console.log(`${radius === '8px' ? 'PASS' : 'FAIL'}  ${'--radius-md'.padEnd(24)} ${radius}`)

console.log('\n=== reduced motion ===')
const motion = async (reduced) => {
  const p = await browser.newPage({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
  await p.setContent(sweepPage())
  const out = await p.evaluate(() => {
    const make = (essential) => {
      const el = document.createElement('div')
      if (essential) el.setAttribute('data-motion', 'essential')
      el.style.transition = 'opacity 400ms ease'
      document.body.append(el)
      const value = getComputedStyle(el).transitionDuration
      el.remove()
      return value
    }
    const tokened = document.createElement('div')
    tokened.style.transition = 'opacity var(--motion-surface)'
    document.body.append(tokened)
    const viaToken = getComputedStyle(tokened).transitionDuration
    tokened.remove()
    return { viaToken, untokenised: make(false), essential: make(true) }
  })
  await p.close()
  return out
}
const normal = await motion(false)
const reduced = await motion(true)
const checks = [
  ['token-driven motion collapses', normal.viaToken !== reduced.viaToken && Number.parseFloat(reduced.viaToken) <= 0.001],
  ['collapsed duration is non-zero (transitionend still fires)', Number.parseFloat(reduced.viaToken) > 0],
  ['the floor reaches motion that reads no token', Number.parseFloat(reduced.untokenised) <= 0.001],
  ['data-motion="essential" survives', reduced.essential === normal.essential],
]
for (const [label, ok] of checks) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(`      normal ${JSON.stringify(normal)}\n      reduce ${JSON.stringify(reduced)}`)

await browser.close()
if (outDir) writeFileSync(join(outDir, 'token-render.json'), JSON.stringify({ normal, reduced }, null, 2))
if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
