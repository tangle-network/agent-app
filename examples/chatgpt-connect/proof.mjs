import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const output = resolve(process.argv[2] ?? '/tmp/chatgpt-connect-proof')
const base = process.env.CONNECT_URL ?? 'http://127.0.0.1:4401'
mkdirSync(output, { recursive: true })
const browser = await chromium.launch()
const results = []
try {
  for (const app of ['gtm', 'creative']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    const label = `${app}-${theme}-${width}`
    const video = (app === 'gtm' && theme === 'dark' && width === 1440) || (app === 'creative' && theme === 'light' && width === 390)
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'], ...(video ? { recordVideo: { dir: output } } : {}) })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/?app=${app}&theme=${theme}`)
    await page.getByRole('heading', { name: 'Your agent, in ChatGPT' }).waitFor()
    assert.equal(await page.getByRole('status').textContent(), 'Ready to connect')
    if (video) await page.screenshot({ path: `${output}/${label}-initial.png`, fullPage: true })
    await page.keyboard.press('Tab')
    const primary = page.getByRole('button', { name: 'Connect to ChatGPT', exact: true })
    // BrandHeader has no navigation by default; the primary action is the first interactive control.
    assert.equal(await primary.evaluate(node => node === document.activeElement), true)
    const outline = await primary.evaluate(node => getComputedStyle(node).outlineWidth)
    assert.ok(parseFloat(outline) >= 2, outline)
    await page.keyboard.press('Enter')
    assert.equal(await primary.getAttribute('aria-expanded'), 'true')
    const details = page.getByText('Connection details', { exact: true })
    await details.press('Enter')
    assert.equal(await details.evaluate(node => node.parentElement.open), true)
    assert.equal(await page.getByRole('definition').count(), 2)
    if (app === 'gtm' && theme === 'dark' && width === 1440) await page.screenshot({ path: `${output}/connection-details.png`, fullPage: true })
    await details.press('Enter')
    assert.equal(await details.evaluate(node => node.parentElement.open), false)
    const expected = `https://${app}.example.com/api/agents/mcp`
    assert.equal(await page.getByLabel('MCP URL').inputValue(), expected)
    await page.getByRole('button', { name: 'Copy URL' }).click()
    await page.getByText('MCP URL copied', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected)
    assert.equal(await page.getByText('Connected to ChatGPT', { exact: true }).count(), 0)
    await page.screenshot({ path: `${output}/${label}-setup.png`, fullPage: true })
    await page.addScriptTag({ url: `${base}/axe.js` })
    const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })))
    assert.deepEqual(violations, [], `${label}: ${JSON.stringify(violations)}`)
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, background: getComputedStyle(document.querySelector('.tangle-chatgpt')).backgroundColor }))
    assert.ok(dimensions.scrollWidth <= dimensions.width + 1, JSON.stringify(dimensions))
    await page.getByRole('button', { name: 'Check connection', exact: true }).click()
    await page.getByText('Checking connection…', { exact: true }).waitFor()
    await page.getByText('Ready to connect', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-checks]').textContent(), '1')
    assert.deepEqual(errors, [])
    results.push({ app, theme, width, keyboard: true, clipboard: true, hostCallback: true, violations, errors, ...dimensions })
    const recording = page.video()
    await context.close()
    if (video) copyFileSync(await recording.path(), `${output}/${label}-original.webm`)
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  for (const state of ['checking', 'connected', 'error']) {
    await page.goto(`${base}/?app=creative&theme=dark&state=${state}`)
    await page.getByRole('heading', { name: 'Your agent, in ChatGPT' }).waitFor()
    await page.screenshot({ path: `${output}/creative-${state}.png`, fullPage: true })
    if (state === 'connected') assert.equal(await page.getByText('Connected to ChatGPT', { exact: true }).count(), 1)
    if (state === 'error') {
      assert.equal(await page.getByRole('alert').textContent(), 'The connection could not be checked. Try again.')
      await page.getByRole('button', { name: 'Check connection', exact: true }).click()
      await page.getByText('Ready to connect', { exact: true }).waitFor()
    }
  }
  await page.goto(`${base}/?app=gtm&registeredFixture=1`)
  assert.equal(await page.getByRole('link', { name: 'Connect to ChatGPT (opens a new tab)' }).getAttribute('href'), 'https://chatgpt.com/plugins')
  assert.equal(await page.getByText('Connected to ChatGPT', { exact: true }).count(), 0)
  await page.screenshot({ path: `${output}/registered-link-fixture.png`, fullPage: true })
  await context.close()
  assert.notEqual(results.find(r => r.theme === 'light').background, results.find(r => r.theme === 'dark').background)
  writeFileSync(`${output}/browser-proof.json`, JSON.stringify({ base, checkedAt: new Date().toISOString(),
    scope: 'Installed public exports, kit-generated display metadata, controlled host enrollment/state fixtures. No live ChatGPT connection or installation claim.',
    results, stateRecovery: true, registeredLink: 'Fixture ID with exact supplied official Plugins URL; no synthetic install URL.', originalVideos: 2 }, null, 2))
  console.log(JSON.stringify({ passed: results.length, screenshots: 15, axeViolations: 0, originalVideos: 2 }))
} finally { await browser.close() }
