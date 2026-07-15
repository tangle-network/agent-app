import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Browser-safe subpath manifest (generalizes the old catalog-only walker).
 * Client components import these subpaths directly; if anything reachable from
 * one gains a Node-only or agent-runtime import, every consumer's client
 * bundle crashes on module load (legal-agent #256, tax-agent #372). Walk each
 * entrypoint's source import graph and fail loud on the first unsafe edge.
 *
 * Deliberately EXCLUDED (server-side by design, Node imports are fine there):
 * runtime, sandbox, billing, tangle, eval, eval-campaign, store, platform,
 * teams (non-react), preset-cloudflare, tools, missions, knowledge,
 * knowledge-loop, skills, profile, run, harness drizzle/api entries, config,
 * composer, assistant, model-resolution, integrations, intakes (non-react),
 * sequences (non-react), design-canvas (non-react), vault, brand-extraction.
 */
const BROWSER_SAFE_ENTRYPOINTS: Record<string, string> = {
  catalog: 'src/catalog/index.ts',
  'web-react': 'src/web-react/index.tsx',
  theme: 'src/theme/index.ts',
  stream: 'src/stream/index.ts',
  trace: 'src/trace/index.ts',
  redact: 'src/redact/index.ts',
  crypto: 'src/crypto/index.ts',
  web: 'src/web/index.ts',
  harness: 'src/harness/index.ts',
  'sequences-react': 'src/sequences-react/index.ts',
  'design-canvas-react': 'src/design-canvas-react/index.ts',
  'intakes-react': 'src/intakes-react/index.ts',
  'teams-react': 'src/teams-react/index.ts',
  'studio-react': 'src/studio-react/index.tsx',
}

const FORBIDDEN = [/^node:/, /^@tangle-network\/agent-runtime/, /^child_process$/, /^fs$/, /^util$/]

/** Static + dynamic + side-effect import specifiers in a source file. */
function importSpecs(src: string): string[] {
  const specs: string[] = []
  for (const re of [
    /from\s+['"]([^'"]+)['"]/g, // import/export ... from '...'
    /import\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import('...')
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g, // side-effect import '...'
  ]) {
    for (const m of src.matchAll(re)) if (m[1]) specs.push(m[1])
  }
  return specs
}

/** Resolve a relative specifier to a real .ts/.tsx file, or null. */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  const candidates = /\.(ts|tsx)$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

function walk(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [resolve(__dirname, '..', entry)]
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
      for (const bad of FORBIDDEN) {
        expect(spec, `${file} imports forbidden "${spec}"`).not.toMatch(bad)
      }
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec)
        // An unresolvable local import means the walk has a blind spot — fail
        // loud instead of silently skipping a subtree.
        expect(next, `${file} has unresolvable local import "${spec}"`).not.toBeNull()
        queue.push(next!)
      }
    }
  }
  return seen
}

describe('browser-safe subpath manifest', () => {
  for (const [name, entry] of Object.entries(BROWSER_SAFE_ENTRYPOINTS)) {
    it(`${name} reaches no node builtins or agent-runtime imports`, () => {
      const seen = walk(entry)
      expect(seen.size).toBeGreaterThan(0)
    })
  }

  it('the walk traverses into shared files, not just the entry module', () => {
    // catalog re-exports the model catalogue pipeline shared with /runtime;
    // if the traversal ever stops at the entry file this canary goes red.
    const catalog = walk(BROWSER_SAFE_ENTRYPOINTS.catalog!)
    expect([...catalog].some((f) => f.endsWith('runtime/model-catalog.ts'))).toBe(true)
    // web-react must pull in the chat-stream + interactions modules.
    const webReact = walk(BROWSER_SAFE_ENTRYPOINTS['web-react']!)
    expect([...webReact].some((f) => f.endsWith('web-react/chat-stream.ts'))).toBe(true)
    expect([...webReact].some((f) => f.endsWith('web-react/chat-interactions.ts'))).toBe(true)
  })

  it('every *-react subpath in src/ is covered by the manifest', () => {
    const src = resolve(__dirname, '../src')
    const reactDirs = readdirSync(src, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('-react'))
      .map((d) => d.name)
    for (const dir of reactDirs) {
      expect(
        BROWSER_SAFE_ENTRYPOINTS[dir],
        `src/${dir} exists but is missing from the browser-safe manifest`,
      ).toBeDefined()
    }
  })
})
