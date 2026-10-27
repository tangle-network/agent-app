/**
 * `@tangle-network/agent-app/worker-build` — the chunk rules for a Worker that
 * `@cloudflare/vite-plugin` builds in the `ssr` environment.
 *
 * Cloudflare evaluates a Worker's chunks in import order. When two chunks
 * import each other, one of them runs before the chunk it reads, and the Worker
 * crashes at startup (`Cannot read properties of undefined`) or survives only
 * because of the order the chunks happen to load in. agent-interface is the
 * package every agent app bundles that Rolldown splits across chunks, so
 * {@link workerChunkGraph} puts all of it in one chunk and then fails the build
 * on any static chunk cycle that remains.
 *
 * The plugin is type-only coupled to `vite`; the app that calls it already
 * installs Vite.
 */

import type { Plugin } from 'vite'

/** Every module of the agent-interface package, matched by its install path. */
const AGENT_INTERFACE_MODULES = /[\\/]@tangle-network[\\/]agent-interface[\\/]/

interface ChunkNode {
  fileName: string
  imports: readonly string[]
  moduleIds: readonly string[]
}

/**
 * Put every `@tangle-network/agent-interface` module of the Worker bundle in
 * one chunk, and fail the build when the bundle has a static chunk cycle.
 *
 * The group sets `maxSize: Infinity` so an app's global `codeSplitting.maxSize`
 * cannot split the package again: measured on gtm-agent, a 450 KB global limit
 * cut it into 7 chunks that imported each other. Priority 90 leaves the modules
 * of an app's own higher-priority groups (a polyfill group at 100, say) to them.
 */
export function workerChunkGraph(): Plugin {
  return {
    name: 'agent-app:worker-chunk-graph',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'ssr',
    configEnvironment(name) {
      if (name !== 'ssr') return
      return {
        build: {
          rolldownOptions: {
            output: {
              codeSplitting: {
                groups: [{ name: 'agent-interface', test: AGENT_INTERFACE_MODULES, priority: 90, maxSize: Infinity }],
              },
            },
          },
        },
      }
    },
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((item) => (item.type === 'chunk' ? [item] : []))
      const cycles = findChunkCycles(chunks)
      if (cycles.length === 0) return
      const lines = cycles.map((cycle) => `  - ${cycle.map((chunk) => `${chunk.fileName} (${chunk.moduleIds.length} modules)`).join(', ')}`)
      this.error(
        `The ssr bundle has ${cycles.length} static chunk cycle${cycles.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n`
          + 'Cloudflare evaluates a Worker\'s chunks in import order, so a chunk in a cycle can run before the chunk it reads and crash at startup. '
          + 'Put the modules that form the cycle in one chunk with a codeSplitting group, as workerChunkGraph does for @tangle-network/agent-interface.',
      )
    },
  }
}

/** The groups of chunks that import one another through static imports (Tarjan's strongly connected components of size 2 or more). */
function findChunkCycles(chunks: readonly ChunkNode[]): ChunkNode[][] {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const open: string[] = []
  const onStack = new Set<string>()
  const cycles: ChunkNode[][] = []
  let next = 0

  const visit = (name: string): void => {
    index.set(name, next)
    lowlink.set(name, next)
    next += 1
    open.push(name)
    onStack.add(name)
    for (const target of byName.get(name)?.imports ?? []) {
      if (!byName.has(target)) continue
      if (!index.has(target)) {
        visit(target)
        lowlink.set(name, Math.min(lowlink.get(name)!, lowlink.get(target)!))
      } else if (onStack.has(target)) {
        lowlink.set(name, Math.min(lowlink.get(name)!, index.get(target)!))
      }
    }
    if (lowlink.get(name) !== index.get(name)) return
    const members: ChunkNode[] = []
    for (let member = open.pop()!; ; member = open.pop()!) {
      onStack.delete(member)
      members.push(byName.get(member)!)
      if (member === name) break
    }
    if (members.length > 1) cycles.push(members.reverse())
  }

  for (const chunk of chunks) if (!index.has(chunk.fileName)) visit(chunk.fileName)
  return cycles
}
