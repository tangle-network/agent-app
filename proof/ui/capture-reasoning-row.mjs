// Records the shared reasoning row streaming in its `Chat/ReasoningRow` Live
// turn story: the reasoning types into the open row under a running "Thinking"
// timer, the row collapses to "Thought for N seconds" when the answer starts,
// and a click opens it again. Asserts each step and writes a video, three
// screenshots and a JSON record of when each step happened.
//
//   node proof/ui/capture-reasoning-row.mjs <storybook-origin> <output-dir>
import assert from 'node:assert/strict'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const [origin, outputArg] = process.argv.slice(2)
if (!origin || !outputArg) throw new Error('Usage: capture-reasoning-row.mjs <storybook-origin> <output-dir>')
const output = resolve(outputArg)
mkdirSync(output, { recursive: true })
const url = (story, theme) => `${origin}/iframe.html?id=${story}&viewMode=story&globals=agentTheme:${theme}`

const browser = await chromium.launch({ headless: true })
const viewport = { width: 1100, height: 640 }
const steps = []
const consoleLines = []
let page
try {
  const context = await browser.newContext({ viewport, colorScheme: 'dark', recordVideo: { dir: output, size: viewport } })
  page = await context.newPage()
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`.slice(0, 400)))
  page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`.slice(0, 400)))
  const startedAt = Date.now()
  const step = (name, detail = {}) => steps.push({ name, atMs: Date.now() - startedAt, ...detail })

  await page.goto(url('chat-reasoningrow--live-turn', 'agent-dark'), { waitUntil: 'networkidle' })
  const thinking = page.getByRole('button', { name: /^Thinking/ })
  await thinking.waitFor()
  assert.equal(await thinking.getAttribute('aria-expanded'), 'true', 'the row is open while the model thinks')
  const live = page.locator('[data-reasoning="thinking"]')
  const firstChars = (await live.textContent()).length
  const firstLabel = (await thinking.textContent()).trim()
  step('thinking', { label: firstLabel, chars: firstChars, html: (await live.innerHTML()).slice(0, 400) })

  await page.waitForTimeout(2_500)
  const laterChars = (await live.textContent()).length
  const laterLabel = (await thinking.textContent()).trim()
  assert.ok(laterChars > firstChars, `reasoning text grows while thinking (${firstChars} → ${laterChars})`)
  assert.match(laterLabel, /^Thinking · \d+s/, `the timer is running: ${laterLabel}`)
  assert.notEqual(laterLabel, firstLabel, 'the elapsed seconds advance')
  step('streaming', { label: laterLabel, chars: laterChars })
  await page.screenshot({ path: `${output}/reasoning-row-thinking.png` })

  const settled = page.getByRole('button', { name: /^Thought for \d+ seconds?/ })
  await settled.waitFor({ timeout: 20_000 })
  assert.equal(await settled.getAttribute('aria-expanded'), 'false', 'the row collapses when the answer starts')
  await page.getByText('Four rooms are ready tonight', { exact: false }).waitFor()
  step('collapsed', { label: (await settled.textContent()).trim() })
  await page.waitForTimeout(1_200)
  await page.screenshot({ path: `${output}/reasoning-row-collapsed.png` })

  await settled.click()
  assert.equal(await settled.getAttribute('aria-expanded'), 'true', 'a click opens the settled row')
  const region = page.locator('[data-reasoning="settled"]')
  assert.match(await region.textContent(), /Four rooms passed inspection/, 'the whole reasoning is kept')
  step('expanded')
  await page.waitForTimeout(1_500)
  await page.screenshot({ path: `${output}/reasoning-row-expanded.png` })

  const video = page.video()
  await context.close()
  renameSync(await video.path(), `${output}/reasoning-row-live.webm`)

  // The saved turn in the light theme: collapsed, with its duration.
  const light = await browser.newContext({ viewport: { width: 1100, height: 320 }, colorScheme: 'light' })
  const savedPage = await light.newPage()
  await savedPage.goto(url('chat-reasoningrow--saved', 'agent-light'), { waitUntil: 'networkidle' })
  await savedPage.getByRole('button', { name: /^Thought for 7 seconds/ }).waitFor()
  await savedPage.screenshot({ path: `${output}/reasoning-row-saved-light.png` })
  step('saved-light')
  await light.close()
} catch (error) {
  // Keep what the page showed when a step failed, so the failure can be read without rerunning.
  const region = page ? await page.locator('[data-run-row]').first().evaluate((el) => el.outerHTML.slice(0, 3000)).catch(() => null) : null
  if (page) await page.screenshot({ path: `${output}/reasoning-row-failure.png` }).catch(() => {})
  steps.push({ name: 'failed', error: String(error?.message ?? error), region, console: consoleLines.slice(-30) })
  process.exitCode = 1
} finally {
  await browser.close()
  writeFileSync(`${output}/reasoning-row-steps.json`, `${JSON.stringify({ origin, steps }, null, 2)}\n`)
}
