/**
 * Composer row overlap check — the ground truth for "no control in the
 * composer's bottom row is drawn over another".
 *
 * jsdom has no layout, so the unit test can only pin class names. This drives
 * real Chromium against every `[data-composer-overlap]` host on the composer
 * route and asserts that no rendered child of `composer-controls` intersects
 * any other element on that row (attach, the trailing slot, dictation, Send). The defect it
 * guards shipped in Legal at 390px: the controls slot was `min-w-0`, so a lone
 * Plan chip was squeezed to nothing and painted underneath a trailing model
 * picker.
 *
 * Usage: start the demo (npm run dev), then `node scripts/composer-row-overlap.mjs`.
 * Exits non-zero on any overlap or on a row control pushed past the card edge. `SHOT_DIR` writes one screenshot per host
 * and theme.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4321'
const ROUTE = process.env.ROUTE ?? '/composer'
const SHOT_DIR = process.env.SHOT_DIR ?? ''
const THEMES = (process.env.THEMES ?? 'light,dark').split(',')

if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })

const MEASURE = () => {
  const intersects = (a, b) =>
    a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
    a.left < b.right - 0.5 && b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
  const out = []
  for (const host of document.querySelectorAll('[data-composer-overlap]')) {
    const label = host.getAttribute('data-composer-overlap')
    const controls = host.querySelector('[data-testid="composer-controls"]')
    if (!controls) {
      out.push({ label, error: 'composer-controls missing' })
      continue
    }
    // Everything else on the row — attach, the trailing slot, dictation, Send,
    // or the group that holds them — must stay clear of every control.
    const others = [...controls.parentElement.children].filter((el) => el !== controls)
    const hits = []
    for (const child of controls.children) {
      const r = child.getBoundingClientRect()
      for (const other of others) {
        if (intersects(r, other.getBoundingClientRect())) {
          hits.push(`"${(child.textContent ?? '').trim() || child.tagName}" under "${(other.textContent ?? '').trim() || other.getAttribute('aria-label') || other.tagName}"`)
        }
      }
    }
    // A child wider than its slot also means it was squeezed and spilled.
    const slot = controls.getBoundingClientRect()
    for (const child of controls.children) {
      const r = child.getBoundingClientRect()
      if (r.right > slot.right + 0.5) hits.push(`"${(child.textContent ?? '').trim()}" spills past its slot`)
    }
    // Inside the actions group nothing may be drawn over anything else either:
    // a trailing picker and Send that cannot share a line must wrap, not stack.
    const actions = host.querySelector('[data-testid="composer-actions"]')
    // Compare the buttons themselves, not their wrappers: a `min-w-0` trailing
    // slot can shrink while the picker inside it keeps its width and spills
    // under Send, and the two wrappers' boxes would still look disjoint.
    if (actions) {
      const items = [...actions.querySelectorAll('button')]
      const name = (el) => (el.textContent ?? '').trim() || el.getAttribute('aria-label') || el.tagName
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          if (items[i].contains(items[j]) || items[j].contains(items[i])) continue
          if (intersects(items[i].getBoundingClientRect(), items[j].getBoundingClientRect())) {
            hits.push(`"${name(items[i])}" under "${name(items[j])}"`)
          }
        }
      }
    }
    const actionRect = (others.at(-1) ?? controls).getBoundingClientRect()
    // Nothing on the row may be pushed past the card's own edge either: a
    // trailing group that cannot shrink or wrap overflows the card instead.
    const card = host.querySelector('[data-testid="composer-card"]')?.getBoundingClientRect()
    if (card) {
      for (const button of controls.parentElement.querySelectorAll('button')) {
        const r = button.getBoundingClientRect()
        if (r.width > 0 && r.right > card.right + 0.5) {
          hits.push(`"${(button.textContent ?? '').trim() || button.getAttribute('aria-label')}" overflows the card`)
        }
      }
    }
    out.push({ label, hits, slotWidth: Math.round(slot.width), actionsTop: Math.round(actionRect.top), slotTop: Math.round(slot.top) })
  }
  return out
}

const browser = await chromium.launch()
let failures = 0
try {
  for (const theme of THEMES) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
    await page.goto(`${BASE}${ROUTE}`)
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t
      document.documentElement.classList.toggle('dark', t === 'dark')
    }, theme)
    await page.waitForSelector('[data-composer-overlap] [data-testid="composer-controls"]', { state: 'attached' })
    const results = await page.evaluate(MEASURE)
    if (results.length === 0) {
      console.error(`[${theme}] no [data-composer-overlap] host on ${ROUTE}`)
      failures += 1
    }
    for (const r of results) {
      if (r.error || r.hits.length > 0) {
        failures += 1
        console.error(`FAIL [${theme}] ${r.label}: ${r.error ?? r.hits.join(', ')}`)
      } else {
        console.log(`ok   [${theme}] ${r.label}: controls slot ${r.slotWidth}px, actions ${r.actionsTop > r.slotTop ? 'wrapped below' : 'on the same line'}`)
      }
      if (SHOT_DIR) {
        await page.locator(`[data-composer-overlap="${r.label}"]`).screenshot({ path: `${SHOT_DIR}/${r.label}-${theme}.png` })
      }
    }
    await page.close()
  }
} finally {
  await browser.close()
}
if (failures > 0) {
  console.error(`${failures} composer row overlap(s)`)
  process.exit(1)
}
