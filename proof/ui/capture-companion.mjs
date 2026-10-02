import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
const [origin, out] = process.argv.slice(2)
if (!origin || !out) throw new Error('Usage: capture-companion.mjs <compiled-storybook-origin> <output-directory>')
const output = resolve(out)
mkdirSync(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const records = []
const url = (theme) => `${origin}/iframe.html?id=workspace-companion--collapsed&viewMode=story&globals=agentTheme:${theme}`
try {
  for (const theme of ['agent-dark', 'agent-light']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme.endsWith('dark') ? 'dark' : 'light', recordVideo: theme === 'agent-dark' ? { dir: output, size: { width: 1280, height: 900 } } : undefined })
    await context.addInitScript(() => {
      if (!sessionStorage.getItem('companion-proof-initialized')) {
        localStorage.clear()
        sessionStorage.setItem('companion-proof-initialized', 'true')
      }
    })
    const page = await context.newPage()
    const video = page.video()
    await page.goto(url(theme), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Open right panel' }).waitFor()
    await page.screenshot({ path: `${output}/after-companion-collapsed-${theme}.png` })
    await page.getByRole('button', { name: 'Open right panel' }).click()
    await page.getByRole('tab', { name: 'Files', exact: true }).waitFor()
    await page.screenshot({ path: `${output}/after-companion-file-tree-${theme}.png` })
    await page.getByRole('treeitem', { name: 'developer-invitation.md', exact: true }).click()
    await page.getByRole('heading', { name: 'developer-invitation.md', exact: true }).waitFor()
    await page.screenshot({ path: `${output}/after-companion-file-viewer-${theme}.png` })
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click()
    const terminal = page.getByRole('textbox', { name: 'Terminal fixture' })
    await terminal.pressSequentially('retained fixture input — no shell connected', { delay: 40 })
    await page.getByRole('tab', { name: 'Preview', exact: true }).click()
    await page.getByRole('heading', { name: 'Developer invitation', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Terminal', exact: true }).click()
    assert.equal(await terminal.inputValue(), 'retained fixture input — no shell connected')
    await page.getByRole('button', { name: 'Collapse right panel' }).click()
    await page.getByRole('button', { name: 'Open right panel' }).click()
    assert.equal(await terminal.inputValue(), 'retained fixture input — no shell connected')
    await page.screenshot({ path: `${output}/after-companion-terminal-retained-${theme}.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('dialog').waitFor()
    assert.equal(await terminal.inputValue(), 'retained fixture input — no shell connected')
    await page.screenshot({ path: `${output}/after-companion-phone-retained-${theme}.png` })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await terminal.inputValue(), 'retained fixture input — no shell connected')
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Open right panel' }).click()
    assert.equal(await page.getByRole('tab', { name: 'Terminal', exact: true }).getAttribute('aria-selected'), 'true')
    await page.screenshot({ path: `${output}/after-companion-restored-selection-${theme}.png` })
    await context.close()
    if (video) renameSync(await video.path(), `${output}/companion-interaction-original.webm`)
    records.push({ theme, osColorScheme: theme.endsWith('dark') ? 'dark' : 'light', actions: 'open tools; open actual file tree row; view document; type terminal fixture; switch tabs; close/reopen; desktop→phone→desktop; reload and reopen', outcome: 'terminal fixture input retained across tab/pane/viewport transitions; selected tab restored after reload', backend: 'local documents and terminal textarea fixture; no shell connection or file upload' })
  }
  for (const [theme, osColorScheme, expected] of [['agent-dark', 'light', 'dark'], ['agent-light', 'dark', 'light']]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: osColorScheme })
    await context.addInitScript(() => localStorage.clear())
    const page = await context.newPage()
    await page.goto(url(theme), { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Open right panel' }).click()
    await page.getByRole('treeitem', { name: 'developer-invitation.md', exact: true }).waitFor()
    const scheme = await page.locator('file-tree-container').evaluate(el => ({ root: getComputedStyle(document.documentElement).colorScheme, host: getComputedStyle(el).colorScheme, background: getComputedStyle(el).backgroundColor }))
    assert.equal(scheme.root, expected)
    assert.equal(scheme.host, expected)
    await page.screenshot({ path: `${output}/after-companion-os-${osColorScheme}-app-${expected}.png` })
    records.push({ theme, osColorScheme, observedScheme: scheme, outcome: 'File tree follows app selection independently of operating-system preference' })
    await context.close()
  }
} finally {
  await browser.close()
  writeFileSync(`${output}/companion-receipt.json`, JSON.stringify({ origin, target: 'compiled source Storybook on GTR', records }, null, 2))
}
