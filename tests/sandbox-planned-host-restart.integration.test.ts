import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Sandbox } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import { isReusableBox, recoverUnresponsiveBox } from '../src/sandbox/box-health'

type RestartCase = { probe?: number; sessions?: number; permanent?: boolean; probeCode?: string }

/** The real SDK reads a platform peer over loopback HTTP; no fetch, SDK
 * method, clock or lifecycle implementation is replaced. No paid calls. */
async function boundary(test: RestartCase) {
  const requests: string[] = []
  let probes = 0
  let sessionReads = 0
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    requests.push(`${request.method} ${path}`)
    const json = (data: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data))
    const restarting = (code = 'HOST_AGENT_RESTARTING') => {
      response.setHeader('retry-after', '0.01')
      return json({ code, message: 'The sandbox host is restarting its agent; retry shortly.', retryUntil: Date.now() + 1_000 }, 503)
    }
    if (path === '/v1/sandboxes/restart-box') return json({
      id: 'restart-box', status: 'running', connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/restart-box/runtime` },
    })
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
  return { client, box, requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

const lifecycleRequests = (requests: string[]) => requests.filter(path => /\/(stop|resume|delete)(?:$|\/)/.test(path))

describe('sandbox liveness during a planned host restart', () => {
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
