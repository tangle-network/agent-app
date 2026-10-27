import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, type Rolldown } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import { workerChunkGraph } from '../../src/worker-build/index'

/**
 * Real Vite builds of a small ssr project: the plugin must keep the
 * agent-interface package in one chunk against an app's global chunk size
 * limit, and must refuse a bundle whose chunks import each other.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'worker-build-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return root
}

/** A module of a given size that exports `name` and imports its `uses`. */
function module(name: string, uses: string[] = []): string {
  const imports = uses.map((use) => `import { ${use} } from './${use}.js'`).join('\n')
  return `${imports}\nexport const ${name} = () => [${uses.map((use) => `${use}()`).join(', ')}].join('${'x'.repeat(400)}')\n`
}

async function buildSsr(root: string, options: { plugin: boolean; groups?: Rolldown.CodeSplittingGroup[]; maxSize?: number }) {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: options.plugin ? [workerChunkGraph()] : [],
    build: {
      ssr: 'entry.js',
      write: false,
      minify: false,
      rolldownOptions: { output: { codeSplitting: { maxSize: options.maxSize, groups: options.groups ?? [] } } },
    },
  })
  const outputs = Array.isArray(result) ? result : [result as Rolldown.RolldownOutput]
  return outputs.flatMap((output) => output.output).filter((item): item is Rolldown.OutputChunk => item.type === 'chunk')
}

describe('workerChunkGraph', () => {
  it('keeps every agent-interface module in one chunk under an app-wide chunk size limit', async () => {
    const interfaceDir = 'node_modules/@tangle-network/agent-interface'
    const root = project({
      'entry.js': `import { one } from './${interfaceDir}/one.js'\nimport { two } from './${interfaceDir}/two.js'\nimport { three } from './${interfaceDir}/three.js'\nexport default { fetch: () => new Response([one(), two(), three()].join('')) }\n`,
      [`${interfaceDir}/one.js`]: module('one'),
      [`${interfaceDir}/two.js`]: module('two'),
      [`${interfaceDir}/three.js`]: module('three'),
    })

    const chunks = await buildSsr(root, { plugin: true, maxSize: 600 })

    const holding = chunks.filter((chunk) => chunk.moduleIds.some((id) => id.includes('/@tangle-network/agent-interface/')))
    expect(holding.map((chunk) => chunk.name)).toEqual(['agent-interface'])
    expect(holding[0]!.moduleIds.filter((id) => id.includes('/@tangle-network/agent-interface/'))).toHaveLength(3)
  })

  it('fails the build when two chunks import each other', async () => {
    const root = project({
      'entry.js': `import { a } from './a.js'\nexport default { fetch: () => new Response(a()) }\n`,
      'a.js': module('a', ['b']),
      'b.js': module('b', ['c']),
      'c.js': module('c'),
    })
    const cycle: Rolldown.CodeSplittingGroup[] = [
      { name: 'ends', test: /[\\/](?:a|c)\.js$/, includeDependenciesRecursively: false },
      { name: 'middle', test: /[\\/]b\.js$/, includeDependenciesRecursively: false },
    ]

    const unchecked = await buildSsr(root, { plugin: false, groups: cycle })
    expect(unchecked.map((chunk) => chunk.name).sort()).toEqual(expect.arrayContaining(['ends', 'middle']))

    await expect(buildSsr(root, { plugin: true, groups: cycle })).rejects.toThrow(/1 static chunk cycle/)
  })
})
