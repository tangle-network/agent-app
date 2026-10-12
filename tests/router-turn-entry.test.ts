import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `./router-turn` is the Worker entry for the Router engine. The `./runtime`
 * barrel also re-exports modules that import `@tangle-network/agent-runtime`'s
 * intelligence and candidate-execution chunks, which import the full Sandbox
 * SDK and `viem`; a Worker bundle importing the barrel fails to build
 * (hospitality-agent #353, 2026-10-11: `Could not resolve "viem"`). This walks
 * the entry's import graph and allows only relative files, the tool loop and placement
 * (a pure decision module with no imports).
 */
const ALLOWED_PACKAGES = new Set(['@tangle-network/agent-runtime/tool-loop', '@tangle-network/agent-runtime/placement'])

function imports(file: string): string[] {
  const source = readFileSync(new URL(`../src/runtime/${file}`, import.meta.url), 'utf8')
  // `from 'x'` (static import/export), bare `import 'x'`, and dynamic `import('x')`.
  return [...source.matchAll(/(?:\bfrom\s+|^\s*import\s+|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm)].map(match => match[1]!)
}

describe('./router-turn entry', () => {
  it('reaches only relative modules and the agent-runtime tool loop', () => {
    const seen = new Set<string>()
    const packages = new Set<string>()
    const queue = ['router-turn.ts']
    while (queue.length) {
      const file = queue.shift()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const target of imports(file)) {
        if (target.startsWith('./')) queue.push(`${target.slice(2)}.ts`)
        else packages.add(target)
      }
    }
    expect([...seen].sort()).toEqual(['loop.ts', 'model-catalog.ts', 'model.ts', 'openai-stream.ts', 'reply-language.ts', 'router-turn.ts', 'turn-continuation.ts', 'turn-knowledge.ts'])
    expect([...packages].filter(name => !ALLOWED_PACKAGES.has(name))).toEqual([])
  })
})
