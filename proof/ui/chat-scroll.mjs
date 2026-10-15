// Streams the shared transcript story and exercises real wheel, keyboard and
// phone touch input. Retains videos, screenshots and scroll measurements.
// node proof/ui/chat-scroll.mjs <storybook-origin> <output> [baseline]
import assert from 'node:assert/strict'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const [origin, directory, mode = 'fixed'] = process.argv.slice(2)
if (!origin || !directory) throw new Error('Usage: chat-scroll.mjs <origin> <output> [baseline]')
const output = resolve(directory)
mkdirSync(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []
const geometry = locator => locator.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, chars: el.textContent.length, font: getComputedStyle(el).fontSize }))
try {
  for (const [name, viewport, theme] of [
    ['desktop-light', { width: 1440, height: 900 }, 'agent-light'],
    ['desktop-dark', { width: 1440, height: 900 }, 'agent-dark'],
    ['phone', { width: 390, height: 844 }, 'agent-light'],
  ]) {
    const phone = name === 'phone'
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, recordVideo: { dir: output, size: viewport } })
    const page = await context.newPage()
    const row = { name, viewport, theme, mode, startedAt: new Date().toISOString(), steps: [] }
    results.push(row)
    try {
      await page.goto(`${origin}/iframe.html?id=chat-reasoningrow--streaming-reading&viewMode=story&globals=agentTheme:${theme}`)
      const reasoning = page.locator('[data-reasoning="thinking"]')
      await reasoning.waitFor()
      await page.waitForTimeout(900)
      const before = await geometry(reasoning)
      assert.ok(before.height > before.client, 'long reasoning scrolls internally')
      const box = await reasoning.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      if (phone) {
        const cdp = await context.newCDPSession(page)
        const x = box.x + box.width / 2
        const y = box.y + Math.min(box.height / 2, 180)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        for (let i = 1; i <= 8; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 12 }] })
          await page.waitForTimeout(25)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      } else await page.mouse.wheel(0, -220)
      await page.waitForTimeout(200)
      const reading = await geometry(reasoning)
      await page.screenshot({ path: `${output}/${name}-reading.png` })
      await page.waitForTimeout(1_200)
      const appended = await geometry(reasoning)
      row.steps.push({ step: 'read during stream', before, reading, appended, forcedJumpPx: appended.top - reading.top })
      assert.ok(appended.chars > reading.chars, 'reasoning grew while reading')
      if (mode === 'baseline') {
        row.reproduced = appended.top > reading.top + 20
        await page.screenshot({ path: `${output}/${name}-after-append.png` })
        continue
      }
      assert.ok(reading.top < before.top, 'user input moved up')
      assert.ok(Math.abs(appended.top - reading.top) <= 1, 'streaming does not move the reader')
      assert.ok(parseFloat(appended.font) >= 16, 'reasoning uses body-sized text')
      await page.getByRole('button', { name: 'Jump to latest reasoning', exact: true }).click()
      await page.waitForTimeout(900)
      const resumed = await geometry(reasoning)
      assert.ok(resumed.height - resumed.client - resumed.top <= 2, 'jump resumes following')
      row.steps.push({ step: 'jump resumes reasoning', ...resumed })
      await reasoning.focus()
      await page.keyboard.press('PageUp')
      await page.waitForTimeout(300)
      const keyboardReading = await geometry(reasoning)
      await page.waitForTimeout(800)
      const keyboardAppended = await geometry(reasoning)
      assert.ok(Math.abs(keyboardAppended.top - keyboardReading.top) <= 1, 'keyboard reading persists')
      await page.keyboard.press('End')
      await page.waitForTimeout(900)
      const atBottom = await geometry(reasoning)
      assert.ok(atBottom.height - atBottom.client - atBottom.top <= 2, 'returning to bottom resumes reasoning')
      row.steps.push({ step: 'keyboard read and resume', keyboardReading, keyboardAppended, atBottom })
      const transcript = page.locator('[data-transcript-viewport]')
      await transcript.focus()
      await page.keyboard.press('Home')
      await page.waitForTimeout(300)
      const earlier = await geometry(transcript)
      await page.waitForTimeout(800)
      const later = await geometry(transcript)
      assert.ok(Math.abs(later.top - earlier.top) <= 1, 'outer viewport also preserves reading')
      await page.getByRole('button', { name: 'Jump to latest message', exact: true }).click()
      await page.waitForTimeout(400)
      const latest = await geometry(transcript)
      assert.ok(latest.height - latest.client - latest.top <= 2, 'outer jump reaches latest message')
      row.steps.push({ step: 'transcript read and resume', earlier, later, latest })
      await page.screenshot({ path: `${output}/${name}-latest.png` })
      row.passed = true
    } catch (error) {
      row.error = error.message
      await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {})
      process.exitCode = 1
    } finally {
      const video = page.video()
      await context.close()
      renameSync(await video.path(), `${output}/${name}.webm`)
    }
  }
} finally {
  await browser.close()
  writeFileSync(`${output}/measurements.json`, JSON.stringify({ origin, recordedAt: new Date().toISOString(), results }, null, 2) + '\n')
  console.log(JSON.stringify(results))
}
