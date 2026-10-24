import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ensureWorkspaceSandbox, type SandboxRuntimeConfig } from '../src/sandbox/index'
import { runForegroundSandboxSingleFlight } from '../src/sandbox/foreground-single-flight'
import { createD1PrewarmClaimStore, PREWARM_CLAIM_TABLE_DDL, type PrewarmClaimD1Like } from '../src/sandbox/prewarm-claim-d1'
import { sandboxPrewarmClaimKey } from '../src/sandbox/prewarm'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation failed to settle within 1000ms')), 1_000)
    })])
  } finally { clearTimeout(timer) }
}

/** Real SDK requests to a loopback HTTP peer. No replaced fetch, SDK method,
 * clock, lifecycle function, or production request. */
async function boundary(mode: 'read' | 'resume') {
  const entered = deferred()
  const closed = deferred()
  const requests: string[] = []
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    requests.push(`${request.method} ${path}`)
    const json = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (mode === 'read' || path.endsWith('/resume')) {
      response.on('close', () => closed.resolve())
      entered.resolve()
      return
    }
    if (path === '/v1/sandboxes') {
      const stopped = new URL(request.url!, 'http://localhost').searchParams.get('status') === 'stopped'
      return json({ sandboxes: stopped ? [{ id: 'cancel-original', name: 'cancel-workspace', status: 'stopped', lifecycleState: 'suspended', metadata: { harness: 'opencode' } }] : [] })
    }
    response.writeHead(500).end('Unexpected lifecycle request')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const shell: SandboxRuntimeConfig = {
    credentials: () => ({ apiKey: 'local-cancellation-fixture', baseUrl }),
    name: () => 'cancel-workspace', metadata: harness => ({ harness }),
    connectedIntegrationIds: async () => [], env: async () => ({}),
    files: async () => [], secrets: async () => [],
    profile: () => { throw new Error('Cancellation must not create a profile') },
    recoverStoppedSandbox: async () => { throw new Error('Cancellation must not authorize replacement') },
  }
  return {
    requests, entered: entered.promise, closed: closed.promise,
    ensure(signal: AbortSignal) {
      const options = { workspaceId: 'cancel-workspace', harness: 'opencode' as const, signal }
      return ensureWorkspaceSandbox(shell, options)
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function sqliteClaims() {
  const db = new DatabaseSync(':memory:')
  db.exec(PREWARM_CLAIM_TABLE_DDL)
  const binding: PrewarmClaimD1Like = {
    prepare(sql) {
      const statement = db.prepare(sql)
      return { bind(...values: unknown[]) { return {
        async first<T>() { return (statement.get(...values as never[]) as T | undefined) ?? null },
        async run() { return statement.run(...values as never[]) },
      } } }
    },
  }
  return { db, store: createD1PrewarmClaimStore(binding) }
}

describe('request cancellation through SDK and fenced provisioning', () => {
  it('rejects an already canceled ensure before network or lifecycle work', async () => {
    const peer = await boundary('read')
    try {
      await expect(bounded(peer.ensure(AbortSignal.abort()))).rejects.toMatchObject({ name: 'AbortError' })
      expect(peer.requests).toEqual([])
    } finally { await peer.close() }
  })

  it.each(['read', 'resume'] as const)('aborts an in-flight %s at the actual HTTP transport without replacement', async mode => {
    const peer = await boundary(mode)
    const controller = new AbortController()
    const result = peer.ensure(controller.signal)
    // Register the rejection before aborting the actual transport.
    const rejected = expect(bounded(result)).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await bounded(peer.entered)
      controller.abort()
      await rejected
      await bounded(peer.closed)
      expect(peer.requests.filter(line => line.startsWith('POST'))).toEqual(mode === 'resume' ? ['POST /v1/sandboxes/cancel-original/resume'] : [])
    } finally { controller.abort(); await peer.close(); await result.catch(() => undefined) }
  })

  it('cancels a losing waiter without releasing the real SQLite owner lease', async () => {
    const { db, store } = sqliteClaims()
    const scope = { workspaceId: 'cancel-waiter', harness: 'opencode' as const }
    const key = sandboxPrewarmClaimKey(scope)
    const lease = await store.acquireLease(key, 180)
    const controller = new AbortController()
    const entered = deferred()
    let provisions = 0
    const options = { ...scope, claim: store, signal: controller.signal, pollIntervalMs: 10_000,
      provision: async () => { provisions++; return 'new' },
      peek: async () => ({ status: 'absent' as const }), adopt: () => 'adopted',
      onEvent: () => entered.resolve(),
    }
    const result = runForegroundSandboxSingleFlight(options)
    const rejected = expect(bounded(result)).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await bounded(entered.promise)
      controller.abort()
      await rejected
      expect(await store.inspect(key)).toEqual({ status: 'held', expiresAt: lease!.expiresAt })
      expect(provisions).toBe(0)
    } finally { controller.abort(); db.close() }
  })

  it('retains the owner lease when an actual HTTP request is canceled with an ambiguous remote outcome', async () => {
    const peer = await boundary('read')
    const { db, store } = sqliteClaims()
    const scope = { workspaceId: 'cancel-owner', harness: 'opencode' as const }
    const controller = new AbortController()
    const options = { ...scope, claim: store, signal: controller.signal,
      provision: () => peer.ensure(controller.signal),
      peek: async () => ({ status: 'absent' as const }), adopt: (value: unknown) => value,
    }
    const result = runForegroundSandboxSingleFlight(options)
    const rejected = expect(bounded(result)).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await bounded(peer.entered)
      controller.abort()
      await rejected
      await bounded(peer.closed)
      expect((await store.inspect(sandboxPrewarmClaimKey(scope))).status).toBe('held')
      expect(await store.acquireLease(sandboxPrewarmClaimKey(scope), 180)).toBeNull()
    } finally { controller.abort(); await peer.close(); await result.catch(() => undefined); db.close() }
  })
})
