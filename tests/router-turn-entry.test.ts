import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `./router-turn` is the Worker entry for the Router engine. The `./runtime`
 * barrel also re-exports modules that import `@tangle-network/agent-runtime`'s
 * intelligence and candidate-execution chunks, which import the full Sandbox
 * SDK and `viem`; a Worker bundle importing the barrel fails to build
 * (hospitality-agent #353, 2026-10-11: `Could not resolve "viem"`). This walks
 * the entry's import graph and allows only relative files, the tool loop, placement
 * (a pure decision module with no imports), and the two import-free modules turn
 * tracing uses: agent-trace-contract's OTLP encoding and agent-core's Server-Timing
 * codec.
 */
const ALLOWED_PACKAGES = new Set([
  '@tangle-network/agent-runtime/tool-loop',
  '@tangle-network/agent-runtime/placement',
  '@tangle-network/agent-trace-contract/otlp',
  '@tangle-network/agent-core/server-timing',
])

const SRC = new URL('../src/', import.meta.url).pathname

function imports(file: string): string[] {
  const source = readFileSync(resolve(SRC, file), 'utf8')
  // `from 'x'` (static import/export), bare `import 'x'`, and dynamic `import('x')`.
  return [...source.matchAll(/(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm)].map(match => match[1]!)
}

describe('./router-turn entry', () => {
  it('reaches only relative modules and the agent-runtime tool loop', () => {
    const seen = new Set<string>()
    const packages = new Set<string>()
    const queue = ['runtime/router-turn.ts']
    while (queue.length) {
      const file = queue.shift()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const target of imports(file)) {
        if (target.startsWith('.')) queue.push(relative(SRC, resolve(SRC, file, '..', `${target}.ts`)))
        else packages.add(target)
      }
    }
    expect([...packages].filter(name => !ALLOWED_PACKAGES.has(name))).toEqual([])
  })
})
