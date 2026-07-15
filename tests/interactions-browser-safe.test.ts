import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The interaction UI (cards, hook, contract shim) ships in client bundles via
 * `./web-react`. The server half of `./interactions` (sidecar client + answer
 * route) holds the sidecar bearer and must never be reachable from that graph —
 * one careless import and every consumer ships the token-handling code to the
 * browser. Walk the source import graph from each client entry and fail loud
 * on the first unsafe edge (same guard as catalog-browser-safe).
 */
const FORBIDDEN_SPECIFIERS = [/^node:/, /^@tangle-network\/(agent-runtime|sandbox)/, /^child_process$/, /^fs$/, /^util$/]
const SERVER_ONLY_FILES = [/src\/interactions\/sidecar\.ts$/, /src\/interactions\/route\.ts$/]

const CLIENT_ENTRIES = [
  '../src/web-react/chat-interactions.ts',
  '../src/web-react/interaction-card-support.ts',
  '../src/web-react/interaction-question-card.tsx',
  '../src/web-react/interaction-plan-card.tsx',
  '../src/web-react/use-chat-interactions.ts',
]

function localImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].flatMap((m) => (m[1] ? [m[1]] : []))
}

function resolveLocal(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec)
  if (/\.(ts|tsx)$/.test(base)) return base
  for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // try next extension
    }
  }
  throw new Error(`cannot resolve local import "${spec}" from ${fromFile}`)
}

describe('interaction client-surface browser-safety', () => {
  it('reaches no node builtins, sandbox/runtime imports, or the server-only sidecar/route modules', () => {
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
    // sanity: the walk actually traversed into the shared contract
    expect([...seen].some((f) => f.endsWith('interactions/contract.ts'))).toBe(true)
  })
})
