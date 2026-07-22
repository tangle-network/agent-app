import { describe, expect, it, vi } from 'vitest'

import {
  createSandboxFileIndexRoute,
  type FileIndexCache,
  type FileIndexReadyResponse,
  type SandboxFileTreeSource,
} from '../../src/chat-routes/index'

function fakeFs(files: Array<{ path: string; size: number }>, truncated = false): SandboxFileTreeSource {
  return {
    async tree(root) {
      return { root, files, stats: { truncated } }
    },
  }
}

function indexRequest(): Request {
  return new Request('http://app.test/api/chat/files')
}

describe('createSandboxFileIndexRoute', () => {
  it('returns workspace-relative files with default ignores applied', async () => {
    const fs = fakeFs([
      { path: '/home/agent/src/index.ts', size: 120 },
      { path: '/home/agent/node_modules/pkg/index.js', size: 40 },
      { path: '/home/agent/.git/HEAD', size: 10 },
      { path: '/home/agent/.env', size: 5 },
      { path: '/home/agent/dist/bundle.js', size: 900 },
      { path: '/home/agent/README.md', size: 30 },
    ])
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'ready', fs, root: '/home/agent' }),
    })
    const res = await route(indexRequest())
    expect(res.status).toBe(200)
    const body = (await res.json()) as FileIndexReadyResponse
    expect(body.status).toBe('ready')
    expect(body.files.map((f) => f.path).sort()).toEqual(['README.md', 'src/index.ts'])
    expect(body.files.find((f) => f.path === 'src/index.ts')).toMatchObject({ name: 'index.ts', size: 120 })
    expect(body.truncated).toBe(false)
    expect(typeof body.generatedAt).toBe('string')
  })

  it('merges caller-supplied extra ignores with the defaults', async () => {
    const fs = fakeFs([
      { path: '/root/keep.ts', size: 1 },
      { path: '/root/vendor/lib.js', size: 1 },
    ])
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'ready', fs, root: '/root' }),
      ignore: ['vendor'],
    })
    const body = (await (await route(indexRequest())).json()) as FileIndexReadyResponse
    expect(body.files.map((f) => f.path)).toEqual(['keep.ts'])
  })

  it('merges per-request extra ignores from the authorize seam', async () => {
    const fs = fakeFs([
      { path: '/root/keep.ts', size: 1 },
      { path: '/root/secrets/token.txt', size: 1 },
    ])
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'ready', fs, root: '/root', ignore: ['secrets'] }),
    })
    const body = (await (await route(indexRequest())).json()) as FileIndexReadyResponse
    expect(body.files.map((f) => f.path)).toEqual(['keep.ts'])
  })

  it('caps entries and sets truncated once the cap is exceeded', async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `/root/file-${i}.txt`, size: 1 }))
    const fs = fakeFs(files)
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'ready', fs, root: '/root' }),
      maxEntries: 4,
    })
    const body = (await (await route(indexRequest())).json()) as FileIndexReadyResponse
    expect(body.files).toHaveLength(4)
    expect(body.truncated).toBe(true)
  })

  it('propagates the underlying scan truncation even under the entry cap', async () => {
    const fs = fakeFs([{ path: '/root/a.txt', size: 1 }], true)
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'ready', fs, root: '/root' }),
    })
    const body = (await (await route(indexRequest())).json()) as FileIndexReadyResponse
    expect(body.truncated).toBe(true)
  })

  it('answers a cold box with a typed warming response, never provisioning', async () => {
    let treeCalled = false
    const fs: SandboxFileTreeSource = {
      async tree() {
        treeCalled = true
        return { root: '/root', files: [], stats: { truncated: false } }
      },
    }
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'warming' }),
    })
    const res = await route(indexRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'warming' })
    expect(treeCalled).toBe(false)
    void fs // referenced only to prove tree() is never invoked when warming
  })

  it('passes through the authorize seam denial response verbatim', async () => {
    const denied = Response.json({ error: 'unauthorized' }, { status: 401 })
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'denied', response: denied }),
    })
    const res = await route(indexRequest())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('serves from the cache seam on a hit and populates it on a miss', async () => {
    let treeCalls = 0
    const fs: SandboxFileTreeSource = {
      async tree(root) {
        treeCalls++
        return { root, files: [{ path: 'a.txt', size: 1 }], stats: { truncated: false } }
      },
    }
    const store = new Map<string, FileIndexReadyResponse>()
    const cache: FileIndexCache = {
      get: (key) => store.get(key) ?? null,
      put: (key, value) => {
        store.set(key, value)
      },
    }
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'ready', fs, root: '/root', cacheKey: 'ws-1' }),
      cache,
    })

    const first = (await (await route(indexRequest())).json()) as FileIndexReadyResponse
    expect(first.files).toHaveLength(1)
    expect(treeCalls).toBe(1)

    const second = (await (await route(indexRequest())).json()) as FileIndexReadyResponse
    expect(second).toEqual(first)
    expect(treeCalls).toBe(1) // second request served from cache, no re-scan
  })

  it('skips the cache when authorize omits a cacheKey', async () => {
    let treeCalls = 0
    const fs: SandboxFileTreeSource = {
      async tree(root) {
        treeCalls++
        return { root, files: [{ path: 'a.txt', size: 1 }], stats: { truncated: false } }
      },
    }
    const cache: FileIndexCache = {
      get: () => null,
      put: () => {},
    }
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({ status: 'ready', fs, root: '/root' }),
      cache,
    })
    await route(indexRequest())
    await route(indexRequest())
    expect(treeCalls).toBe(2)
  })
})

