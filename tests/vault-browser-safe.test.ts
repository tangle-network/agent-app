import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as vaultServer from '../src/vault/server'

/**
 * The vault client surface (`VaultPane`, its lazy split, `ConfirmDialog`) ships
 * in client bundles. The server policy sibling (`./vault/server` — blast-radius
 * deletion refusal + filesystem-incarnation comparison) must never be
 * reachable from that graph: one careless import and every vault consumer
 * ships policy code (harmless here, but the pattern is what matters) into the
 * browser. Same walk as tests/interactions-browser-safe.test.ts and
 * tests/work-product-browser-safe.test.ts.
 */
const FORBIDDEN_SPECIFIERS = [/^node:/, /^@tangle-network\/(agent-runtime|agent-eval|sandbox)(\/|$)/, /^child_process$/, /^fs$/, /^util$/]
const SERVER_ONLY_FILES = [/src\/vault\/server\.ts$/]

const CLIENT_ENTRIES = ['../src/vault/VaultPane.tsx', '../src/vault/lazy.tsx', '../src/vault/ConfirmDialog.tsx']

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

describe('vault client-surface browser-safety', () => {
  it('reaches no node builtins, engine runtimes, or the server-only policy module', () => {
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
    // Sanity: the walk actually traversed beyond the lazy entry into the pane.
    expect([...seen].some((file) => file.endsWith('vault/VaultPane.tsx'))).toBe(true)
  })

  it('src/vault/server.ts has zero import statements (import-free by construction)', () => {
    const src = readFileSync(resolve(__dirname, '../src/vault/server.ts'), 'utf8')
    const importStatements = [...src.matchAll(/^\s*import\b/gm)]
    expect(importStatements.length, 'server.ts must have zero import statements').toBe(0)
  })

  it('exports run correctly with no DOM globals present', () => {
    expect(typeof globalThis.window).toBe('undefined')
    expect(typeof globalThis.document).toBe('undefined')

    const deletion = vaultServer.assessVaultDeletionBatch({
      baselinePaths: ['a', 'b'],
      proposedDeletions: ['a'],
    })
    expect(deletion.allowed).toBe(true)
    expect(deletion.deletionRatio).toBeCloseTo(0.5)

    const incarnation = vaultServer.compareIncarnationBaseline('inc-1', {
      filesystemIncarnationId: 'inc-1',
      filesystemIncarnationProvenance: 'fresh',
      filesystemIncarnationReadiness: 'ready',
    })
    expect(incarnation).toEqual({ verdict: 'match' })

    expect(vaultServer.VAULT_DELETION_REFUSAL_RATIO).toBe(0.75)
    expect(vaultServer.VAULT_DELETION_REFUSAL_MIN_LIVE_FILES).toBe(10)
  })
})
