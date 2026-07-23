import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `/turn-stream` is server-only: it holds the DO transport, the lock
 * protocol, and worker-side adapters. Nothing in the client-shipped graphs
 * (`/web-react` chat surfaces, the `./wire` contract) may reach it — one
 * careless import and every consumer ships the lock/broadcast protocol to
 * the browser. Same import-graph walk as `interactions-browser-safe`.
 */
const SERVER_ONLY = /src\/turn-stream\//

const CLIENT_ENTRIES = [
  '../../src/web-react/chat-stream.ts',
  '../../src/web-react/chat-interactions.ts',
  '../../src/chat-routes/wire.ts',
]

function localImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].flatMap((m) => (m[1] ? [m[1]] : []))
}

function resolveLocal(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec)
  if (/\.(ts|tsx)$/.test(base)) return base
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // try next candidate
    }
  }
  throw new Error(`cannot resolve local import "${spec}" from ${fromFile}`)
}

describe('turn-stream browser-safety', () => {
  it('no client entry graph reaches src/turn-stream', () => {
    const seen = new Set<string>()
    const queue = CLIENT_ENTRIES.map((entry) => resolve(__dirname, entry))
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      expect(file.replace(/\\/g, '/'), `client graph reached server-only module ${file}`).not.toMatch(SERVER_ONLY)
      for (const spec of localImports(file)) {
        if (spec.startsWith('.')) queue.push(resolveLocal(file, spec))
      }
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('turn-stream itself imports no node builtins or substrate SDKs', () => {
    const roots = ['core.ts', 'do.ts', 'adapters.ts', 'memory.ts', 'index.ts'].map((f) =>
      resolve(__dirname, '../../src/turn-stream', f),
    )
    for (const file of roots) {
      for (const spec of localImports(file)) {
        expect(spec, `${file} imports "${spec}"`).not.toMatch(
          /^node:|^cloudflare:|^@tangle-network\/(sandbox|agent-runtime)|^fs$|^child_process$/,
        )
      }
    }
  })
})
