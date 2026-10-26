import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createProtectedRuntimeChatProducer, type ProtectedRuntimeChatOptions } from '../src/chat-routes/protected-runtime-producer'
import { createRouterProtectedModelPort, type RouterProtectedModelSettlement } from '../src/runtime/protected-model'

const model = 'openai/local-protected-model'
const digest = `sha256:${'a'.repeat(64)}` as const
const token = `sk-tgr-${'x'.repeat(48)}`
const hosts = new Set(['router.tangle.tools:443', 'candidate-router.tangle.tools:443'])
const barrier = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
type ProxySetup = (env: Record<string, string>) => () => void

/** The maintained Router port uses fixed HTTPS origins. Route only those origins
 * over actual local TLS/HTTP sockets; never replace fetch, the port or Runtime.
 * Both builtin APIs are supported by this repository's Node 24.18.0 pin. */
async function protectedHttpPeer(mode: 'failure' | 'tool' | 'held-tool', auditFails = false) {
  const directory = mkdtempSync(join(tmpdir(), 'protected-terminal-http-'))
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem')
  const oldCAs = getCACertificates('default')
  const sockets = new Set<Duplex>()
  const seen: string[] = [], settled: RouterProtectedModelSettlement[] = []
  const toolStarted = barrier(), releaseTool = barrier()
  let toolReleased = false, calls = 0
  let preparation: { preparationId: string; expiresAtMs: number; limits: Record<string, unknown> } | undefined
  let restoreProxy: (() => void) | undefined
  const errors: unknown[] = []
  const ledger: Array<RouterProtectedModelSettlement['calls'][number]> = []
  const tls = createHttpsServer()
  const proxy = http.createServer((_request, response) => response.writeHead(403).end())
  const track = (socket: Duplex) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
  const close = async () => {
    releaseTool.resolve()
    try { restoreProxy?.() } catch (error) { errors.push(error) }
    finally { restoreProxy = undefined }
    try { setDefaultCACertificates(oldCAs) } catch (error) { errors.push(error) }
    for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => tls.close(() => resolve())),
      new Promise<void>(resolve => proxy.close(() => resolve()))])
    rmSync(directory, { recursive: true, force: true })
    if (errors.length) throw new AggregateError(errors, 'Actual protected HTTP peer failed')
  }
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=protected-local.test', '-addext',
      'subjectAltName=DNS:router.tangle.tools,DNS:candidate-router.tangle.tools,IP:127.0.0.1',
      '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10_000 })
    tls.setSecureContext({ key: readFileSync(key), cert: readFileSync(cert) })
    tls.on('connection', track)
    tls.on('request', (request, response) => {
      response.on('error', error => { if (!['EPIPE', 'ECONNRESET'].includes(String((error as NodeJS.ErrnoException).code))) errors.push(error) })
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const bytes = Buffer.concat(chunks)
        const body = bytes.length ? JSON.parse((request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString()) : {}
        const path = request.url ?? ''
        seen.push(path)
        const json = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
        if (path === '/tool') {
          toolStarted.resolve()
          if (mode === 'held-tool') await releaseTool.promise
          toolReleased = true
          return json({ value: 'actual HTTP tool finished' })
        }
        if (path === '/audit') return json({ persisted: !auditFails }, auditFails ? 503 : 200)
        if (path.startsWith('/v1/candidate-model-grants/')) {
          if (request.headers.authorization !== 'Bearer protected-parent-fixture') return json({ error: 'unauthorized' }, 401)
          if (path.endsWith('/resolve')) return json({ requested: body.requested, model, snapshot: model, provider: 'openai', reasoningEffort: 'none' })
          if (path.endsWith('/reserve')) {
            preparation = body
            return json({ preparationId: body.preparationId, digest, expiresAtMs: body.expiresAtMs,
              enforcedLimits: body.limits, network: { mode: 'gateway-only', domains: ['candidate-router.tangle.tools'] } })
          }
          if (!preparation || body.preparationId !== preparation.preparationId) return json({ error: 'unknown grant' }, 409)
          if (path.endsWith('/activate')) return json({ env: {
            MODEL_GATEWAY_TOKEN: token, MODEL_GATEWAY_BASE_URL: 'https://candidate-router.tangle.tools/v1',
            OPENAI_API_KEY: token, OPENAI_BASE_URL: 'https://candidate-router.tangle.tools/v1',
            ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_BASE_URL: 'https://candidate-router.tangle.tools',
          } })
          if (path.endsWith('/settle')) {
            const receipt: RouterProtectedModelSettlement = { preparationId: body.preparationId, grantDigest: digest, closed: true,
              usageWithinLimits: true, calls: structuredClone(ledger) }
            settled.push(receipt)
            return json(receipt)
          }
        }
        if (path === '/v1/chat/completions') {
          if (request.headers.authorization !== `Bearer ${token}`) return json({ error: 'unauthorized' }, 401)
          calls++
          if (mode === 'failure') return json({ error: { code: 'router_unavailable', message: 'Local Router unavailable' } }, 503)
          const id = `observed-call-${calls}`
          ledger.push({ callId: id, generationId: id, traceSpanId: id, model, status: 'succeeded',
            startedAtMs: Date.now(), endedAtMs: Date.now() + 1, inputTokens: 3, accountedInputTokens: 3,
            outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, costUsdNanos: 1_000_000, costProvenance: 'observed' })
          const tool = calls === 1
          return json({ id, object: 'chat.completion', model, choices: [{ index: 0,
            message: { role: 'assistant', content: tool ? null : 'FINAL_AFTER_TOOL',
              ...(tool ? { tool_calls: [{ id: 'http-tool-1', type: 'function', function: { name: 'read', arguments: '{}' } }] } : {}) },
            finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
        }
        throw new Error('Unexpected protected HTTP peer path')
      })().catch(error => { errors.push(error); response.destroy() })
    })
    await new Promise<void>((resolve, reject) => { tls.once('error', reject); tls.listen(0, '127.0.0.1', resolve) })
    const port = (tls.address() as AddressInfo).port
    proxy.on('connect', (request, client, head) => {
      if (!hosts.has(request.url ?? '')) { errors.push(new Error('Unowned service authority')); client.destroy(); return }
      const upstream = connect(port, '127.0.0.1')
      track(client); track(upstream)
      const disconnect = () => { client.destroy(); upstream.destroy() }
      client.on('error', disconnect); upstream.on('error', disconnect)
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
    })
    await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    // Node's builtin fetch proxy support; not an undici dependency or fetch stub.
    const setupProxy = (http as typeof http & { setGlobalProxyFromEnv: ProxySetup }).setGlobalProxyFromEnv
    if (typeof setupProxy !== 'function') throw new Error('Use the maintained repository Node pin')
    setDefaultCACertificates([readFileSync(cert, 'utf8')])
    restoreProxy = setupProxy({ http_proxy: url, https_proxy: url, no_proxy: 'localhost,127.0.0.1' })
    return { origin: `https://127.0.0.1:${port}`, seen, settled, toolStarted: toolStarted.promise,
      releaseTool: () => releaseTool.resolve(), toolReleased: () => toolReleased, calls: () => calls, close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Protected HTTP setup and cleanup failed') }
    throw error
  }
}

function optionsFor(peer: Awaited<ReturnType<typeof protectedHttpPeer>>, signal?: AbortSignal): ProtectedRuntimeChatOptions {
  return {
    profile: { name: 'protected-http', harness: 'cli-base', prompt: { systemPrompt: 'Read the supplied local tool.' },
      model: { provider: 'tangle-router', default: model, reasoningEffort: 'none', maxVisibleOutputTokens: 100 } },
    prompt: 'Read the local fixture.', tools: [], maxToolCalls: 1, ...(signal ? { signal } : {}),
    grant: {
      port: createRouterProtectedModelPort({ apiKey: 'protected-parent-fixture', maxCostUsd: 1, ...(signal ? { signal } : {}),
        async onSettlement(receipt) {
          const response = await fetch(`${peer.origin}/audit`, { method: 'POST', body: JSON.stringify(receipt) })
          if (!response.ok) throw new Error('Actual audit HTTP refusal')
        } }),
      resolve: { requested: model, harness: 'cli-base', reasoningEffort: 'none' },
      reserve: { executionId: 'local-execution', preparationId: 'local-preparation', bundleDigest: digest,
        expiresAtMs: Date.now() + 30_000, attempt: { number: 1, maxAttempts: 1, retryPolicy: 'none' },
        limits: { maxModelCalls: 2, maxInputTokens: 1000, maxOutputTokens: 100, maxCostUsd: 1 } },
      deadlineAtMs: Date.now() + 20_000,
    },
  }
}

async function collect(producer: ReturnType<typeof createProtectedRuntimeChatProducer>) {
  const events = []
  for await (const event of producer.stream) events.push(event)
  return events
}

describe.sequential('protected local HTTP terminal ownership', () => {
  it('retains a real HTTP503 failure and reports terminal only after local execution drains', async () => {
    const peer = await protectedHttpPeer('failure')
    try {
      const producer = createProtectedRuntimeChatProducer(optionsFor(peer))
      expect(producer.terminalObserved?.()).toBe(false)
      const events = await collect(producer)
      expect(peer.calls()).toBe(1)
      expect(peer.settled).toHaveLength(1)
      expect(peer.settled[0]?.calls).toEqual([])
      expect(events.some(event => event.type === 'error')).toBe(true)
      expect(JSON.stringify(events)).toContain('The model service did not answer.')
      expect(JSON.stringify(events)).not.toContain('FINAL_AFTER_TOOL')
      expect(producer.usage?.()).toEqual({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 })
      expect(producer.terminalObserved?.()).toBe(true)
    } finally { await peer.close() }
  }, 15_000)

  it('keeps an actual HTTP tool and stream return pending after abort until the peer releases it', async () => {
    const peer = await protectedHttpPeer('held-tool')
    const cancellation = new AbortController()
    let reading: Promise<unknown> | undefined, closing: Promise<unknown> | undefined
    try {
      const options = optionsFor(peer, cancellation.signal)
      options.profile.tools = { read: true }
      let effectFinished = false
      options.tools = [{ name: 'read', description: 'Read actual local HTTP.', inputSchema: { type: 'object' },
        async run() {
          // Deliberately ignores AbortSignal: only the actual peer can finish this effect.
          const response = await fetch(`${peer.origin}/tool`)
          const value = await response.json(); effectFinished = true
          return value
        } }]
      const producer = createProtectedRuntimeChatProducer(options)
      reading = collect(producer)
      void reading.catch(() => undefined)
      let readinessTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([peer.toolStarted, reading.then(() => { throw new Error('Stream ended before actual HTTP tool readiness') }),
          new Promise<never>((_resolve, reject) => {
            readinessTimer = setTimeout(() => reject(new Error('Actual HTTP tool did not become ready')), 5000)
          })])
      } finally { if (readinessTimer) clearTimeout(readinessTimer) }
      cancellation.abort(new DOMException('Member stopped actual HTTP work', 'AbortError'))
      let returned = false
      closing = producer.stream.return(undefined).then(value => {
        returned = true
        expect(effectFinished).toBe(true)
        return value
      })
      void closing.catch(() => undefined)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(peer.toolReleased()).toBe(false)
      expect(effectFinished).toBe(false)
      expect(returned).toBe(false)
      expect(producer.terminalObserved?.()).toBe(false)
      peer.releaseTool()
      await Promise.all([reading, closing])
      expect(effectFinished).toBe(true)
      expect(producer.terminalObserved?.()).toBe(true)
    } finally {
      // Cancel any unresolved real control request, but retain the owned peer/proxy
      // until Runtime's cancellation settlement and all local work are drained.
      cancellation.abort(new DOMException('Integration cleanup', 'AbortError'))
      peer.releaseTool()
      await Promise.allSettled([reading, closing].filter((value): value is Promise<unknown> => Boolean(value)))
      await peer.close()
    }
  }, 15_000)

  it('confirms no dispatch for invalid profile, abort, expired deadline and close before first pull', async () => {
    const peer = await protectedHttpPeer('failure')
    try {
      const refused = optionsFor(peer); refused.profile.harness = 'opencode'
      const profile = createProtectedRuntimeChatProducer(refused)
      expect((await collect(profile)).some(event => event.type === 'error')).toBe(true)
      expect(profile.terminalObserved?.()).toBe(true)
      const stopped = new AbortController(); stopped.abort(new DOMException('Already stopped', 'AbortError'))
      const aborted = createProtectedRuntimeChatProducer(optionsFor(peer, stopped.signal))
      expect((await collect(aborted)).some(event => event.type === 'error')).toBe(true)
      expect(aborted.terminalObserved?.()).toBe(true)
      const expiredOptions = optionsFor(peer); expiredOptions.grant = { ...expiredOptions.grant, deadlineAtMs: Date.now() - 1 }
      const expired = createProtectedRuntimeChatProducer(expiredOptions)
      expect((await collect(expired)).some(event => event.type === 'error')).toBe(true)
      expect(expired.terminalObserved?.()).toBe(true)
      const unpulled = createProtectedRuntimeChatProducer(optionsFor(peer))
      await unpulled.stream.return(undefined)
      expect(unpulled.terminalObserved?.()).toBe(true)
      expect((await unpulled.stream.next()).done).toBe(true)
      expect(peer.seen).toEqual([])
      expect(peer.settled).toEqual([])
    } finally { await peer.close() }
  }, 15_000)

  it.each([false, true])('does not unlock at result publication and keeps authoritative usage with audit refusal=%s', async auditFails => {
    const peer = await protectedHttpPeer('tool', auditFails)
    try {
      const options = optionsFor(peer)
      const observations: Array<{ finalText: string; terminal: boolean | undefined }> = []
      let producer: ReturnType<typeof createProtectedRuntimeChatProducer>
      options.profile.tools = { read: true }
      options.tools = [{ name: 'read', description: 'Read actual local HTTP.', inputSchema: { type: 'object' },
        async run(_args, { signal }) {
          signal.addEventListener('abort', () => {
            // This is the real local owner's finally, after its result was read,
            // before reader cancellation/execution cleanup has completed.
            observations.push({ finalText: producer.finalText(), terminal: producer.terminalObserved?.() })
          }, { once: true })
          const response = await fetch(`${peer.origin}/tool`, { signal })
          return response.json()
        } }]
      producer = createProtectedRuntimeChatProducer(options)
      const events = await collect(producer)
      expect(observations).toEqual([{ finalText: 'FINAL_AFTER_TOOL', terminal: false }])
      expect(peer.settled).toHaveLength(1)
      expect(peer.settled[0]?.calls).toHaveLength(2)
      expect(peer.seen.filter(path => path === '/audit')).toHaveLength(1)
      expect(producer.usage?.()).toEqual({ inputTokens: 6, outputTokens: 4, reasoningTokens: 0, costUsd: 0.002 })
      expect(events.some(event => event.type === 'error')).toBe(auditFails)
      expect(producer.finalText()).toContain('FINAL_AFTER_TOOL')
      expect(producer.terminalObserved?.()).toBe(true)
    } finally { await peer.close() }
  }, 15_000)
})
