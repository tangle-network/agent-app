import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `./catalog` is the browser-safe catalogue subpath: client components import
 * `buildCatalog`/`CatalogModel` from it. If anything reachable from it gains a
 * Node-only or agent-runtime import, every consumer's client bundle crashes on
 * module load (legal-agent #256, tax-agent #372). Walk the source import graph
 * and fail loud on the first unsafe edge.
 */
const FORBIDDEN = [/^node:/, /^@tangle-network\/agent-runtime/, /^child_process$/, /^fs$/, /^util$/]

function localImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].flatMap((m) => (m[1] ? [m[1]] : []))
}

describe('catalog subpath browser-safety', () => {
  it('reaches no node builtins or agent-runtime imports', () => {
    const seen = new Set<string>()
    const queue = [resolve(__dirname, '../src/catalog/index.ts')]
    while (queue.length) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const spec of localImports(file)) {
        for (const bad of FORBIDDEN) {
          expect(spec, `${file} imports forbidden "${spec}"`).not.toMatch(bad)
        }
        if (spec.startsWith('.')) {
          const base = resolve(dirname(file), spec)
          queue.push(base.endsWith('.ts') ? base : `${base}.ts`)
        }
      }
    }
    // sanity: the walk actually traversed into the shared pipeline
    expect([...seen].some((f) => f.endsWith('runtime/model-catalog.ts'))).toBe(true)
  })
})
