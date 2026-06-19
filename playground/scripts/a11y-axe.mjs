/**
 * Deterministic a11y + contrast audit of the agent-app surfaces via axe-core.
 * Unlike an LLM vision pass, this returns real WCAG violations (exact contrast
 * ratios, missing labels/roles) with element selectors — no model judgment.
 *
 * Usage: start the demo (npm run dev), then `node scripts/a11y-axe.mjs`.
 */
import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4321'
const ROUTES = ['/canvas', '/timeline', '/chat']
const THEMES = [
  { q: '', label: 'light' },
  { q: '?theme=dark', label: 'dark' },
]
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
let total = 0
const byRule = new Map()

for (const route of ROUTES) {
  for (const theme of THEMES) {
    const url = `${BASE}${route}${theme.q}`
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
    } catch {
      await page.goto(url, { timeout: 15000 })
    }
    await page.waitForTimeout(700) // let React + Konva settle
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    total += violations.length
    console.log(`\n=== ${route} (${theme.label}) — ${violations.length} violation(s) ===`)
    for (const v of violations) {
      byRule.set(v.id, (byRule.get(v.id) ?? 0) + v.nodes.length)
      console.log(`  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help} — ${v.nodes.length} node(s)`)
      for (const n of v.nodes.slice(0, 4)) {
        const extra = (n.any?.[0]?.message || n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 140)
        console.log(`       → ${n.target.join(' ')}${extra ? '  ::  ' + extra : ''}`)
      }
    }
  }
}

console.log(`\n──────── SUMMARY ────────`)
console.log(`TOTAL violations across 3 routes × 2 themes: ${total}`)
for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule}: ${n} node(s)`)
}
await browser.close()
