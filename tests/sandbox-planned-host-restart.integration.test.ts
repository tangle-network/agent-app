import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Sandbox } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import { isReusableBox, recoverUnresponsiveBox } from '../src/sandbox/box-health'
import { ensureWorkspaceSandbox, type SandboxRuntimeConfig } from '../src/sandbox/index'

type RestartCase = {
  probe?: number; sessions?: number; permanent?: boolean; probeCode?: string
  prefetch?: boolean; prefetchCode?: string; strict?: boolean
  omitProbe?: boolean; prefetchRefusals?: number; permanentPrefetch?: 'egress' | 'env'; budgetMs?: number
}

/** The real SDK reads a platform peer over loopback HTTP; no fetch, SDK
 * method, clock or lifecycle implementation is replaced. No paid calls. */
async function boundary(test: RestartCase) {
  const requests: string[] = []
  const boxName = `restart-prefetch-${randomUUID()}`
  let probes = 0
  let sessionReads = 0
  let boxReads = 0
  let envWrites = 0
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    requests.push(`${request.method} ${path}`)
    const json = (data: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data))
    const restarting = (code = 'HOST_AGENT_RESTARTING') => {
      response.setHeader('retry-after', '0.01')
      return json({ code, message: 'The sandbox host is restarting its agent; retry shortly.', retryUntil: Date.now() + 1_000 }, 503)
    }
    const box = {
      id: 'restart-box', name: boxName, status: 'running', metadata: { harness: 'opencode' },
      filesystemIncarnationId: test.prefetch ? `${boxName}-incarnation` : 'restart-fixture-incarnation',
      filesystemIncarnationProvenance: 'fresh', filesystemIncarnationReadiness: 'ready',
      connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/restart-box/runtime` },
      egressPolicy: { mode: 'open' }, egressPolicySource: 'sandbox',
    }
    if (path === '/v1/sandboxes') return json({ sandboxes: [box], total: 1 })
    if (path === '/v1/sandboxes/restart-box') {
      // The fixture's initial SDK get succeeds. The public shell's prefetch
      // and fresh egress reads then meet the same actual HTTP refusal.
      const read = boxReads++
      if (test.prefetch && read > 0 && (test.permanentPrefetch === 'egress' || read <= (test.prefetchRefusals ?? 1))) return restarting(test.prefetchCode)
      return json(box)
    }
    if (path.endsWith('/runtime/config/config/app-env')) {
      const write = envWrites++
      if (test.prefetch && (test.permanentPrefetch === 'env' || write < (test.prefetchRefusals ?? 1))) return restarting(test.prefetchCode)
      return json({ injected: 1 })
    }
    if (path.endsWith('/runtime/process/spawn')) {
      if (test.permanent || probes++ < (test.probe ?? 0)) return restarting(test.probeCode)
      return json({ data: { exitCode: 0, stdout: 'alive\n', stderr: '' } })
    }
    if (path.endsWith('/runtime/agents/sessions')) {
      if (sessionReads++ < (test.sessions ?? 0)) return restarting()
      return json([])
    }
    // Any lifecycle request means the observed restart was mishandled.
    return json({ code: 'UNEXPECTED_LIFECYCLE', message: 'Must not restart a box during its host restart' }, 500)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = new Sandbox({ apiKey: 'local-restart-fixture', baseUrl })
  const box = await client.get('restart-box')
  if (!box) throw new Error('Fixture box missing')
  expect(box.connection?.runtimeUrl, 'SDK accepted the real ready-incarnation connection').toBe(`${baseUrl}/v1/sandboxes/restart-box/runtime`)
  const shell: SandboxRuntimeConfig = {
    credentials: () => ({ apiKey: 'local-restart-prefetch-fixture', baseUrl }),
    name: () => boxName, metadata: harness => ({ harness }),
    connectedIntegrationIds: async () => [],
    env: async () => ({}), files: async () => [], secrets: async () => [],
    profile: () => { throw new Error('Reuse must not create a cold profile') },
    runtimeEnv: async () => ({ RESTART_FIXTURE_ENV: 'loopback-only' }),
    egressPolicy: test.strict ? { mode: 'strict', allowDomains: ['api.example.test'] } : { mode: 'open' },
    ...(test.omitProbe ? {} : { livenessProbe: { execTimeoutMs: 1_000, cacheTtlMs: 0 } }),
    provisionTimeoutMs: test.budgetMs ?? 1_000,
  }
  return { client, box, requests,
    ensure: () => ensureWorkspaceSandbox(shell, { workspaceId: boxName, harness: 'opencode' }),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

const lifecycleRequests = (requests: string[]) => requests.filter(path => /\/(stop|resume|delete)(?:$|\/)/.test(path))

describe('sandbox liveness during a planned host restart', () => {
  it('waits through repeated typed prefetch refusals when the liveness probe is omitted', async () => {
    const peer = await boundary({ prefetch: true, prefetchRefusals: 2, omitProbe: true })
    try {
      expect((await peer.ensure()).id).toBe('restart-box')
      expect(peer.requests.filter(path => path.endsWith('/process/spawn'))).toHaveLength(0)
      expect(peer.requests.filter(path => path.endsWith('/runtime/config/config/app-env'))).toHaveLength(3)
      // Initial fixture get, two refused reads, then the authoritative policy.
      expect(peer.requests.filter(path => path === 'GET /v1/sandboxes/restart-box')).toHaveLength(4)
      expect(lifecycleRequests(peer.requests)).toEqual([])
    } finally { await peer.close() }
  })

  it.each(['egress', 'env'] as const)('bounds permanent typed %s prefetch refusals without a liveness probe', async kind => {
    const peer = await boundary({ prefetch: true, omitProbe: true, permanentPrefetch: kind, strict: kind === 'egress', budgetMs: 150 })
    const started = Date.now()
    try {
      const expected = { code: 'HOST_AGENT_RESTARTING', status: 503 }
      await expect(peer.ensure()).rejects.toMatchObject(kind === 'egress' ? { cause: expected } : expected)
      expect(Date.now() - started).toBeLessThan(1_500)
      const egressReads = peer.requests.filter(path => path === 'GET /v1/sandboxes/restart-box')
      const envWrites = peer.requests.filter(path => path.endsWith('/runtime/config/config/app-env'))
      expect(kind === 'egress' ? egressReads.length : envWrites.length).toBeGreaterThan(2)
      if (kind === 'egress') expect(envWrites).toHaveLength(0)
      expect(peer.requests.filter(path => path.endsWith('/process/spawn'))).toHaveLength(0)
      expect(lifecycleRequests(peer.requests)).toEqual([])
    } finally { await peer.close() }
  }, 3_000)

  it('refreshes typed prefetch failures after the composed reuse probe recovers', async () => {
    const peer = await boundary({ probe: 2, prefetch: true })
    try {
      expect((await peer.ensure()).id).toBe('restart-box')
      expect(peer.requests.filter(path => path.endsWith('/process/spawn'))).toHaveLength(3)
      expect(peer.requests.filter(path => path.endsWith('/runtime/config/config/app-env'))).toHaveLength(2)
      // Initial fixture get, refused prefetch, then a fresh egress read.
      expect(peer.requests.filter(path => path === 'GET /v1/sandboxes/restart-box')).toHaveLength(3)
      expect(lifecycleRequests(peer.requests)).toEqual([])
    } finally { await peer.close() }
  })

  it('preserves an unrelated strict-policy prefetch refusal without delivering credentials', async () => {
    const peer = await boundary({ probe: 2, prefetch: true, prefetchCode: 'SIDECAR_HEALTH_CHECK_FAILED', strict: true })
    try {
      await expect(peer.ensure()).rejects.toMatchObject({ cause: { code: 'SIDECAR_HEALTH_CHECK_FAILED' } })
      expect(peer.requests.filter(path => path.endsWith('/runtime/config/config/app-env'))).toHaveLength(0)
      expect(peer.requests.filter(path => path === 'GET /v1/sandboxes/restart-box')).toHaveLength(2)
      expect(lifecycleRequests(peer.requests)).toEqual([])
    } finally { await peer.close() }
  })

  it('waits for the typed probe refusal and reuses the same runtime', async () => {
    const peer = await boundary({ probe: 2 })
    try {
      const result = await isReusableBox(peer.box, { execTimeoutMs: 1_000, cacheTtlMs: 0 })
      expect(result.succeeded).toBe(true)
      expect(peer.requests.filter(path => path.endsWith('/process/spawn'))).toHaveLength(3)
      expect(lifecycleRequests(peer.requests)).toEqual([])
    } finally { await peer.close() }
  })

  it('rechecks liveness after a session read waited through a host restart', async () => {
    const peer = await boundary({ sessions: 2 })
    try {
      const result = await recoverUnresponsiveBox(peer.client, peer.box, { execTimeoutMs: 1_000, cacheTtlMs: 0 }, 'reused', 'restart-fixture', 1_000, {})
      expect(result.id).toBe('restart-box')
      expect(peer.requests.filter(path => path.endsWith('/agents/sessions'))).toHaveLength(3)
      expect(lifecycleRequests(peer.requests)).toEqual([])
    } finally { await peer.close() }
  })

  it('preserves an exhausted typed refusal without issuing stop or resume', async () => {
    const peer = await boundary({ permanent: true })
    const started = Date.now()
    try {
      await expect(isReusableBox(peer.box, { execTimeoutMs: 100, cacheTtlMs: 0 })).rejects.toMatchObject({ code: 'HOST_AGENT_RESTARTING', status: 503 })
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(lifecycleRequests(peer.requests)).toEqual([])
    } finally { await peer.close() }
  })

  it('does not retry an unrelated unavailable response', async () => {
    const peer = await boundary({ probe: 1, probeCode: 'SIDECAR_HEALTH_CHECK_FAILED' })
    try {
      expect((await isReusableBox(peer.box, { execTimeoutMs: 1_000, cacheTtlMs: 0 })).succeeded).toBe(false)
      expect(peer.requests.filter(path => path.endsWith('/process/spawn'))).toHaveLength(1)
    } finally { await peer.close() }
  })
})
