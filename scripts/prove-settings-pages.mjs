/**
 * The built `settings-react` in Chromium: the settings page story's demo,
 * bundled against `dist/` (so the package's export map and shared chunks are
 * what runs), driven through every state of the settings contract at 1280 and
 * 390 wide in light and dark. Each check asserts what a person sees; each
 * state is saved as a screenshot.
 *
 *   node scripts/prove-settings-pages.mjs --output ~/reviews/settings-redesign/agent-app
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from 'playwright/test'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = process.argv.indexOf('--output')
const output = path.resolve(argument < 0 ? path.join(os.homedir(), 'reviews', 'settings-redesign', 'agent-app') : process.argv[argument + 1])
await mkdir(output, { recursive: true })
const temp = await mkdtemp(path.join(os.tmpdir(), 'settings-pages-'))
const checks = []
const browserErrors = []
const shots = []

const app = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsDemo } from './src/stories/settings/settings-demo.tsx'
import { createSettingsBackend } from './src/stories/settings/settings-backend.ts'
const params = new URLSearchParams(location.search)
const viewer = params.get('viewer') === 'admin' ? 'admin' : 'owner'
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = theme
document.documentElement.classList.add(theme)
const backend = createSettingsBackend({ viewer })
window.__settings = backend
createRoot(document.getElementById('root')).render(<SettingsDemo backend={backend} viewer={viewer} initialSection={params.get('section') ?? 'general'} />)`

// The demo imports the package's source paths; the proof runs the built package.
const distPackage = {
  name: 'dist-package',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\/(settings-react|web-react\/async)$/ }, (args) => ({
      path: path.join(root, 'dist', args.path.slice('../../'.length), 'index.js'),
    }))
  },
}

const require = createRequire(import.meta.url)
const { build } = await import(createRequire(require.resolve('tsup')).resolve('esbuild'))
await build({
  stdin: { contents: app, loader: 'tsx', resolveDir: root },
  outfile: path.join(temp, 'app.js'), absWorkingDir: root, bundle: true, platform: 'browser', format: 'esm',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [distPackage], logLevel: 'warning',
})
const config = path.join(temp, 'tailwind.mjs')
await writeFile(config, `import preset from ${JSON.stringify(path.join(root, 'dist/theme/tailwind-preset.js'))};export default {presets:[preset]}`)
const css = await postcss([tailwind({ base: root })]).process(
  `@import "tailwindcss";\n@import "./dist/theme/tailwind.css";\n@source "./src/stories/settings";\n@config ${JSON.stringify(config)};`,
  { from: path.join(root, 'proof.css') },
)
await writeFile(path.join(temp, 'app.css'), css.css)

const server = createServer(async (request, response) => {
  const asset = request.url === '/app.js' ? ['app.js', 'text/javascript'] : request.url === '/app.css' ? ['app.css', 'text/css'] : null
  if (asset) {
    response.writeHead(200, { 'content-type': asset[1] })
    return response.end(await readFile(path.join(temp, asset[0])))
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>Settings pages proof</title><body class="bg-background text-foreground"><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`

async function check(name, run) {
  await run()
  checks.push({ name, result: 'PASS' })
}

/** Text under 14px anywhere visible on the page. */
async function tinyText(page) {
  return page.evaluate(() => {
    const hits = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue
      const element = node.parentElement
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      if (style.visibility === 'hidden' || rect.width === 0 || element.closest('[aria-hidden="true"], .sr-only')) continue
      if (parseFloat(style.fontSize) < 14) hits.push(`${parseFloat(style.fontSize)}px "${node.textContent.trim().slice(0, 40)}"`)
    }
    return hits
  })
}

