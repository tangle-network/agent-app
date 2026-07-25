import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The work-product client surfaces (queue projection, types/codecs, the
 * `/web-react` queue+card components, the sandbox-ui pane) ship in client
 * bundles. The server half — the tool executors (store writes), the verdict
 * route, and the service — must never be reachable from that graph: one
 * careless import and every consumer ships store/dispatch code to the
 * browser. Same walk as tests/interactions-browser-safe.test.ts.
 */
const FORBIDDEN_SPECIFIERS = [
  /^node:/,
  /^@tangle-network\/(agent-runtime|agent-eval|sandbox)(\/|$)/, // sandbox-ui stays allowed
  /^child_process$/,
  /^fs$/,
  /^util$/,
]
const SERVER_ONLY_FILES = [
  /src\/work-product\/route\.ts$/,
  /src\/work-product\/tools\.ts$/,
  /src\/work-product\/service\.ts$/,
  /src\/work-product\/provenance\.ts$/,
]

const CLIENT_ENTRIES = [
  '../src/work-product/types.ts',
  '../src/work-product/queue.ts',
  '../src/web-react/work-product.tsx',
  '../src/work-product-react/index.tsx',
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
      // try next extension
    }
  }
  throw new Error(`cannot resolve local import "${spec}" from ${fromFile}`)
}

describe('work-product client-surface browser-safety', () => {
  it('reaches no node builtins, engine runtimes, or the server-only tool/route/service modules', () => {
    const seen = new Set<string>()
    const queue = CLIENT_ENTRIES.map((entry) => resolve(__dirname, entry))
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const bad of SERVER_ONLY_FILES) {
        expect(file.replace(/\\/g, '/'), `client graph reached server-only module ${file}`).not.toMatch(bad)
      }
      for (const spec of localImports(file)) {
        for (const bad of FORBIDDEN_SPECIFIERS) {
          expect(spec, `${file} imports forbidden "${spec}"`).not.toMatch(bad)
        }
        if (spec.startsWith('.')) queue.push(resolveLocal(file, spec))
      }
    }
    // Sanity: the walk actually traversed into the shared contract.
    expect([...seen].some((file) => file.endsWith('work-product/types.ts'))).toBe(true)
  })
})
