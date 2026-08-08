/**
 * Popover hit-test audit — the ground truth for "can a user actually click the
 * canonical pickers".
 *
 * A unit test renders a popover and asserts its menu items exist. That test is
 * green for the exact defect this audit exists to catch: the shipped chat
 * composer docks the model/thinking pills inside a horizontally scrolling rail
 * (`overflow-x-auto`), a scroll container CLIPS every positioned descendant
 * whose containing block sits inside it, and the menu therefore had the right
 * roles, the right items, the right `getBoundingClientRect()` — and painted
 * zero pixels. A real `.click()` on a row timed out, which is what happens to a
 * real user's click.
 *
 * So presence is not the measurement. HIT-TESTABILITY is:
 * `document.elementFromPoint(centre)` must return the panel itself or something
 * inside it. That single question catches every mechanism at once — an ancestor
 * clip, a stacking-context trap where a high `z-index` is meaningless, a
 * transparent surface token, an overlay painting on top — because all of them
 * end with a different element answering at the popover's own coordinates.
 *
 * `playground/src/routes/ComposerRoute.tsx` mounts the pickers inside the real
 * host rail markup (see `HostScrollRail`), so this drives the shape that broke
 * rather than an idealised one. Triggers are enumerated by ARIA
 * (`button[aria-haspopup]`), so a picker added to the audited hosts is covered
 * without editing this file.
 *
 * Usage: start the demo (npm run dev), then `node scripts/popover-hit-test.mjs`.
 * Exits non-zero if any popover is unreachable. `SHOT_DIR` writes a screenshot
 * per popover.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4321'
const ROUTE = process.env.ROUTE ?? '/composer'
const SHOT_DIR = process.env.SHOT_DIR ?? ''
const THEMES = (process.env.THEMES ?? 'light,dark').split(',')
/** Panels smaller than this in either axis are not a usable menu. */
const MIN_PANEL_PX = 24

if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

/**
 * Read one open popover: where the panel claims to be, and who actually
 * answers at those coordinates.
 *
 * The panel is resolved through four fallbacks on purpose, so ONE probe reads
 * both DOM shapes: a panel rendered in place next to its trigger, and a panel
 * portaled out of the trigger's subtree. A probe that only knew one of them
 * would report the other as "missing" and turn a placement change into a fake
 * pass or a fake failure.
 */