// A box that is running but has not materialised its workspace root yet: the
// SDK rejects `tree()` with a ValidationError wrapping the box-side ENOENT.
class FakeValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

function throwingFs(error: unknown): SandboxFileTreeSource {
  return {
    async tree() {
      throw error
    },
  }
}

function routeOver(error: unknown, root = '/home/agent/vault') {
  return createSandboxFileIndexRoute({
    authorize: async () => ({ status: 'ready', fs: throwingFs(error), root }),
  })
}

describe('createSandboxFileIndexRoute — a root that does not exist yet', () => {
  it('answers warming instead of letting the ENOENT escape as a 500', async () => {
    const route = routeOver(
      new FakeValidationError("ENOENT: no such file or directory, lstat '/home/agent/vault'"),
    )
    const res = await route(indexRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'warming' })
  })

  it('never caches the warming answer as a ready body', async () => {
    const put = vi.fn()
    const route = createSandboxFileIndexRoute({
      authorize: async () => ({
        status: 'ready',
        fs: throwingFs(new FakeValidationError("ENOENT: no such file or directory, lstat '/root'")),
        root: '/root',
        cacheKey: 'ws-1',
      }),
      cache: { get: async () => null, put },
    })
    await route(indexRequest())
    expect(put).not.toHaveBeenCalled()
  })

  it.each([
    ['a permission error', new FakeValidationError("EACCES: permission denied, lstat '/home/agent/vault'")],
    ['a timeout', Object.assign(new Error('tree timed out after 30000ms'), { code: 'TIMEOUT' })],
    ['an auth failure', Object.assign(new Error('unauthorized'), { code: 'AUTH_ERROR' })],
    [
      'an ENOENT on some OTHER path inside the tree',
      new FakeValidationError("ENOENT: no such file or directory, lstat '/home/agent/vault/gone/x.md'".replace('/home/agent/vault/gone', '/elsewhere')),
    ],
    ['a plain error with no code', new Error('ENOENT: no such file or directory')],
    ['a non-Error rejection', 'ENOENT: no such file or directory /home/agent/vault'],
  ])('still surfaces %s', async (_label, error) => {
    await expect(routeOver(error)(indexRequest())).rejects.toBeTruthy()
  })
})
