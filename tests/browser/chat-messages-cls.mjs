import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const out = process.env.CLS_ARTIFACTS ?? '/tmp/chat-messages-cls'
await mkdir(out, { recursive: true })
const server = spawn('python3', ['-m', 'http.server', '6098', '--directory', 'storybook-static'], { stdio: 'ignore' })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const results = []
try {
  for (const width of [1280, 390]) for (const theme of ['agent-dark', 'agent-light']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, recordVideo: { dir: out } })
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:6098/iframe.html?id=chat-chatmessages--two-agents-answering&globals=agentTheme:${theme}`)
    await page.waitForSelector('[data-stream-length="0"]')
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      window.__shifts = []
      window.__streamStartedAt = 0
      const stream = document.querySelector('[data-stream-length]')
      new MutationObserver(() => {
        if (Number(stream.dataset.streamLength) > 0) window.__streamStartedAt ||= performance.now()
      }).observe(stream, { attributes: true, attributeFilter: ['data-stream-length'] })
      window.__observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput && window.__streamStartedAt && e.startTime >= window.__streamStartedAt) window.__shifts.push({
          value: e.value, at: e.startTime, sources: e.sources.map((s) => ({ text: s.node?.textContent?.slice(0, 80), previous: s.previousRect.toJSON(), current: s.currentRect.toJSON() })),
        })
      })
      window.__observer.observe({ type: 'layout-shift' })
    })
    await page.waitForSelector('[data-stream-complete="true"]', { timeout: 20000 })
    await page.waitForTimeout(1000)
    const shifts = await page.evaluate(() => {
      if (!window.__streamStartedAt) throw new Error('no second-responder deltas observed')
      return window.__shifts
    })
    let total = 0, session = 0, start = 0, last = 0
    for (const entry of shifts) {
      if (entry.at - last > 1000 || entry.at - start > 5000) { session = 0; start = entry.at }
      session += entry.value; last = entry.at; total = Math.max(total, session)
    }
    results.push({ width, theme, total, shifts })
    await page.screenshot({ path: `${out}/${width}-${theme}.png`, fullPage: true })
    await context.close()
  }
  await writeFile(`${out}/cls.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results.map(({ width, theme, total }) => ({ width, theme, cls: total }))))
  if (results.some((r) => r.total !== 0)) process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
