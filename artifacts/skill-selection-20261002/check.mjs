import { chromium } from 'playwright'
import fs from 'node:fs/promises'

const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://127.0.0.1:6011/iframe.html?id=chatcontrols-chatcomposerslash--skills-with-file-mentions&viewMode=story', { waitUntil: 'networkidle' })
    const editor = page.locator('[contenteditable="true"]')
    await editor.waitFor()
    await editor.click()
    await editor.pressSequentially('/skill', { delay: 50 })
    await page.getByRole('option', { name: /draft plan/i }).waitFor()
    const menu = page.getByRole('listbox')
    const menuBox = await menu.boundingBox()
    const menuVisible = Boolean(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width && menuBox.y >= 0 && menuBox.y + menuBox.height <= 850)
    await page.screenshot({ path: `artifacts/skill-selection-20261002/menu-${width}.png`, fullPage: true })
    await editor.press('Enter')
    await page.getByText('Skill: Draft plan').waitFor()
    await editor.pressSequentially('@app', { delay: 50 })
    await page.getByRole('option', { name: /app.tsx/i }).click()
    await page.screenshot({ path: `artifacts/skill-selection-20261002/selected-file-${width}.png`, fullPage: true })
    const mention = await editor.textContent()
    const selected = await page.getByText('Skill: Draft plan').count()
    await page.getByRole('button', { name: 'Send' }).click()
    const result = await page.getByTestId('skill-send-result').textContent()
    results.push({ width, menuVisible, menuBox, mention, selected, result, errors, horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) })
    await page.close()
  }
} finally {
  await browser.close()
}
await fs.writeFile('artifacts/skill-selection-20261002/browser-proof.json', JSON.stringify(results, null, 2) + '\n')
for (const result of results) console.log(JSON.stringify(result))
if (results.some(({ menuVisible, selected, errors, horizontalOverflow, result }) => !menuVisible || selected !== 1 || errors.length || horizontalOverflow || !result?.includes('draft-plan'))) process.exitCode = 1
