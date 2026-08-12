/**
 * Records the mount animation of each surface the motion layer touches.
 *
 * A screenshot cannot show motion, and the change under review IS motion, so
 * each story is recorded from a cold navigation — the arrival stagger, the
 * stream blur, the shimmer and the caret all play once at mount and never
 * again, so a post-load capture would show the settled state and prove nothing.
 *
 * Recording starts before `goto` for the same reason: Playwright's video
 * begins with the context, and a page already navigated has already animated.
 */
import { chromium } from 'playwright'
import { mkdirSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2]
const BASE = 'http://localhost:6006/iframe.html?id='

const SURFACES = [
  { id: 'chat-chatmessages--agent-thinking', name: 'thinking', h: 700 },
  { id: 'chat-chatmessages--streaming-in-progress', name: 'streaming', h: 700 },
  { id: 'chatcontrols-interactionplancard--pending', name: 'approval-card', h: 620 },
  { id: 'chatcontrols-interactionquestioncard--select-multi-custom', name: 'question-card', h: 620 },
  { id: 'chatcontrols-missionactivitylane--timeline-expanded', name: 'mission-lane', h: 700 },
  { id: 'chat-chatmessages--long-history', name: 'arrival-stagger', h: 760 },
]

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()

for (const theme of ['dark', 'light']) {
  for (const s of SURFACES) {
    const dir = join(OUT, `${s.name}-${theme}`)
    mkdirSync(dir, { recursive: true })
    const ctx = await browser.newContext({
      viewport: { width: 900, height: s.h },
      deviceScaleFactor: 2,
      colorScheme: theme,
      recordVideo: { dir, size: { width: 900, height: s.h } },
    })
    const page = await ctx.newPage()
    // The toolbar decorator stamps the theme on <html>; the iframe is loaded
    // directly, so set it through the same globals the decorator reads.
    await page.goto(`${BASE}${s.id}&globals=theme:${theme}`, { waitUntil: 'load' })
    // Long enough for the slowest declared duration (--duration-arrive 600ms)
    // plus the full stagger ladder to finish, then a beat of settled state.
    await page.waitForTimeout(2600)
    await page.screenshot({ path: join(OUT, `${s.name}-${theme}.png`), fullPage: false })
    await ctx.close()
    const vids = readdirSync(dir).filter((f) => f.endsWith('.webm'))
    if (vids[0]) renameSync(join(dir, vids[0]), join(OUT, `${s.name}-${theme}.webm`))
    console.log(`captured ${s.name} ${theme}`)
  }
}

await browser.close()
