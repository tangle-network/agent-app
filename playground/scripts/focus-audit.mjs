/**
 * Keyboard-focus visibility audit — the ground truth for the `:focus-visible`
 * floor in tokens.css.
 *
 * A grep can tell you which components DECLARE a focus style. Only a real
 * browser can tell you what a keyboard user actually SEES, because every part
 * of that is a cascade question a static scan cannot answer: an `outline-none`
 * utility and the floor rule carry the SAME specificity (so source order
 * decides), `ring-*` paints a box-shadow while the floor paints an outline, an
 * `overflow-hidden` ancestor can clip an outline away, and the indicator is
 * often not on the focused element at all — a composer textarea is indicated by
 * a `focus-within` ring on the card around it.
 *
 * So the audit drives REAL Tab presses (programmatic `.focus()` does not
 * reliably put Chromium into keyboard modality, and `:focus-visible` is exactly
 * the modality question) and diffs the painted result against the same
 * element's unfocused state, across the element AND its nearest ancestors.
 *
 * Two measurement traps this encodes, both of which produced a wrong number
 * before they were fixed:
 *
 *  1. `box-shadow` is in the `transition` utility's property list, so a ring
 *     read immediately after the keypress computes to the fully transparent
 *     START of a 150 ms animation. That reported 118 of 176 elements as
 *     unindicated when the true count was 8. Transitions are disabled before
 *     measuring, which makes the settled value the first value.
 *  2. Reading only the focused element misses ancestor `focus-within`
 *     indicators and same-element border-color changes, both of which are real
 *     indicators. Those are diffed explicitly and reported by MECHANISM, so a
 *     1 px border tint is never counted as equivalent to a 2 px ring.
 *
 * Usage: start the demo (npm run dev), then `node scripts/focus-audit.mjs`.
 * Exits non-zero if any element is reachable by Tab with no indicator at all.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4321'
const ROUTES = (process.env.ROUTES ?? '/canvas,/timeline,/chat,/composer,/studio,/workspace').split(',')
const THEMES = [
  { q: '', label: 'light' },
  { q: '?theme=dark', label: 'dark' },
]
const MAX_TAB = Number(process.env.MAX_TAB ?? 140)
const ANCESTOR_DEPTH = 3

/** Stamp every focusable element and snapshot its unfocused paint state. */
const SNAPSHOT = (depth) => {
  const FOCUSABLE =
    'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
  const chain = (el) => {
    const out = []
    let node = el
    for (let i = 0; i <= depth && node instanceof Element; i++) {
      const cs = getComputedStyle(node)
      out.push({
        outline: `${cs.outlineStyle}|${cs.outlineWidth}|${cs.outlineColor}`,
        boxShadow: cs.boxShadow,
        border: `${cs.borderTopColor}|${cs.borderTopWidth}|${cs.borderLeftColor}`,
        background: cs.backgroundColor,
      })
      node = node.parentElement
    }
    return out
  }
  const els = [...document.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0,
  )
  const base = []
  els.forEach((el, i) => {
    el.setAttribute('data-focus-audit', String(i))
    base.push(chain(el))
  })
  window.__focusAuditBase = base
  window.__focusAuditChain = chain
  return els.length
}

