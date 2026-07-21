import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Browser-safe subpath manifest — enumerated from package.json `exports`, not a
 * top-level `*-react` readdir. Client components import these subpaths directly;
 * if anything reachable from one gains a Node-only or agent-runtime import,
 * every consumer's client bundle crashes on module load (legal-agent #256,
 * tax-agent #372). The old readdir walked only top-level `*-react` DIRS, so
 * NESTED browser entries (`web-react/terminal`, `design-canvas-react/engine`,
 * every `*-react/lazy`, `vault/lazy`) were never checked — the exact blind spot
 * that reopens the crash class. This derives the set straight from the shipped
 * `exports` map instead, so a new nested react/lazy entry is covered the moment
 * it is published.
 *
 * Server-side subpaths (Node imports fine there) are simply not browser-intended
 * and are excluded by the predicate below: runtime, sandbox, billing, tangle,
 * eval(-campaign), store, platform, teams(non-react), preset-cloudflare, tools,
 * missions, knowledge(-loop), skills, profile, run, config, composer, assistant,
 * model-resolution, integrations, intakes/design-canvas/sequences (non-react),
 * vault (non-lazy), brand-extraction, theme-contract (reads fs).
 */

const ROOT = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, { import?: string; default?: string } | string>
}

/** Non-react subpaths a client bundle imports directly (pure mechanism / data,
 *  no engine, no node builtins). Kept explicit — these are stable and few; the
 *  react/lazy family is derived dynamically below. */
const BROWSER_NONREACT = new Set([
  'catalog',
  'theme',
  'stream',
  'trace',
  'redact',
  'crypto',
  'web',
  'harness',
  'plans',
])

/** Browser-intended when a client bundle imports it: the whole `*-react` family
 *  (incl. nested `/engine`, `/lazy`, `/terminal`), any `/lazy` split
 *  (browser-safe by construction), or a known pure-mechanism subpath. */
function isBrowserIntended(subpath: string): boolean {
  return /-react(\/|$)/.test(subpath) || subpath.endsWith('/lazy') || BROWSER_NONREACT.has(subpath)
}

function importTarget(entry: { import?: string; default?: string } | string): string | undefined {
  return typeof entry === 'string' ? entry : entry.import ?? entry.default
}

/** `./dist/x/y.js` → the `src/x/y.{ts,tsx}` that produced it, or null. */
function distToSrc(target: string): string | null {
  const m = target.match(/^\.\/dist\/(.+)\.js$/)
  if (!m) return null
  for (const ext of ['ts', 'tsx']) {
    const candidate = resolve(ROOT, 'src', `${m[1]}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

// { subpath -> src file } for every browser-intended export.
const BROWSER_SAFE_ENTRYPOINTS: Record<string, string> = {}
/** Browser-intended `.js` exports whose src file could not be resolved — a
 *  walk blind spot; asserted empty below. */
const UNRESOLVED: string[] = []
for (const [key, entry] of Object.entries(pkg.exports)) {
  const subpath = key.replace(/^\.\/?/, '') // "./web-react" -> "web-react", "." -> ""
  if (!subpath || !isBrowserIntended(subpath)) continue
  const target = importTarget(entry)
  if (!target || target.endsWith('.css')) continue // CSS assets are not import graphs
  const src = distToSrc(target)
  if (!src) {
    UNRESOLVED.push(`${key} -> ${target}`)
    continue
  }
  BROWSER_SAFE_ENTRYPOINTS[subpath] = src
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
  const queue = [entry]
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
  it('every browser-intended export resolves to a source file (no walk blind spot)', () => {
    expect(UNRESOLVED, `unresolved browser-intended exports: ${UNRESOLVED.join(', ')}`).toEqual([])
    expect(Object.keys(BROWSER_SAFE_ENTRYPOINTS).length).toBeGreaterThan(0)
  })

  for (const [name, entry] of Object.entries(BROWSER_SAFE_ENTRYPOINTS)) {
    it(`${name} reaches no node builtins or agent-runtime imports`, () => {
      const seen = walk(entry)
      expect(seen.size).toBeGreaterThan(0)
    })
  }

  it('covers the nested react/lazy entries the old readdir missed (#256/#372 class)', () => {
    for (const required of [
      'web-react/terminal',
      'design-canvas-react/engine',
      'design-canvas-react/lazy',
      'teams-react/lazy',
      'intakes-react/lazy',
      'vault/lazy',
    ]) {
      expect(
        BROWSER_SAFE_ENTRYPOINTS[required],
        `${required} exists in exports but is missing from the browser-safe manifest`,
      ).toBeDefined()
    }
  })

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
})
