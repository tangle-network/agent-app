import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, it } from 'vitest'
import { createTestHarness } from 'wrangler'

/** A preflight probe's default fetch in real workerd, which refuses a fetch called as another object's method. */
const server = createServer((_request, response) => { response.writeHead(200).end() })
let worker: ReturnType<typeof createTestHarness>
let base = ''
let origin = ''
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  worker = createTestHarness({ workers: [{ configPath: fileURLToPath(new URL('./workers/preflight.wrangler.toml', import.meta.url)) }] })
  base = (await worker.listen()).url.toString()
}, 120_000)
afterAll(async () => {
  await (worker as { dispose?(): Promise<void> } | undefined)?.dispose?.()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

it('reaches a live endpoint with the default fetch inside workerd', async () => {
  const report = await (await fetch(new URL(`/?target=${encodeURIComponent(`${origin}/health`)}`, base))).json() as
    { ok: boolean; probes: Array<{ detail?: string }> }
  assert.equal(report.ok, true, report.probes[0]?.detail)
}, 60_000)
