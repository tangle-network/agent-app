/** Real Storybook HTTP/browser integration; no intercepted requests or mocked components. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const output = resolve(process.env.WATERFALL_PROOF_DIR ?? '/tmp/flow-waterfall-proof')
mkdirSync(output, { recursive: true })
const base = process.env.WATERFALL_STORYBOOK_URL ?? 'http://127.0.0.1:6019'
const checks = {}
let server, browser, context
const log = createWriteStream(`${output}/storybook.log`)
try {
  if (!process.env.WATERFALL_STORYBOOK_URL) {
    server = spawn('pnpm', ['exec', 'storybook', 'dev', '--ci', '--no-open', '--port', '6019', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    server.stdout.pipe(log); server.stderr.pipe(log)
  }
  const deadline = Date.now() + 120_000
  while (true) {
    try { if ((await fetch(`${base}/iframe.html`)).ok) break } catch {}
    if (Date.now() > deadline || server?.exitCode != null) throw new Error('Storybook did not become ready; see storybook.log')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) })
  context = await browser.newContext({ viewport: { width: 1100, height: 900 }, recordVideo: { dir: output, size: { width: 1100, height: 900 } } })
  const page = await context.newPage()
  const failures = []
  page.on('pageerror', error => failures.push(error.message))
  const story = async (name, theme = 'agent-dark') => {
    await page.goto(`${base}/iframe.html?id=chatcontrols-flowwaterfall--${name}&viewMode=story&globals=agentTheme:${theme}`)
    await page.locator('[data-flow-waterfall]').waitFor({ timeout: 60_000 })
  }
  await story('recorded-discovery')
  const root = page.locator('[data-flow-waterfall]')
  assert.equal(await root.locator('[data-span-id]').count(), 53)
  await page.screenshot({ path: `${output}/recorded-desktop-dark.png`, fullPage: true })
  await page.keyboard.press('Control+f')
  assert.equal(await page.getByRole('searchbox', { name: 'Search trace' }).evaluate(el => el === document.activeElement), true)
  await page.getByRole('searchbox', { name: 'Search trace' }).fill('no-such-trace-step')
  await page.getByRole('status').filter({ hasText: 'No matching steps' }).waitFor({ timeout: 3000 })
  checks.search = 'PASS'
  checks.searchEmpty = 'PASS'
  if (process.argv.includes('--search-only')) { console.log('Search integration PASS'); process.exitCode = 0 }
  else {
    await page.screenshot({ path: `${output}/search-empty.png`, fullPage: true })
    await page.getByRole('searchbox', { name: 'Search trace' }).press('Escape')
    await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
    assert.equal(await root.locator('[data-span-id]').count(), 1)
    // Search reveals a match inside a collapsed nested worker, with its ancestry.
    await page.getByRole('searchbox', { name: 'Search trace' }).fill('Echo worker')
    assert.equal(await root.locator('[data-span-id]').count(), 2)
    await page.getByRole('searchbox', { name: 'Search trace' }).press('Escape')
    assert.equal(await root.locator('[data-span-id]').count(), 1)
    await page.getByRole('button', { name: 'Expand all', exact: true }).click()
    assert.equal(await root.locator('[data-span-id]').count(), 53)
    checks.nesting = 'PASS'
    checks.collapseExpand = 'PASS'
    const terms = await root.locator('dt').allTextContents()
    assert.deepEqual(terms, ['Duration', 'Cost', 'Tokens', 'LLM calls', 'Tool calls', 'Errors'])
    assert.deepEqual(await root.locator('dd').allTextContents(), ['430.8s', 'Unknown', '754,448', 'Unknown', '35', '3'])
    checks.summary = 'PASS'
    const kinds = await root.locator('.fw-bar').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.parentElement.parentElement.dataset.spanKind, getComputedStyle(element).backgroundColor])))
    assert.equal(Object.keys(kinds).length, 6)
    assert.equal(new Set(Object.values(kinds)).size, 6)
    assert.ok(!Object.values(kinds).includes('rgba(0, 0, 0, 0)'))
    checks.colors = 'PASS'
    assert.equal(await root.locator('[data-slowest]').count(), 1)
    assert.match(await root.locator('[data-slowest]').innerText(), /bash/)
    checks.slowest = 'PASS'
    assert.deepEqual(await page.getByLabel('Playback speed').locator('option').allTextContents(), ['0.5x', '1x', '1.5x', '2x', '4x'])
    await page.getByRole('button', { name: 'Restart', exact: true }).click()
    await page.getByLabel('Playback speed').selectOption('4')
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.waitForFunction(() => Number(document.querySelector('input[type=range]').value) > 600)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    const paused = await page.getByLabel('Playback position').inputValue()
    await page.waitForTimeout(180)
    assert.equal(await page.getByLabel('Playback position').inputValue(), paused)
    await page.getByRole('button', { name: 'Show full trace', exact: true }).click()
    checks.playback = 'PASS'
    await story('recorded-discovery', 'agent-light')
    await page.screenshot({ path: `${output}/recorded-desktop-light.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${output}/recorded-phone-light.png`, fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Only the timeline may scroll horizontally')
    await page.getByRole('region', { name: 'Trace timeline', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await story('recorded-discovery')
    await page.screenshot({ path: `${output}/recorded-phone-dark.png`, fullPage: true })
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await story('growing-live-trace')
    const duration = await page.locator('dd').first().innerText()
    await page.waitForFunction(previous => document.querySelector('dd').textContent !== previous, duration)
    await page.screenshot({ path: `${output}/live-growing.png`, fullPage: true })
    const rowDuration = await page.locator('[data-span-id="tool"] .fw-duration').innerText()
    await page.waitForFunction(previous => document.querySelector('[data-span-id="tool"] .fw-duration').textContent !== previous, rowDuration)
    await story('discovery-streaming-replay')
    await page.waitForFunction(() => document.querySelectorAll('[data-span-id]').length > 5)
    const count = await page.locator('[data-span-id]').count()
    await page.waitForFunction(previous => document.querySelectorAll('[data-span-id]').length > previous, count)
    checks.streaming = 'PASS'
    await story('empty-flow-trace')
    await page.getByRole('status').filter({ hasText: 'No spans yet' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).isDisabled(), true)
    assert.deepEqual(failures, [])
  }
  writeFileSync(`${output}/checks.json`, JSON.stringify({ checks, passed: Object.keys(checks).length, target: 9 }, null, 2))
  console.log(JSON.stringify({ checks, passed: Object.keys(checks).length, target: 9, output }))
} finally {
  await context?.close()
  await browser?.close()
  if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM') } catch {} }
  log.end()
}