/** Read the focused element and decide, by mechanism, whether focus is visible. */
const PROBE = (depth) => {
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return null
  const idx = el.getAttribute('data-focus-audit')
  const cs = getComputedStyle(el)
  const alphaOf = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c)
    if (!m) return 1
    const parts = m[1].split(',').map((s) => Number.parseFloat(s))
    return parts.length > 3 ? parts[3] : 1
  }
  const shadowPainted = (value) => {
    if (!value || value === 'none') return false
    return value.split(/,(?![^(]*\))/).some((s) => {
      if (alphaOf(s) <= 0.05) return false
      const nums = (s.match(/-?\d*\.?\d+px/g) ?? []).map(Number.parseFloat)
      return nums.some((n) => Math.abs(n) > 0)
    })
  }

  const outlineWidth = Number.parseFloat(cs.outlineWidth) || 0
  const outlinePainted = cs.outlineStyle !== 'none' && outlineWidth > 0 && alphaOf(cs.outlineColor) > 0.05

  // An outline is drawn OUTSIDE the border box, so an element sitting flush
  // against an `overflow-hidden` ancestor has its ring cut off on that side —
  // computed style still reports a painted outline while the user sees one
  // edge. Presence and visibility are not the same measurement.
  const clipped = []
  if (outlinePainted) {
    const r = el.getBoundingClientRect()
    const reach = (Number.parseFloat(cs.outlineOffset) || 0) + outlineWidth
    const need = { left: r.left - reach, top: r.top - reach, right: r.right + reach, bottom: r.bottom + reach }
    for (let n = el.parentElement; n; n = n.parentElement) {
      const ncs = getComputedStyle(n)
      if (!/hidden|auto|scroll|clip/.test(ncs.overflow + ncs.overflowX + ncs.overflowY)) continue
      const b = n.getBoundingClientRect()
      for (const side of ['left', 'top', 'right', 'bottom']) {
        const past = side === 'left' || side === 'top' ? need[side] < b[side] - 0.5 : need[side] > b[side] + 0.5
        if (past && !clipped.includes(side)) clipped.push(side)
      }
    }
  }

  const mechanisms = []
  if (outlinePainted) mechanisms.push(`outline ${cs.outlineWidth} @${cs.outlineOffset}`)

  const base = idx === null ? null : window.__focusAuditBase?.[Number(idx)]
  const now = idx === null ? null : window.__focusAuditChain(el)
  if (base && now) {
    for (let i = 0; i < now.length && i < base.length; i++) {
      const where = i === 0 ? 'self' : `ancestor+${i}`
      if (now[i].boxShadow !== base[i].boxShadow && shadowPainted(now[i].boxShadow)) {
        // Width of the widest ring segment, so a 1px hairline is not reported
        // as if it were a 2px ring.
        const px = (now[i].boxShadow.match(/-?\d*\.?\d+px/g) ?? []).map(Number.parseFloat)
        mechanisms.push(`ring ${Math.max(...px.map(Math.abs))}px (${where})`)
      }
      if (now[i].border !== base[i].border) mechanisms.push(`border-color (${where})`)
      if (now[i].outline !== base[i].outline && i > 0) mechanisms.push(`outline (${where})`)
      if (now[i].background !== base[i].background) mechanisms.push(`background (${where})`)
    }
  }

  const label =
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    (el.textContent ?? '').trim().slice(0, 40) ||
    el.getAttribute('title') ||
    ''
  return {
    tag: el.tagName.toLowerCase(),
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 130),
    label,
    focusVisible: el.matches(':focus-visible'),
    outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} @${cs.outlineOffset}`,
    mechanisms,
    clipped,
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

let checked = 0
const offenders = []
const clippedRings = []
const byMechanism = new Map()

for (const route of ROUTES) {
  for (const theme of THEMES) {
    await page.goto(`${BASE}${route}${theme.q}`, { timeout: 20000 })
    await page.waitForTimeout(900)
    await page.addStyleTag({
      content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
    })
    // The baseline has to be the genuinely UNFOCUSED paint, and a surface that
    // autofocuses on mount is not in it. `EntryComposer` passes `autoFocus`, so
    // on /workspace the composer card is already `:focus-within` when the page
    // settles: its focused border tint gets recorded as the baseline, the later
    // Tab to that textarea diffs focused-against-focused, and the audit reports
    // a real, working indicator as no indicator at all. Blurring first is what
    // makes the diff measure focus rather than arrival order — the third
    // measurement trap in this file, and the one that produced a false
    // ACCUSATION rather than a false number.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await page.waitForTimeout(80)
    await page.evaluate(SNAPSHOT, ANCESTOR_DEPTH)
    const seen = new Set()
    let routeChecked = 0
    let routeInvisible = 0
    for (let i = 0; i < MAX_TAB; i++) {
      await page.keyboard.press('Tab')
      const probe = await page.evaluate(PROBE, ANCESTOR_DEPTH)
      if (!probe) continue
      const key = `${probe.tag}|${probe.cls}|${probe.label}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!probe.focusVisible) continue
      routeChecked++
      const kind = probe.mechanisms.length === 0 ? 'NONE' : probe.mechanisms[0].split(' ')[0]
      byMechanism.set(kind, (byMechanism.get(kind) ?? 0) + 1)
      if (probe.mechanisms.length === 0) {
        routeInvisible++
        offenders.push({ route, theme: theme.label, ...probe })
      } else if (probe.clipped.length >= 2) {
        // One clipped edge still leaves three; two or more and the ring stops
        // reading as a ring.
        clippedRings.push({ route, theme: theme.label, ...probe })
      }
    }
    checked += routeChecked
    console.log(`${route} (${theme.label}): ${routeChecked} focusable checked, ${routeInvisible} with NO indicator`)
  }
}

console.log('\n──────── NO INDICATOR AT ALL ────────')
for (const o of offenders) {
  console.log(`  ${o.route} ${o.theme}  <${o.tag}> "${o.label}"`)
  console.log(`     outline: ${o.outline}`)
  console.log(`     class:   ${o.cls}`)
}
console.log('\n──────── RING CLIPPED BY AN overflow-hidden ANCESTOR ────────')
for (const c of clippedRings) {
  console.log(`  ${c.route} ${c.theme}  <${c.tag}> "${c.label}"  clipped: ${c.clipped.join(',')}`)
  console.log(`     class:   ${c.cls}`)
}

console.log('\n──────── INDICATOR MECHANISM ────────')
for (const [k, n] of [...byMechanism.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`)
console.log('\n──────── SUMMARY ────────')
console.log(`focusable elements reached by Tab: ${checked}`)
console.log(`with NO focus indicator:           ${offenders.length}`)
console.log(`with a ring clipped on 2+ sides:   ${clippedRings.length}`)
await browser.close()
process.exit(offenders.length > 0 ? 1 : 0)
