/** Actual workerd → Sandbox SDK → local HTTP protocol. No model, fetch, SDK or storage method is substituted. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const consumerRoot = process.env.AGENT_APP_STOP_CONSUMER_ROOT
if (!consumerRoot) throw new Error('Set AGENT_APP_STOP_CONSUMER_ROOT to an installed consumer declaring Wrangler')
const consumer = createRequire(resolve(consumerRoot, 'package.json'))
const declared = consumer('./package.json') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
assert(declared.dependencies?.wrangler ?? declared.devDependencies?.wrangler, 'Consumer must declare Wrangler')
const wrangler = createRequire(consumer.resolve('wrangler/package.json'))
const lock = readFileSync(resolve(consumerRoot, 'pnpm-lock.yaml'), 'utf8')
const lockedVersion = lock.match(/^ {6}wrangler:\n {8}specifier:[^\n]*\n {8}version: ([^\s(]+)/m)?.[1]
const installedVersion = (wrangler('./package.json') as { version: string }).version
assert(lockedVersion === installedVersion, `Unsupported consumer Wrangler: installed ${installedVersion}, locked ${lockedVersion}`)
const production = readFileSync(resolve(consumerRoot, 'wrangler.toml'), 'utf8')
const compatibilityDate = production.match(/^compatibility_date\s*=\s*"([^"]+)"/m)?.[1]
const flags = production.match(/^compatibility_flags\s*=\s*\[([\s\S]*?)\]/m)?.[1]
assert(compatibilityDate && flags, 'Consumer must declare its production compatibility settings')
const compatibilityFlags = [...flags.matchAll(/"([^"]+)"/g)].map(match => match[1]!)
const { Miniflare, convertV4MiniflareOptions } = wrangler('miniflare') as {
  convertV4MiniflareOptions(value: Record<string, unknown>): Record<string, unknown>
  Miniflare: new (value: Record<string, unknown>) => { dispatchFetch(url: string): Promise<Response>; dispose(): Promise<void> }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000)
  })]) } finally { clearTimeout(timer) }
}
let setup = deferred(), setupRelease = deferred(), admission = deferred(), admissionRelease = deferred()
let mode = '', nativeRequests = 0, replayRequests = 0, admissionDisconnected = false, origin = ''
const unknown: string[] = []
const peer = createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => { void (async () => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    const sse = (events: Array<{ type: string; data: unknown }>) => response.writeHead(200, { 'content-type': 'text/event-stream' })
      .end(events.map((event, index) => `id: ${index + 1}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''))
    if (path === '/setup') { setup.resolve(); await setupRelease.promise; response.end('prepared'); return }
    if (path === '/v1/sandboxes/box-stop') return json({ id: 'box-stop', status: 'running',
      filesystemIncarnationId: 'stop-fixture-incarnation', filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
      connection: { runtimeUrl: `${origin}/v1/sandboxes/box-stop/runtime` } })
    const runtime = path.replace('/v1/sandboxes/box-stop/runtime', '')
    if (path === '/v1/backends') return json({ backends: [{ type: 'opencode', capabilities: { interactions: [] } }] })
    if (runtime === '/agents/sessions/session-stop') return json({ id: 'session-stop', status: 'queued', backendType: 'opencode' })
    if (runtime === '/messages/turns') { response.writeHead(204).end(); return }
    if (runtime === '/agents/run/stream' && request.method === 'POST') {
      nativeRequests++
      const payload = JSON.parse(body) as Record<string, unknown>
      assert.equal(payload.executionId ?? request.headers['x-execution-id'], `execution-${mode}`)
      if (mode === 'admission') {
        response.on('close', () => { if (!response.writableEnded) admissionDisconnected = true })
        admission.resolve(); await admissionRelease.promise
      }
      sse([{ type: 'execution.started', data: { executionId: `execution-${mode}`, sessionId: 'session-stop', runControlRef: payload.runControlRef } }])
      return
    }
    if (runtime === `/agents/run/execution-${mode}/events`) {
      replayRequests++
      sse([{ type: 'text', data: { text: 'Local fixture result.', executionId: `execution-${mode}` } },
        { type: 'result', data: { success: true, response: 'Local fixture result.', executionId: `execution-${mode}` } },
        { type: 'done', data: { status: 'completed', executionId: `execution-${mode}`, sessionId: 'session-stop' } }])
      return
    }
    unknown.push(`${request.method} ${path}`); json({ error: 'Unexpected local protocol request' }, 404)
  })().catch(error => { response.writeHead(500).end(String(error)) }) })
})
const directory = mkdtempSync(resolve(tmpdir(), 'agent-app-prompt-stop-'))
let runtime: InstanceType<typeof Miniflare> | undefined
let failed = false
try {
  const bundle = resolve(directory, 'bundle')
  const config = resolve(directory, 'wrangler.json')
  writeFileSync(config, JSON.stringify({ name: 'prompt-stop-fixture',
    main: fileURLToPath(new URL('./prompt-stop.worker.ts', import.meta.url)),
    compatibility_date: compatibilityDate, compatibility_flags: compatibilityFlags, send_metrics: false }))
  execFileSync(process.execPath, [consumer.resolve('wrangler'), 'deploy', '--dry-run', '--config', config, '--outdir', bundle], {
    cwd: directory, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 60_000, stdio: 'pipe' })
  await new Promise<void>((done, reject) => { peer.once('error', reject); peer.listen(0, '127.0.0.1', done) })
  origin = `http://127.0.0.1:${(peer.address() as { port: number }).port}`
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'prompt-stop-fixture', modules: true,
    compatibilityDate, compatibilityFlags, scriptPath: resolve(bundle, 'prompt-stop.worker.js'), modulesRoot: bundle, bindings: { PEER: origin } }] }))
  const checks: string[] = []
  for (const scenario of ['setup', 'profile', 'admission', 'normal']) {
    mode = scenario; nativeRequests = 0; replayRequests = 0; admissionDisconnected = false
    setup = deferred(); setupRelease = deferred(); admission = deferred(); admissionRelease = deferred()
    let ended = false
    const running = runtime.dispatchFetch(`http://fixture.test/run?mode=${mode}`).then(async response => {
      assert.equal(response.status, 200, await response.clone().text())
      return response.json() as Promise<{ error?: string; aborted: boolean; events: unknown[] }>
    }).finally(() => { ended = true })
    void running.catch(() => {})
    if (mode === 'setup' || mode === 'admission') {
      await bounded(mode === 'setup' ? setup.promise : admission.promise, `${mode} actual HTTP barrier`)
      const stopped = await runtime.dispatchFetch(`http://fixture.test/stop?mode=${mode}`)
      assert.equal(stopped.status, 200)
      assert.deepEqual(await stopped.json(), { requested: true })
      assert.equal(ended, false, 'An in-flight admission or setup must be awaited, not relabeled as an unsent dispatch')
      assert.equal(admissionDisconnected, false, 'Stop must not abort the native admission response before its outcome is known')
      if (mode === 'setup') setupRelease.resolve(); else admissionRelease.resolve()
    }
    const result = await bounded(running, `${mode} shared stream result`)
    assert.deepEqual(unknown, [], 'All SDK I/O must match the real local protocol')
    if (mode === 'normal') {
      assert.equal(result.error, undefined, JSON.stringify(result))
      assert.equal(result.aborted, false)
      assert.equal(nativeRequests, 1)
      assert.equal(replayRequests, 1)
      assert(result.events.length > 0)
    } else {
      assert.equal(nativeRequests, mode === 'admission' ? 1 : 0,
        'An aborted effective signal must prevent native admission after awaited setup')
      assert.equal(result.error, 'fixture_stop_requested')
      assert.equal(result.aborted, true)
      assert.deepEqual(result.events, [])
      assert.equal(replayRequests, 0)
    }
    checks.push(mode)
  }
  console.log(JSON.stringify({ checks, actualWorkerd: true, actualSandboxSDK: true, actualHTTP: true,
    compatibilityDate, compatibilityFlags, paidCalls: 0 }))
} catch (error) { failed = true; throw error }
finally {
  setupRelease.resolve(); admissionRelease.resolve()
  try { await bounded(runtime?.dispose() ?? Promise.resolve(), 'fixture shutdown') }
  catch (error) { if (!failed) throw error }
  finally {
    peer.closeAllConnections()
    await new Promise<void>(done => peer.close(() => done()))
    rmSync(directory, { recursive: true, force: true })
  }
}
