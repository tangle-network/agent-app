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
const geometry = locator => locator.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, chars: el.textContent.length, font: getComputedStyle(el.querySelector('p') ?? el).fontSize }))
try {
  for (const [name, viewport, theme] of [
    ['desktop-light', { width: 1440, height: 900 }, 'agent-light'],
    ['desktop-dark', { width: 1440, height: 900 }, 'agent-dark'],
    ['phone', { width: 390, height: 844 }, 'agent-light'],
    ['desktop-reduced', { width: 1440, height: 900 }, 'agent-light'],
  ]) {
    const phone = name === 'phone'
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, reducedMotion: name === 'desktop-reduced' ? 'reduce' : 'no-preference', recordVideo: { dir: output, size: viewport } })
    await context.tracing.start({ screenshots: true, snapshots: true })
    const page = await context.newPage()
    const row = { name, viewport, theme, mode, startedAt: new Date().toISOString(), steps: [] }
    results.push(row)
    try {
      await page.goto(`${origin}/iframe.html?id=chat-reasoningrow--streaming-reading&viewMode=story&globals=agentTheme:${theme}`)
      const reasoning = page.locator('[data-reasoning="thinking"]')
      await reasoning.waitFor()
      await page.waitForTimeout(900)
      const before = await geometry(reasoning)
      await reasoning.evaluate(el => {
        const record = () => { window.__scrollInput = { top: el.scrollTop, at: performance.now() } }
        el.addEventListener('wheel', record, { once: true, capture: true })
        el.addEventListener('touchmove', record, { once: true, capture: true })
      })
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
      const input = await page.evaluate(() => window.__scrollInput)
      const anchor = await reasoning.evaluate(el => {
        const top = el.getBoundingClientRect().top
        const paragraph = [...el.querySelectorAll('p')].find(p => p.getBoundingClientRect().top >= top)
        if (!paragraph) throw new Error('No visible reading anchor')
        paragraph.dataset.readingAnchor = 'current'
        return { text: paragraph.textContent, offset: paragraph.getBoundingClientRect().top - top, lineHeight: parseFloat(getComputedStyle(paragraph).lineHeight) }
      })
      await page.screenshot({ path: `${output}/${name}-reading.png` })
      await page.waitForTimeout(1_200)
      const appended = await geometry(reasoning)
      const anchorAfter = await reasoning.evaluate(el => {
        const p = el.querySelector('[data-reading-anchor="current"]')
        return p ? { text: p.textContent, offset: p.getBoundingClientRect().top - el.getBoundingClientRect().top } : null
      })
      row.steps.push({ step: 'read during stream', before, input, reading, appended, anchor, anchorAfter, forcedJumpPx: appended.top - reading.top })
      assert.ok(appended.chars > reading.chars, 'reasoning grew while reading')
      if (mode === 'baseline') {
        row.reproduced = appended.top > reading.top + 20
        await page.screenshot({ path: `${output}/${name}-after-append.png` })
        continue
      }
      assert.ok(input && reading.top < input.top, `user input moved up from dispatch position: ${JSON.stringify({ input, reading })}`)
      assert.ok(Math.abs(appended.top - reading.top) <= 1, 'streaming does not move the reader')
      assert.equal(anchorAfter?.text, anchor.text, 'reading identity survives append')
      assert.ok(Math.abs(anchorAfter.offset - anchor.offset) <= anchor.lineHeight, 'anchor remains within one computed line-height')
      assert.ok(parseFloat(appended.font) >= 16, 'reasoning uses body-sized text')
      await page.getByRole('button', { name: 'Jump to latest reasoning', exact: true }).click()
      assert.equal(await reasoning.evaluate(el => document.activeElement === el), true, 'jump restores focus to the reading region')
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
      row.steps.push({ step: 'End return geometry', atBottom })
      assert.ok(atBottom.height - atBottom.client - atBottom.top <= 2, `returning to bottom resumes reasoning: ${JSON.stringify(atBottom)}`)
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
      row.roles = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        const time = value => value.endsWith('ms') ? parseFloat(value) : value.endsWith('s') ? parseFloat(value) * 1000 : null
        return Object.fromEntries(['--motion-control', '--motion-surface', '--motion-dismiss', '--motion-stream', '--motion-arrive', '--interaction-feedback-budget', '--interaction-pending-delay', '--interaction-long-work-delay', '--interaction-mutation-budget'].map(role => {
          const value = style.getPropertyValue(role).trim()
          return [role, { value, milliseconds: role.startsWith('--interaction-') ? time(value) : null }]
        }))
      })
      row.motion = await page.evaluate(() => [...document.getAnimations()].map(animation => ({ target: animation.effect?.target?.className, playState: animation.playState, timing: animation.effect?.getComputedTiming() })))
      if (name === 'desktop-reduced') assert.equal(row.motion.filter(a => a.playState === 'running').length, 0, 'reduced motion has no active animation')
      row.passed = true
    } catch (error) {
      row.error = error.message
      await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {})
      process.exitCode = 1
    } finally {
      await context.tracing.stop({ path: `${output}/${name}-trace.zip` })
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
