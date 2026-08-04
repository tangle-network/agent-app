import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createOpenUIActionRoute } from '../../src/openui/index'

/**
 * The promise this module makes is economic: a user dragging a slider on a page
 * the agent wrote pays one product request, not a model turn. That is only true
 * while the code has no way to start one, so this file checks the property
 * mechanically instead of trusting the doc comment.
 *
 * Two guards. First, nothing reachable from `./openui` or `./openui-react` may
 * import a module that can drive a turn (the runtime, the sandbox, the turn
 * stream, the chat routes, the interaction sidecar — whose whole job is to
 * UNBLOCK a running turn). Second, a full successful action calls exactly the
 * product seams it is documented to call, and no others.
 */

const ROOT = resolve(__dirname, '../..')

const ENTRIES = ['src/openui/index.ts', 'src/openui-react/index.tsx']

/** Packages and modules that can cause a model turn or wake a sandbox. */
const TURN_CAPABLE = [
  /^@tangle-network\/agent-runtime/,
  /^@tangle-network\/sandbox(\/|$)/,
  /^@tangle-network\/agent-eval/,
  /src\/runtime\//,
  /src\/turn-stream\//,
  /src\/turn-health\//,
  /src\/chat-routes\//,
  /src\/interactions\//,
  /src\/missions\//,
  /src\/web-react\/chat-stream/,
]

function importSpecs(src: string): string[] {
  const specs: string[] = []
  for (const re of [
    /from\s+['"]([^'"]+)['"]/g, // import/export … from '…'
    /import\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import('…')
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g, // side-effect import '…'
  ]) {
    for (const m of src.matchAll(re)) if (m[1]) specs.push(m[1])
  }
  return specs
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  const candidates = /\.(ts|tsx)$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

function walk(entry: string): { files: string[]; external: string[] } {
  const files = new Set<string>()
  const external: string[] = []
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const spec of importSpecs(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec)
        expect(next, `${file} has an unresolvable local import "${spec}"`).not.toBeNull()
        queue.push(next!)
      } else {
        external.push(spec)
      }
    }
  }
  return { files: [...files], external }
}

describe('agent-authored UI costs no model turn', () => {
  for (const entry of ENTRIES) {
    it(`${entry} reaches nothing that can start a turn`, () => {
      const { files, external } = walk(resolve(ROOT, entry))
      expect(files.length).toBeGreaterThan(1)
      const reached = [...files.map((f) => relative(ROOT, f)), ...external]
      for (const spec of reached) {
        for (const forbidden of TURN_CAPABLE) {
          expect(spec, `${entry} reaches turn-capable "${spec}"`).not.toMatch(forbidden)
        }
      }
    })
  }

  it('a successful action calls the product seams and nothing else', async () => {
    const calls: string[] = []
    const route = createOpenUIActionRoute<{ workspaceId: string }>({
      resolve: () => {
        calls.push('resolve')
        return { ok: true, context: { workspaceId: 'w1' } }
      },
      actions: {
        recalculate: () => {
          calls.push('handler')
          return { ok: true, data: { total: 1 } }
        },
      },
      recordForAgent: () => {
        calls.push('recordForAgent')
      },
    })

    // A global fetch here would be the only way this module could reach an LLM
    // provider or a sandbox; it must never be touched.
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    const response = await route.handle(
      new Request('https://app.example/api/openui/action', {
        method: 'POST',
        body: JSON.stringify({ actionId: 'recalculate', values: { amount: 1 } }),
      }),
    )
    expect(response.status).toBe(200)
    expect(calls).toEqual(['resolve', 'handler', 'recordForAgent'])
    expect(globalFetch).not.toHaveBeenCalled()
    globalFetch.mockRestore()
  })
})