const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      const phone = width === 390
      const tag = `${width}-${theme}`
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 },
        ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
        colorScheme: theme,
        ...(tag === '1280-dark' || tag === '390-light' ? { recordVideo: { dir: output, size: { width, height: phone ? 844 : 900 } } } : {}),
      })
      const page = await context.newPage()
      page.on('pageerror', (error) => browserErrors.push(`${tag}: ${error.message}`))
      const shot = async (name) => {
        const file = `${name}-${tag}.png`
        await page.waitForTimeout(150)
        await page.screenshot({ path: path.join(output, file) })
        shots.push(file)
      }
      const open = async (query) => {
        await page.goto(`${origin}/?theme=${theme}&${query}`)
        await expect(page.getByRole('heading', { name: 'Project settings', level: 1 })).toBeVisible()
      }
      const nav = page.getByRole('navigation', { name: 'Settings sections' })
      const project = page.locator('#project')

      await open('section=general')
      await check(`${tag}: the section nav is a ${phone ? '56px tab strip' : 'sticky column'} at this width`, async () => {
        const box = await nav.boundingBox()
        if (phone) assert.ok(Math.abs(box.height - 56) <= 1, `strip is ${box.height}px tall`)
        else assert.ok(box.height > 150 && box.width <= 13 * 16 + 1, `column is ${box.width}x${box.height}`)
      })
      await check(`${tag}: no text under 14px and no sideways page scroll`, async () => {
        assert.deepEqual(await tinyText(page), [])
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page scrolls sideways')
      })
      await shot('general')

      // Autosave on blur: "Saving…" only while the write is held, "Saved" only after it lands.
      await page.evaluate(() => window.__settings.control.holdNext())
      await page.locator('#project-name').fill('Fieldnote GTM EU')
      await page.locator('#project-name').press('Tab')
      await check(`${tag}: a held write shows Saving… after the pending delay and never Saved`, async () => {
        await expect(project.locator('[data-setting-status="saving"]')).toBeVisible()
        await expect(project.locator('[data-setting-status="saved"]')).toHaveCount(0)
      })
      await project.scrollIntoViewIfNeeded()
      await shot('saving')
      await page.evaluate(() => window.__settings.control.release())
      await check(`${tag}: the confirmed write shows Saved and the header shows the new name`, async () => {
        await expect(project.locator('[data-setting-status="saved"]')).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Project settings' }).locator('..')).toContainText('Fieldnote GTM EU')
      })
      await shot('saved')

      // A typed refusal keeps the person's value, names the problem and offers Retry.
      await page.locator('#project-name').fill('Acme')
      await page.locator('#project-name').press('Enter')
      await check(`${tag}: a refused write shows the server's sentence, keeps the value and offers Retry`, async () => {
        await expect(project.getByRole('alert')).toContainText('Another project in this team is already called Acme')
        await expect(page.locator('#project-name')).toHaveValue('Acme')
        await expect(page.locator('#project-name')).toHaveAttribute('aria-invalid', 'true')
        await expect(project.getByRole('button', { name: 'Retry' })).toBeVisible()
      })
      await shot('failed')
      const writesBefore = await page.evaluate(() => window.__settings.writes.length)
      await page.locator('#project-name').fill('')
      await check(`${tag}: an empty name is flagged as it is typed and never sent`, async () => {
        await expect(project.getByRole('alert')).toHaveText('Enter a project name.')
        await page.locator('#project-name').press('Enter')
        assert.equal(await page.evaluate(() => window.__settings.writes.length), writesBefore)
      })
      await shot('invalid')
      await page.locator('#project-name').press('Escape')
      await expect(page.locator('#project-name')).toHaveValue('Fieldnote GTM EU')

      // The timezone picker: grouped by region, searchable by offset.
      await page.locator('#timezone').click()
      await page.getByLabel('Search timezones').fill('+5:30')
      await check(`${tag}: the timezone search matches by UTC offset`, async () => {
        await expect(page.locator('button[data-zone="Asia/Kolkata"]')).toBeVisible()
        await expect(page.locator('button[data-zone="America/New_York"]')).toHaveCount(0)
      })
      await shot('timezone')
      await page.locator('button[data-zone="Asia/Kolkata"]').click()
      await expect(page.locator('#timezone')).toContainText('Kolkata')
      await expect(page.locator('#project [data-setting-status="saved"]')).toBeVisible()

      // An export runs as rows: progress while it runs, then the download and its expiry.
      const exportCard = page.locator('#export')
      await exportCard.getByRole('button', { name: 'Export', exact: true }).click()
      await expect(exportCard).toContainText('Preparing your export')
      await exportCard.scrollIntoViewIfNeeded()
      await shot('exporting')
      await check(`${tag}: an export reaches a download link with its expiry`, async () => {
        await expect(exportCard).toContainText('Your export is ready', { timeout: 30_000 })
        await expect(exportCard.getByRole('link', { name: 'Download zip' })).toBeVisible()
        await expect(exportCard).toContainText('Link expires')
      })
      await exportCard.getByRole('button', { name: 'Show 7 sources' }).click()
      await shot('exported')

      // Delete asks for the name; the outline button at rest, the filled one in the dialog.
      await page.getByRole('button', { name: 'Delete project…' }).click()
      const dialog = phone ? page.getByRole('dialog') : page.getByRole('alertdialog')
      await expect(dialog).toBeVisible()
      await check(`${tag}: delete stays unavailable until the exact name is typed${phone ? ', in a bottom sheet' : ''}`, async () => {
        const confirm = dialog.locator('[data-confirm-action]')
        await expect(confirm).toBeDisabled()
        await dialog.getByLabel(/to confirm/).fill('Fieldnote')
        await expect(confirm).toBeDisabled()
        await dialog.getByLabel(/to confirm/).fill('Fieldnote GTM EU')
        await expect(confirm).toBeEnabled()
        if (phone) {
          const box = await dialog.boundingBox()
          assert.ok(box.y + box.height >= 843 && box.width >= 389, 'the sheet is anchored to the bottom edge at full width')
        }
      })
      await shot('confirm-delete')
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)

      // The nav answers at once: the clicked section is current before its route resolves.
      await nav.locator('a[data-settings-section="agent"]').click()
      await check(`${tag}: the clicked section is current before its route resolves`, async () => {
        await expect(nav.locator('a[data-settings-section="agent"]')).toHaveAttribute('aria-current', 'page', { timeout: 100 })
        await expect(page.locator('#defaults')).toBeVisible()
      })
      await page.locator('#daily-run').click()
      const billed = phone ? page.getByRole('dialog') : page.getByRole('alertdialog')
      await check(`${tag}: turning on billed compute asks first and saves only on confirm`, async () => {
        await expect(billed).toContainText('billed sandbox compute')
        await expect(page.locator('#daily-run')).toHaveAttribute('aria-checked', 'false')
      })
      await shot('confirm-billed')
      await billed.locator('[data-confirm-action]').click()
      await expect(billed).toHaveCount(0)
      await expect(page.locator('#daily-run')).toHaveAttribute('aria-checked', 'true')

      await nav.locator('a[data-settings-section="notifications"]').click()
      await expect(page.locator('#digest')).toBeVisible()
      await page.getByRole('button', { name: 'Send now' }).click()
      await expect(page.locator('#digest')).toContainText('Sent at')
      await page.getByRole('button', { name: 'Send now' }).click()
      await check(`${tag}: a rate-limited send says when to try again`, async () => {
        await expect(page.locator('#digest').getByRole('alert')).toContainText('Try again in 50 minutes')
      })
      await shot('notifications')

      // One grouped save: lowering would save at once; raising asks with from → to.
      await nav.locator('a[data-settings-section="limits"]').click()
      await page.locator('#cap-perDay').fill('1,500')
      const bar = page.locator('[data-settings-save-bar]')
      await check(`${tag}: the save bar counts the change and shows the old value`, async () => {
        await expect(bar).toContainText('1 unsaved change')
        await expect(page.locator('#spend-caps')).toContainText('Was $50')
      })
      await page.locator('#spend-caps').scrollIntoViewIfNeeded()
      await shot('save-bar')
      await bar.getByRole('button', { name: 'Save caps' }).click()
      const raise = phone ? page.getByRole('dialog') : page.getByRole('alertdialog')
      await check(`${tag}: raising a cap confirms the change from $50 to $1,500`, async () => {
        await expect(raise).toContainText('$50')
        await expect(raise).toContainText('$1,500')
      })
      await shot('confirm-raise')
      await raise.locator('[data-confirm-action]').click()
      await expect(bar).toContainText('Saved')

      await nav.locator('a[data-settings-section="team"]').click()
      const members = page.locator('#members')
      await expect(members).toBeVisible()
      await check(`${tag}: roles are named by capability${phone ? ', the picker full width under the name, the Team tab in view' : ''}`, async () => {
        await expect(members.getByRole('combobox', { name: 'Role for Ana Lima' })).toContainText('Can edit')
        if (!phone) return
        const select = await members.getByRole('combobox', { name: 'Role for Ana Lima' }).boundingBox()
        const name = await members.getByText('Ana Lima', { exact: true }).boundingBox()
        const card = await members.boundingBox()
        assert.ok(select.y > name.y + name.height - 1, 'the role picker sits under the name')
        assert.ok(select.width >= card.width - 2 * 16 - 2, `the role picker is ${select.width}px of a ${card.width}px card`)
        const clipped = await members.getByRole('combobox', { name: 'Role for Jonas Weber' }).evaluate((trigger) => {
          const value = trigger.querySelector('span')
          return value.scrollWidth > value.clientWidth + 1
        })
        assert.equal(clipped, false, '"Can manage settings and people" is cut off')
        const tab = await nav.locator('a[data-settings-section="team"]').boundingBox()
        const strip = await nav.boundingBox()
        assert.ok(tab.x >= strip.x && tab.x + tab.width <= strip.x + strip.width + 1, 'the current tab is inside the strip')
        for (const cue of await nav.locator('[data-scroll-cue]').all()) {
          const box = await cue.boundingBox()
          assert.ok(box.x + box.width <= tab.x || box.x >= tab.x + tab.width, 'a chevron covers the current tab')
        }
      })
      await check(`${tag}: no text under 14px on the team section`, async () => {
        assert.deepEqual(await tinyText(page), [])
      })
      await shot('team')
      await members.getByRole('combobox', { name: 'Role for Sam Okafor' }).click()
      await page.getByRole('option', { name: 'Can edit' }).click()
      await check(`${tag}: a role change saves at once and says so in its row`, async () => {
        await expect(members.locator('[data-setting-status="saved"]')).toBeVisible()
      })
      await page.locator('#invitations').scrollIntoViewIfNeeded()
      await shot('invitations')

      // What an admin cannot change is locked with the reason.
      await open('viewer=admin&section=limits')
      await check(`${tag}: an admin sees owner-only caps locked with the reason`, async () => {
        await expect(page.locator('#spend-caps')).toContainText('Only Priya, the owner, can change ad spend caps.')
        await expect(page.locator('#cap-perDay')).toBeDisabled()
      })
      await shot('locked-limits')
      await open('viewer=admin&section=general')
      await check(`${tag}: an admin sees export and delete locked with the reason`, async () => {
        await expect(page.locator('#export')).toContainText('Only Priya, the owner, can export everything.')
        await expect(page.locator('#delete')).toContainText('Only Priya, the owner, can delete this project.')
        await expect(page.getByRole('button', { name: 'Delete project…' })).toBeDisabled()
      })
      await page.locator('#export').scrollIntoViewIfNeeded()
      await shot('locked-general')
      await context.close()
    }
  }
} finally {
  await browser.close()
  server.close()
}

assert.deepEqual(browserErrors, [])
const report = { checks, shots, browserErrors, at: new Date().toISOString() }
await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`${checks.length} checks passed; ${shots.length} screenshots in ${output}`)
