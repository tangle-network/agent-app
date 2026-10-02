import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const [phase, origin, outputArg] = process.argv.slice(2)
if (!['before', 'after', 'interaction'].includes(phase) || !origin || !outputArg) throw new Error('Usage: capture-agent-app-ui.mjs <before|after|interaction> <storybook-origin> <output-dir>')
const output = resolve(outputArg)
mkdirSync(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const records = []
const viewports = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } }
const themes = ['agent-dark', 'agent-light']
const url = (story, theme) => `${origin}/iframe.html?id=${story}&viewMode=story&globals=agentTheme:${theme}`

async function capture(context, story, name, theme, waitText) {
  const page = await context.newPage()
  await page.addInitScript(() => { window.localStorage.clear() })
  await page.goto(url(story, theme), { waitUntil: 'networkidle' })
  await page.locator('.studio-composer-card').waitFor()
  if (phase === 'after') await page.getByRole('textbox', { name: 'Prompt' }).waitFor()
  if (waitText) await page.getByText(waitText, { exact: true }).waitFor()
  if (phase === 'after' && (await page.locator('.studio-composer-card').boundingBox()).width < 640) {
    const model = page.getByRole('button', { name: /^Model:/ }).first()
    if (await model.count()) {
      const modelBox = await model.boundingBox()
      const composerBox = await page.locator('.studio-composer-card').boundingBox()
      const generateBox = await page.getByRole('button', { name: 'Generate', exact: true }).boundingBox()
      assert.ok(modelBox.x >= composerBox.x && modelBox.x + modelBox.width <= composerBox.x + composerBox.width, 'Phone model trigger fits within its composer')
      assert.ok(modelBox.y >= generateBox.y + generateBox.height, 'Phone settings occupy their own row')
    }
  }
  await page.screenshot({ path: `${output}/${phase}-${name}.png`, fullPage: true })
  records.push({ story, name, theme, url: page.url(), viewport: page.viewportSize() })
  await page.close()
}
try {
  if (phase !== 'interaction') {
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      for (const theme of themes) {
        const context = await browser.newContext({ viewport, colorScheme: theme.endsWith('dark') ? 'dark' : 'light' })
        for (const [story, state] of [['studio-studiohomescreen--empty', 'home-empty'], ['studio-studiocomposer--empty-catalog', 'catalog-empty']]) {
          await capture(context, story, `${state}-${viewportName}-${theme}`, theme)
        }
        if (phase === 'after') {
          if (viewportName === 'desktop') await capture(context, 'studio-studiocomposer--narrow', `narrow-embedded-${theme}`, theme)
          await capture(context, 'studio-studiohomescreen--populated', `home-populated-${viewportName}-${theme}`, theme)
          for (const mode of ['image', 'video', 'audio']) await capture(context, `studio-studiocomposer--${mode}-lane`, `${mode}-${viewportName}-${theme}`, theme)
          for (const [story, state, text] of [['studio-studiocomposer--catalog-loading', 'loading', 'Loading media models…'], ['studio-studiocomposer--catalog-unavailable', 'error', 'Could not load media models'], ['studio-studiocomposer--provider-key-required', 'provider-key', 'Connect your provider key to generate images.']]) {
            await capture(context, story, `${state}-${viewportName}-${theme}`, theme, text)
          }
        }
        await context.close()
      }
    }
  } else {
    const context = await browser.newContext({ viewport: viewports.desktop, recordVideo: { dir: output, size: viewports.desktop } })
    const page = await context.newPage()
    const video = page.video()
    await page.goto(url('studio-studiocomposer--empty-catalog', 'agent-dark'))
    const prompt = page.getByRole('textbox', { name: 'Prompt' })
    await prompt.pressSequentially('A concise developer invitation with one practical first-session outcome.', { delay: 45 })
    await page.getByRole('button', { name: 'Refresh models' }).click()
    await page.getByRole('button', { name: 'Refresh models' }).waitFor()
    assert.equal(await prompt.inputValue(), 'A concise developer invitation with one practical first-session outcome.')
    assert.equal(await page.getByRole('button', { name: 'Generate', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: /^Model:/ }).count(), 0)
    await page.screenshot({ path: `${output}/studio-refresh-draft-retained.png` })
    await page.goto(url('studio-studiocomposer--reference-picker', 'agent-dark'))
    await page.getByRole('button', { name: /^Model:/ }).waitFor()
    await page.getByRole('textbox', { name: 'Prompt' }).pressSequentially('A slow orbit around our reference image.', { delay: 60 })
    await page.getByRole('button', { name: 'Add reference image' }).click()
    await page.getByRole('button', { name: 'Remove reference image' }).waitFor()
    assert.match(await page.getByRole('button', { name: /^Model:/ }).getAttribute('aria-label'), /image/)
    await page.screenshot({ path: `${output}/studio-reference-attached.png` })
    await page.getByRole('button', { name: 'Remove reference image' }).click()
    await page.getByRole('button', { name: 'Add reference image' }).waitFor()
    await page.getByRole('button', { name: 'Audio', exact: true }).click()
    await page.getByRole('textbox', { name: 'Prompt' }).waitFor()
    assert.match(await page.getByRole('textbox', { name: 'Prompt' }).getAttribute('placeholder'), /words to speak/)
    await page.screenshot({ path: `${output}/studio-mode-switched-audio.png` })
    await context.close()
    renameSync(await video.path(), `${output}/studio-interaction-original.webm`)
    records.push({ flow: 'empty catalog refresh preserves draft and prevents generation; reference picker fixture attaches/removes; audio mode changes prompt', backend: 'Storybook catalog/picker fixtures only; no generation or upload backend', video: 'studio-interaction-original.webm' })
  }
} finally {
  await browser.close()
  writeFileSync(`${output}/${phase}-receipt.json`, JSON.stringify({ phase, origin, target: 'compiled source Storybook; fixture account with no credentials', records }, null, 2))
}
