/**
 * The whole point of the intakes module: it is OPT-IN by construction. A consumer
 * must reach for `@tangle-network/agent-app/intakes` explicitly, and nothing they
 * get by default may pull intakes code or the optional `drizzle-orm` peer.
 *
 * Until 0.44.0 that guarantee was enforced against the root barrel (`.`), which
 * had to be checked for `./intakes` re-exports. The barrel is gone — `.` is no
 * longer an entry point at all — so the guarantee is now unconditional and the
 * test asserts the stronger fact: there is no bare entry to leak through.
 * The remaining tests prove the pure `./intakes` leaf SOURCE imports no
 * drizzle / react / env, that the drizzle subpath is the one real boundary, and
 * that no built entry outside `./intakes*` can REACH intakes code through the
 * emitted import graph.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(__dirname, '../..')

describe('opt-in by construction — there is no root barrel to leak through', () => {
  it('src/index.ts does not exist', () => {
    expect(existsSync(resolve(root, 'src/index.ts'))).toBe(false)
  })

  it('tsup builds no root entry', () => {
    const config = readFileSync(resolve(root, 'tsup.config.ts'), 'utf8')
    expect(config).not.toMatch(/^\s*index:\s*'src\/index\.ts'/m)
  })

  it('package.json exports no "." subpath', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      main?: string
      types?: string
    }
    expect(Object.keys(pkg.exports)).not.toContain('.')
    expect(pkg.main).toBeUndefined()
    expect(pkg.types).toBeUndefined()
  })
})

/** A `from '<module>'` / `import ... '<module>'` statement, not a prose mention. */
function importsFrom(source: string, moduleName: string): boolean {
  const escaped = moduleName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
  return new RegExp(`from\\s*['"]${escaped}(/[^'"]*)?['"]|import\\s*['"]${escaped}(/[^'"]*)?['"]`).test(source)
}

describe('pure leaf source — no heavy imports', () => {
  it('src/intakes/model.ts imports nothing', () => {
    const source = readFileSync(resolve(root, 'src/intakes/model.ts'), 'utf8')
    expect(source).not.toMatch(/^import\s/m)
    expect(importsFrom(source, 'drizzle-orm')).toBe(false)
    expect(importsFrom(source, 'react')).toBe(false)
  })

  it('src/intakes/completion.ts imports only the pure model', () => {
    const source = readFileSync(resolve(root, 'src/intakes/completion.ts'), 'utf8')
    expect(importsFrom(source, 'drizzle-orm')).toBe(false)
    expect(importsFrom(source, 'react')).toBe(false)
    expect(source).toMatch(/\.\/model/)
  })

  it('the ./intakes barrel imports neither drizzle nor react', () => {
    const source = readFileSync(resolve(root, 'src/intakes/index.ts'), 'utf8')
    expect(importsFrom(source, 'drizzle-orm')).toBe(false)
    expect(importsFrom(source, 'react')).toBe(false)
    expect(source).toMatch(/\.\/model/)
    expect(source).toMatch(/\.\/completion/)
  })
})

describe('drizzle isolation — DB code lives behind /intakes/drizzle', () => {
  it('the pure leaf files never import drizzle-orm', () => {
    for (const file of ['src/intakes/model.ts', 'src/intakes/completion.ts', 'src/intakes/index.ts']) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(importsFrom(source, 'drizzle-orm'), `${file} must not import drizzle-orm`).toBe(false)
    }
  })

  it('the drizzle subpath DOES import drizzle-orm (it is the boundary)', () => {
    const source = readFileSync(resolve(root, 'src/intakes/drizzle/schema.ts'), 'utf8')
    expect(importsFrom(source, 'drizzle-orm')).toBe(true)
  })
})

const INTAKE_SYMBOLS = /createIntakeTables|createUserIntakeStore|createIntakeApi|IntakeInterview/
const intakesIndex = resolve(root, 'dist/intakes/index.js')
const drizzleChunk = resolve(root, 'dist/intakes/drizzle.js')

/** Every built entry a consumer can import that is NOT an intakes subpath. */
function nonIntakesEntries(): { subpath: string; file: string }[] {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>
  }
  const entries: { subpath: string; file: string }[] = []
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    if (subpath.startsWith('./intakes')) continue
    if (typeof value !== 'object' || value === null) continue
    const target = (value as { import?: unknown }).import
    if (typeof target !== 'string') continue
    entries.push({ subpath, file: resolve(root, target.replace(/^\.\//, '')) })
  }
  return entries
}

/** A relative `from '…'` / `import '…'` specifier in emitted ESM. Chunk splitting
 *  puts intakes code in shared `dist/chunk-*.js` files, so a content scan of the
 *  entry file alone proves nothing — the tax is only absent if it is unreachable
 *  through the import graph. */
const RELATIVE_SPECIFIER = /(?:from|import)\s*['"](\.[^'"]*)['"]/g

function reachableFiles(entryFile: string): string[] {
  const seen = new Set<string>()
  const queue = [entryFile]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
      const specifier = match[1]
      if (specifier !== undefined) queue.push(resolve(dirname(file), specifier))
    }
  }
  return [...seen]
}

describe('built artifacts — the tax stays clean', () => {
  // Require the built tree instead of skipping when it is absent: a gate keyed
  // on an artifact's existence reports safety it does not provide the moment
  // that artifact's name changes. `dist/` is written by `prepare` on install and
  // by `pnpm build`, the same contract the scaffolder tests rely on.
  beforeAll(() => {
    if (!existsSync(intakesIndex) || !existsSync(drizzleChunk)) {
      throw new Error('dist/ not built — run `pnpm build` before this test')
    }
  })

  it('no entry outside ./intakes can reach intakes code', () => {
    const entries = nonIntakesEntries()
    expect(entries.length).toBeGreaterThan(50)

    const leaks: string[] = []
    for (const entry of entries) {
      expect(existsSync(entry.file), `${entry.subpath} is not built`).toBe(true)
      for (const file of reachableFiles(entry.file)) {
        if (INTAKE_SYMBOLS.test(readFileSync(file, 'utf8'))) {
          leaks.push(`${entry.subpath} -> ${file.replace(`${root}/`, '')}`)
        }
      }
    }
    expect(leaks).toEqual([])
  })

  it('the pure ./intakes chunk carries no drizzle-orm import', () => {
    const built = readFileSync(intakesIndex, 'utf8')
    expect(built).not.toMatch(/from\s*['"]drizzle-orm/)
  })

  it('the drizzle subpath chunk keeps drizzle-orm external (import, not bundled)', () => {
    const built = readFileSync(drizzleChunk, 'utf8')
    expect(built).toMatch(/from\s*['"]drizzle-orm/)
  })
})
