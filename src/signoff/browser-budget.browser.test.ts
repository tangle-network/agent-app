import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRequestMeter, meterPage, QUIET_CHROMIUM_ARGS } from './browser-budget'

// Real Chromium against a local server: the meter must count what reaches the
// network, not what the browser served from its cache. Skipped where no
// Chromium is installed (`pnpm exec playwright install chromium`).
const hasChromium = existsSync(chromium.executablePath())

const page = (title: string) =>
  `<!doctype html><title>${title}</title><link rel="stylesheet" href="/assets/app-1a2b.css"><script src="/assets/app-1a2b.js"></script><h1>${title}</h1>`

describe.skipIf(!hasChromium)('meterPage in Chromium', () => {
  let server: Server
  let base = ''
  const served: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      served.push(req.url ?? '')
      if (req.url?.startsWith('/assets/')) {
        res.writeHead(200, {
          'content-type': req.url.endsWith('.css') ? 'text/css' : 'text/javascript',
          'cache-control': 'public, max-age=31536000, immutable',
        })
        res.end(req.url.endsWith('.css') ? 'h1{color:#123}' : 'void 0')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' })
      res.end(page(req.url ?? '/'))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
  })

  it('counts cached immutable assets once, as the server sees them', async () => {
    const browser = await chromium.launch({ args: [...QUIET_CHROMIUM_ARGS] })
    try {
      const context = await browser.newContext()
      const tab = await context.newPage()
      const meter = createRequestMeter()
      let requestEvents = 0
      context.on('request', () => (requestEvents += 1))
      await meterPage(tab, meter)
      for (const route of ['/one', '/two', '/three']) {
        await tab.goto(`${base}${route}`, { waitUntil: 'load' })
      }
      const toServer = served.filter((url) => url !== '/favicon.ico').length
      // 3 documents + 2 assets reach the server; routes 2 and 3 take the assets from cache.
      expect(toServer).toBe(5)
      expect(meter.count().requests).toBe(toServer)
      // Playwright's request event also fires for the 4 cache hits: the 0.60.148 overcount.
      expect(requestEvents).toBeGreaterThan(toServer)
    } finally {
      await browser.close()
    }
  })
})
