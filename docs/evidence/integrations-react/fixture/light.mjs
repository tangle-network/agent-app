import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await page.goto('http://127.0.0.1:4175/after?integration=cloudbeds&connection=hotel-a', { waitUntil: 'networkidle' })
await page.getByText('Update a room').waitFor()
await page.evaluate(() => document.documentElement.classList.add('light'))
await page.screenshot({ path: '/tmp/agent-app1583-proof/media/after-detail-light-desktop.png', fullPage: true })
console.log(JSON.stringify({ theme: 'light', htmlClass: await page.evaluate(() => document.documentElement.className), detail: 'visible', overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) }))
await browser.close()