const PROBE = ({ triggerIndex, minPanelPx }) => {
  const trigger = document.querySelectorAll('[data-popover-audit] button[aria-haspopup]')[triggerIndex]
  if (!trigger) return { error: 'trigger vanished' }

  const controls = trigger.getAttribute('aria-controls')
  const inPlaceSibling = [...(trigger.parentElement?.children ?? [])].find(
    (c) => c !== trigger && c.tagName === 'DIV',
  )
  const panel =
    (controls && document.getElementById(controls)) ||
    document.querySelector('[data-agent-app-popover]') ||
    inPlaceSibling ||
    document.querySelector('[role="menu"]')
  if (!panel) return { error: 'no panel in the document while expanded' }

  const rect = panel.getBoundingClientRect()
  const cs = getComputedStyle(panel)

  // Centre, plus the centres of the first two option rows: a panel can be
  // reachable at its middle and still have its rows covered.
  const points = [{ label: 'panel centre', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }]
  const rows = [...panel.querySelectorAll('button')].slice(0, 2)
  for (const [i, row] of rows.entries()) {
    const r = row.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) {
      points.push({ label: `row ${i} (zero-size)`, x: 0, y: 0, zeroSize: true })
      continue
    }
    points.push({ label: `row ${i}`, x: r.left + r.width / 2, y: r.top + r.height / 2 })
  }

  const describe = (el) => {
    if (!el) return 'null'
    const cls = typeof el.className === 'string' ? el.className.trim().slice(0, 70) : ''
    return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ''}>`
  }

  const hits = points.map((p) => {
    if (p.zeroSize) return { ...p, ok: false, hit: 'zero-size row' }
    const el = document.elementFromPoint(p.x, p.y)
    const inside = !!el && (el === panel || panel.contains(el))
    return { label: p.label, x: Math.round(p.x), y: Math.round(p.y), ok: inside, hit: describe(el) }
  })

  // The clipping mechanism, reported by name when it is present, so a failure
  // says WHY and not only THAT.
  const clippers = []
  for (let n = panel.parentElement; n; n = n.parentElement) {
    const ncs = getComputedStyle(n)
    const overflow = `${ncs.overflow}${ncs.overflowX}${ncs.overflowY}`
    const traps = []
    if (/hidden|auto|scroll|clip/.test(overflow)) traps.push(`overflow:${ncs.overflowX}/${ncs.overflowY}`)
    if (ncs.transform !== 'none') traps.push('transform')
    if (ncs.filter !== 'none') traps.push('filter')
    if (ncs.backdropFilter && ncs.backdropFilter !== 'none') traps.push('backdrop-filter')
    if (ncs.contain && ncs.contain !== 'none') traps.push(`contain:${ncs.contain}`)
    if (traps.length) clippers.push(`${describe(n)} ${traps.join(',')}`)
  }

  return {
    label: (trigger.getAttribute('aria-label') || trigger.textContent || '').trim().slice(0, 46),
    host: trigger.closest('[data-popover-audit]')?.getAttribute('data-popover-audit') ?? '?',
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    surface: { background: cs.backgroundColor, opacity: cs.opacity, visibility: cs.visibility, zIndex: cs.zIndex },
    onScreen:
      rect.width >= minPanelPx &&
      rect.height >= minPanelPx &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth,
    hits,
    clippers: clippers.slice(0, 4),
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

const failures = []
let checked = 0

for (const theme of THEMES) {
  const url = `${BASE}${ROUTE}${theme === 'dark' ? '?theme=dark' : ''}`
  await page.goto(url, { timeout: 20000 })
  await page.waitForSelector('[data-popover-audit] button[aria-haspopup]', { timeout: 15000 })
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  })

  const triggerCount = await page.locator('[data-popover-audit] button[aria-haspopup]').count()
  if (triggerCount === 0) {
    console.error(`${ROUTE} (${theme}): no audited popover triggers found — the audit would pass vacuously`)
    process.exit(2)
  }

  for (let i = 0; i < triggerCount; i++) {
    const trigger = page.locator('[data-popover-audit] button[aria-haspopup]').nth(i)
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    await page.waitForTimeout(120)

    const probe = await page.evaluate(PROBE, { triggerIndex: i, minPanelPx: MIN_PANEL_PX })
    checked++

    if (probe.error) {
      failures.push({ theme, index: i, ...probe })
      console.log(`  [${theme}] trigger ${i}: FAIL — ${probe.error}`)
      continue
    }

    const unreachable = probe.hits.filter((h) => !h.ok)
    const ok = probe.onScreen && unreachable.length === 0
    console.log(
      `  [${theme}] ${probe.host} · "${probe.label}" → ${ok ? 'PASS' : 'FAIL'}  ` +
        `rect ${probe.rect.w}x${probe.rect.h} @(${probe.rect.x},${probe.rect.y})  ` +
        `bg ${probe.surface.background} z${probe.surface.zIndex}`,
    )
    for (const h of probe.hits) {
      console.log(`        ${h.ok ? 'hit ' : 'MISS'} ${h.label} @(${h.x},${h.y}) → ${h.hit}`)
    }
    if (!ok && probe.clippers.length) {
      console.log(`        ancestors that can trap it: ${probe.clippers.join(' | ')}`)
    }

    if (SHOT_DIR) {
      const name = `${theme}-${String(i).padStart(2, '0')}-${probe.host}-${ok ? 'pass' : 'FAIL'}.png`
      await page.screenshot({ path: `${SHOT_DIR}/${name}` })
    }
    if (!ok) failures.push({ theme, index: i, ...probe })

    await page.keyboard.press('Escape')
    await page.waitForTimeout(60)
  }
}

console.log('\n──────── SUMMARY ────────')
console.log(`popovers opened and probed: ${checked}`)
console.log(`unreachable (invisible or un-clickable): ${failures.length}`)
for (const f of failures) {
  console.log(`  [${f.theme}] ${f.host ?? '?'} "${f.label ?? f.error}"`)
}
await browser.close()
process.exit(failures.length > 0 ? 1 : 0)
