import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import { ensureWorkspaceSandbox, type SandboxRuntimeConfig } from '../src/sandbox/index'
import { runForegroundSandboxSingleFlight } from '../src/sandbox/foreground-single-flight'
import { createD1PrewarmClaimStore, PREWARM_CLAIM_TABLE_DDL, type PrewarmClaimD1Like } from '../src/sandbox/prewarm-claim-d1'
import { sandboxPrewarmClaimKey } from '../src/sandbox/prewarm'
import { resolveWorkspaceSandboxClient } from '../src/sandbox/workspace-boxes'
import { peekWorkspaceSandbox } from '../src/sandbox/workspace-boxes'
import { provisionWorkspaceSandbox } from '../src/sandbox/workspace-provision'

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
async function boundary(mode: 'read' | 'resume' | 'create' | 'connection' | 'ready') {
  const entered = deferred()
  const closed = deferred()
  const twoEntered = deferred()
  const pending: ServerResponse[] = []
  const requests: string[] = []
  const name = mode === 'ready' ? `cancel-ready-${randomUUID()}` : 'cancel-workspace'
  const server = createServer((request, response) => {
    request.resume()
    const path = new URL(request.url!, 'http://localhost').pathname
    requests.push(`${request.method} ${path}`)
    const json = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (mode === 'ready') {
      const box = { id: 'cancel-original', name, status: 'running', metadata: { harness: 'opencode' },
        filesystemIncarnationId: name, filesystemIncarnationReadiness: 'ready',
        connection: { runtimeUrl: `${baseUrl}/v1/sandboxes/cancel-original/runtime` } }
      if (path === '/v1/sandboxes') return json({ sandboxes: [box] })
      if (path === '/v1/sandboxes/cancel-original') return json(box)
      if (path.endsWith('/runtime/config/config/app-env')) return json({ injected: 1 })
    }
    if (mode === 'read' || path.endsWith('/resume') || (mode === 'connection' && path.endsWith('/cancel-original')) || (mode === 'create' && request.method === 'POST')) {
      pending.push(response)
      if (pending.length === 2) twoEntered.resolve()
      response.on('close', () => closed.resolve())
      entered.resolve()
      return
    }
    if (path === '/v1/sandboxes') {
      const stopped = new URL(request.url!, 'http://localhost').searchParams.get('status') === 'stopped'
      const found = (stopped && mode === 'resume') || (!stopped && mode === 'connection')
      return json({ sandboxes: found ? [{ id: 'cancel-original', name: 'cancel-workspace', status: stopped ? 'stopped' : 'running', lifecycleState: stopped ? 'suspended' : undefined, metadata: { harness: 'opencode' }, filesystemIncarnationId: 'cancel-incarnation', filesystemIncarnationReadiness: 'ready' }] : [] })
    }
    response.writeHead(500).end('Unexpected lifecycle request')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const shell: SandboxRuntimeConfig = {
    credentials: () => ({ apiKey: 'local-cancellation-fixture', baseUrl }),
    name: () => name, metadata: harness => ({ harness }),
    connectedIntegrationIds: async () => [], env: async () => ({}),
    files: async () => [], secrets: async () => [],
    profile: () => {
      if (mode !== 'create') throw new Error('Cancellation must not create a profile')
      return { name: 'local-cancellation-fixture' } as AgentProfile
    },
    recoverStoppedSandbox: async () => { throw new Error('Cancellation must not authorize replacement') },
  }
  return {
    requests, shell, entered: entered.promise, closed: closed.promise, twoEntered: twoEntered.promise,
    releaseReads() {
      for (const response of pending) if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end('{"sandboxes":[]}')
    },
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

  it.each(['read', 'resume', 'create', 'connection'] as const)('aborts an in-flight %s at the actual HTTP transport without replacement', async mode => {
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
      expect(peer.requests.filter(line => line.startsWith('POST'))).toEqual(mode === 'resume' ? ['POST /v1/sandboxes/cancel-original/resume'] : mode === 'create' ? ['POST /v1/sandboxes'] : [])
    } finally { controller.abort(); await peer.close(); await result.catch(() => undefined) }
  })

  it('does not cache a caller signal across SDK clients using the same credentials', async () => {
    const peer = await boundary('read')
    const a = new AbortController()
    const b = new AbortController()
    // Additional positional arguments are intentionally valid JS on the RED
    // revision too; its client factory ignores the signal and the proof fails.
    const resolveClient = resolveWorkspaceSandboxClient as typeof resolveWorkspaceSandboxClient & ((...args: unknown[]) => ReturnType<typeof resolveWorkspaceSandboxClient>)
    const clientA = (await resolveClient(peer.shell, 'a', undefined, a.signal)).client
    const clientB = (await resolveClient(peer.shell, 'b', undefined, b.signal)).client
    const readA = clientA.list()
    const readB = clientB.list()
    const rejected = expect(bounded(readA)).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await bounded(peer.twoEntered)
      a.abort()
      await rejected
      peer.releaseReads()
      expect(await bounded(readB)).toEqual([])
      expect(b.signal.aborted).toBe(false)
    } finally { a.abort(); b.abort(); await peer.close(); await Promise.allSettled([readA, readB]) }
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
    const peer = await boundary('create')
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

  it.each(['reuse', 'peek'] as const)('cancels an actual in-flight waiter %s read and preserves another owner', async phase => {
    const peer = await boundary('read')
    const { db, store } = sqliteClaims()
    const scope = { workspaceId: `cancel-read-${phase}`, harness: 'opencode' as const }
    const key = sandboxPrewarmClaimKey(scope)
    const lease = await store.acquireLease(key, 180)
    const controller = new AbortController()
    const read = (signal?: AbortSignal) => peekWorkspaceSandbox(peer.shell, { workspaceId: scope.workspaceId, signal })
    const options = { ...scope, claim: store, signal: controller.signal, pollIntervalMs: 1,
      ...(phase === 'reuse' ? { reuse: async (signal?: AbortSignal) => { await read(signal); return undefined } } : {}),
      provision: async () => { throw new Error('Waiter must not provision') },
      peek: read, adopt: () => 'unused',
    }
    const result = runForegroundSandboxSingleFlight(options)
    const rejected = expect(bounded(result)).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await bounded(peer.entered)
      controller.abort()
      await rejected
      await bounded(peer.closed)
      expect(await store.inspect(key)).toEqual({ status: 'held', expiresAt: lease!.expiresAt })
    } finally { controller.abort(); await peer.close(); await result.catch(() => undefined); db.close() }
  })

  it('starts no payload callbacks after cancellation during the actual SQLite spend gate', async () => {
    const peer = await boundary('create')
    const { db } = sqliteClaims()
    db.exec('CREATE TABLE callback_effects (event TEXT)')
    const controller = new AbortController()
    const shell = { ...peer.shell, resumeStopped: false, files: async () => {
      db.exec("INSERT INTO callback_effects VALUES ('files')")
      return []
    } }
    try {
      const options = { workspaceId: 'cancel-payload', harness: 'opencode' as const, signal: controller.signal }
      await expect(provisionWorkspaceSandbox(shell, options, async () => {
        // A real storage boundary settles while the caller departs.
        db.prepare('SELECT COUNT(*) AS n FROM callback_effects').get()
        controller.abort()
      }, false)).rejects.toMatchObject({ name: 'AbortError' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM callback_effects').get()).toMatchObject({ n: 0 })
      expect(peer.requests.filter(line => line.startsWith('POST'))).toEqual([])
    } finally { controller.abort(); await peer.close(); db.close() }
  })
  it.each(['observation', 'persistence'] as const)('refuses a box after async %s canceled the caller', async phase => {
    const peer = await boundary('ready')
    const { db } = sqliteClaims()
    db.exec('CREATE TABLE observations (sandbox TEXT); CREATE TABLE reuse_state (name TEXT PRIMARY KEY, value TEXT)')
    const controller = new AbortController()
    const shell: SandboxRuntimeConfig = { ...peer.shell, runtimeEnv: async () => ({ LOCAL_PROOF: 'yes' }),
      reuseState: {
        async load() { return null },
        async save(name, value) {
          db.prepare('INSERT INTO reuse_state VALUES (?, ?)').run(name, JSON.stringify(value))
          if (phase === 'persistence') controller.abort()
        },
        async drop(name) { db.prepare('DELETE FROM reuse_state WHERE name = ?').run(name) },
      },
    }
    try {
      await expect(ensureWorkspaceSandbox(shell, { workspaceId: `after-${phase}`, harness: 'opencode', signal: controller.signal,
        spend: { async onProvisioned(value) {
          db.prepare('INSERT INTO observations VALUES (?)').run(value.sandboxId)
          if (phase === 'observation') controller.abort()
        } },
      })).rejects.toMatchObject({ name: 'AbortError' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get()).toMatchObject({ n: 1 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM reuse_state').get()).toMatchObject({ n: phase === 'persistence' ? 1 : 0 })
      expect(peer.requests.some(line => /POST \/v1\/sandboxes(?:$|\/cancel-original\/(?:resume|stop))/.test(line))).toBe(false)
    } finally { controller.abort(); await peer.close(); db.close() }
  })

  it('refuses a box after async adoption canceled the caller without releasing a later owner', async () => {
    const peer = await boundary('ready')
    const { db, store } = sqliteClaims()
    db.exec('CREATE TABLE adoptions (sandbox TEXT)')
    const scope = { workspaceId: 'after-adoption', harness: 'opencode' as const }
    const key = sandboxPrewarmClaimKey(scope)
    const prior = await store.acquireLease(key, 180)
    const controller = new AbortController()
    let released: Promise<void> | undefined
    try {
      const result = runForegroundSandboxSingleFlight({ ...scope, claim: store, signal: controller.signal, pollIntervalMs: 1,
        onEvent(event) { if (event.type === 'waiting') released = store.releaseLease(prior!) },
        provision: async () => { throw new Error('Waiter must not provision') },
        peek: async signal => { await released; return peekWorkspaceSandbox(peer.shell, { workspaceId: scope.workspaceId, signal }) },
        async adopt(value) {
          db.prepare('INSERT INTO adoptions VALUES (?)').run(value.box.id)
          expect(await store.acquireLease(key, 180)).not.toBeNull()
          controller.abort()
          return value.box
        },
      })
      await expect(bounded(result)).rejects.toMatchObject({ name: 'AbortError' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM adoptions').get()).toMatchObject({ n: 1 })
      expect((await store.inspect(key)).status).toBe('held')
      expect(peer.requests.filter(line => line.startsWith('POST'))).toEqual([])
    } finally { controller.abort(); await peer.close(); db.close() }
  })

})
