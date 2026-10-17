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
import { TeamPanelsDemo } from './src/stories/settings/team-panels-demo.tsx'
const params = new URLSearchParams(location.search)
const viewer = params.get('viewer') === 'admin' ? 'admin' : 'owner'
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
document.documentElement.dataset.theme = theme
document.documentElement.classList.add(theme)
const backend = createSettingsBackend({ viewer })
window.__settings = backend
createRoot(document.getElementById('root')).render(params.get('view') === 'team-panels'
  ? <TeamPanelsDemo />
  : <SettingsDemo backend={backend} viewer={viewer} initialSection={params.get('section') ?? 'general'} />)`

// The demo imports the package's source paths; the proof runs the built package.
const distPackage = {
  name: 'dist-package',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/\.\.\/(settings-react|teams-react|web-react\/async)$/ }, (args) => ({
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
  try {
    await run()
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
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

      // A hand-edited #hash that does not decode leaves the page up.
      await open('section=general#%E0%A4%A')
      await check(`${tag}: a malformed #hash leaves the page up`, async () => {
        await page.waitForTimeout(300)
        assert.deepEqual(browserErrors.filter((entry) => entry.startsWith(`${tag}:`)), [])
        await expect(project).toBeVisible()
      })

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
      // The trailing space is one the server trims, as GTM's does.
      await page.evaluate(() => window.__settings.control.holdNext())
      await page.locator('#project-name').fill('Fieldnote GTM EU ')
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
      await check(`${tag}: a name the server trims shows as kept, and a second blur sends nothing`, async () => {
        await expect(page.locator('#project-name')).toHaveValue('Fieldnote GTM EU')
        await expect(project.locator('[data-setting-status="unsaved"]')).toHaveCount(0)
        const writes = await page.evaluate(() => window.__settings.writes.length)
        await page.locator('#project-name').focus()
        await page.locator('#project-name').press('Tab')
        await page.waitForTimeout(300)
        assert.equal(await page.evaluate(() => window.__settings.writes.length), writes, 'the second blur sent the name again')
      })

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

      // Two changes while the first write is held: the server ends on the second, as the switch does.
      const charts = page.locator('#charts')
      const chartsStatus = page.locator('#defaults [data-setting-status]')
      await page.evaluate(() => window.__settings.control.holdNext())
      await charts.click()
      await charts.click()
      await check(`${tag}: a change made while a write is held is the value the server keeps`, async () => {
        await expect(page.locator('#defaults [data-setting-status="saving"]')).toBeVisible()
        await page.evaluate(() => window.__settings.control.release())
        await expect(page.locator('#defaults [data-setting-status="saving"]')).toHaveCount(0)
        const held = await page.evaluate(async () => (await (await window.__settings.fetch('/api/workspace')).json()).charts)
        const shown = await charts.getAttribute('aria-checked')
        assert.equal(String(held), shown, `the server holds charts=${held} while the switch shows ${shown}`)
        assert.equal(shown, 'true')
        await expect(chartsStatus).toHaveAttribute('data-setting-status', 'saved')
      })

      await page.locator('#daily-run').click()
      const billed = phone ? page.getByRole('dialog') : page.getByRole('alertdialog')
      await check(`${tag}: turning on billed compute asks first, opens on Cancel and saves only on confirm`, async () => {
        await expect(billed).toContainText('billed sandbox compute')
        await expect(billed.getByRole('button', { name: 'Cancel' })).toBeFocused()
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
      await check(`${tag}: raising a cap confirms the change from $50 to $1,500 and opens on Cancel`, async () => {
        await expect(raise).toContainText('$50')
        await expect(raise).toContainText('$1,500')
        await expect(raise.getByRole('button', { name: 'Cancel' })).toBeFocused()
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
      await members.getByRole('button', { name: /^More actions.*Sam Okafor/ }).click()
      await page.getByRole('menuitem', { name: /^Remove from/ }).click()
      const remove = phone ? page.getByRole('dialog') : page.getByRole('alertdialog')
      await check(`${tag}: Remove opens on Cancel, so Enter keeps the member`, async () => {
        await expect(remove).toContainText('Remove Sam Okafor?')
        await expect(remove.getByRole('button', { name: 'Cancel' })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(remove).toHaveCount(0)
        await expect(members.getByRole('combobox', { name: 'Role for Sam Okafor' })).toBeVisible()
      })
      await page.locator('#invitations').scrollIntoViewIfNeeded()
      await shot('invitations')

      // A seat-limit refusal stays in the invite dialog with its sentence and View plans.
      await members.getByRole('button', { name: 'Invite', exact: true }).click()
      const invite = phone ? page.getByRole('dialog') : page.getByRole('alertdialog')
      await invite.getByLabel('Email').fill('new@seats.example')
      await invite.locator('[data-confirm-action]').click()
      await check(`${tag}: a seat-limit refusal on Invite stays in the dialog with View plans`, async () => {
        await expect(invite.getByRole('alert')).toContainText('All 5 seats on your plan are in use.')
        await expect(invite.getByRole('alert').getByRole('link', { name: 'View plans' })).toHaveAttribute('href', '#plans')
        await expect(invite.getByLabel('Email')).toHaveValue('new@seats.example')
      })
      await shot('invite-plan-limit')
      await invite.getByRole('button', { name: 'Cancel' }).click()
      await expect(invite).toHaveCount(0)

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

      // The teams-react panels Tax, Legal and GTM render today stay inside their cards.
      await page.goto(`${origin}/?theme=${theme}&view=team-panels`)
      const memberCard = page.locator('[data-team-panel="members"]')
      await expect(memberCard.getByRole('button', { name: 'Remove Amir Chen' })).toBeVisible()
      await check(`${tag}: the team panels keep every control inside their card${phone ? ', each role picker full width under its name' : ''}`, async () => {
        const overflow = await page.evaluate(() => {
          const hits = []
          for (const card of document.querySelectorAll('[data-team-panel]')) {
            const edge = card.getBoundingClientRect()
            for (const control of card.querySelectorAll('button, [role="combobox"], input')) {
              const box = control.getBoundingClientRect()
              if (box.right > edge.right + 0.5) hits.push(`${control.getAttribute('aria-label') || control.textContent.trim()} ends at ${Math.round(box.right)}, past the card's ${Math.round(edge.right)}`)
            }
          }
          return hits
        })
        assert.deepEqual(overflow, [])
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the page scrolls sideways')
        assert.deepEqual(await tinyText(page), [])
        const select = await memberCard.getByRole('combobox', { name: 'Role for Amir Chen' }).boundingBox()
        const name = await memberCard.getByText('Amir Chen', { exact: true }).boundingBox()
        const remove = await memberCard.getByRole('button', { name: 'Remove Amir Chen' }).boundingBox()
        if (!phone) {
          assert.ok(Math.abs(select.y + select.height / 2 - (remove.y + remove.height / 2)) <= 2, 'the role picker and Remove share the row')
          return
        }
        const card = await memberCard.boundingBox()
        assert.ok(select.y > name.y + name.height - 1, 'the role picker sits under the name')
        assert.ok(select.width >= card.width - 2 * 16 - 2, `the role picker is ${select.width}px of a ${card.width}px card`)
        assert.ok(remove.y < select.y, 'Remove stays on the name line')
        const clipped = await memberCard.getByRole('combobox', { name: 'Role for Amir Chen' }).evaluate((trigger) => {
          const value = trigger.querySelector('span')
          return value.scrollWidth > value.clientWidth + 1
        })
        assert.equal(clipped, false, '"Can manage settings and people" is cut off')
        const inviteRole = await page.getByRole('combobox', { name: 'Invite role' }).first().boundingBox()
        const email = await page.getByLabel('Invite member').boundingBox()
        assert.ok(inviteRole.y > email.y + email.height - 1 && inviteRole.width >= card.width - 2 * 16 - 2, 'the invite role sits under the address at full width')
      })
      await shot('team-panels')
      await page.locator('[data-team-panel="invitations"]').scrollIntoViewIfNeeded()
      await shot('team-panels-invitations')
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
