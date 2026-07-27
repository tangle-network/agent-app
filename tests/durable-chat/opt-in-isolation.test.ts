/**
 * `/durable-chat` stays substrate-free; only `/durable-chat/drizzle` touches a
 * database.
 *
 * This matters because the pure module IS re-exported from the package root
 * (`src/index.ts`), unlike `/intakes`, whose whole module is opt-in. So a single
 * stray `./drizzle` import inside `src/durable-chat/index.ts` would drag the
 * optional `drizzle-orm` peer into every consumer of the bare entry point — a
 * hard install failure for products that never touch a database.
 *
 * Source-level guards always run. The built-artifact guards self-skip before a
 * build rather than silently passing.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')

/** A real `from '<module>'` / `import '<module>'` statement, not a prose mention. */
function importsFrom(source: string, moduleName: string): boolean {
  const escaped = moduleName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
  return new RegExp(`from\\s*['"]${escaped}(/[^'"]*)?['"]|import\\s*['"]${escaped}(/[^'"]*)?['"]`).test(source)
}

const PURE_MODULES = [
  'src/durable-chat/index.ts',
  'src/durable-chat/types.ts',
  'src/durable-chat/memory.ts',
  'src/durable-chat/errors.ts',
  'src/durable-chat/interactions.ts',
  'src/durable-chat/adapters.ts',
  'src/durable-chat/plan-routes.ts',
]

describe('durable-chat drizzle isolation — source', () => {
  it('no pure module imports drizzle-orm', () => {
    for (const file of PURE_MODULES) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(importsFrom(source, 'drizzle-orm'), `${file} must not import drizzle-orm`).toBe(false)
    }
  })

  it('the ./durable-chat barrel does not re-export the drizzle subpath', () => {
    const source = readFileSync(resolve(root, 'src/durable-chat/index.ts'), 'utf8')
    expect(source).not.toMatch(/['"]\.\/drizzle/)
  })

  it('the root barrel does not re-export the drizzle subpath', () => {
    // The PURE module is intentionally re-exported at root; the drizzle one
    // never may be.
    const source = readFileSync(resolve(root, 'src/index.ts'), 'utf8')
    expect(source).toMatch(/['"]\.\/durable-chat\/index['"]/)
    expect(source).not.toMatch(/['"]\.\/durable-chat\/drizzle['"]/)
  })

  it('is declared as its own build entry and export subpath', () => {
    const tsup = readFileSync(resolve(root, 'tsup.config.ts'), 'utf8')
    expect(tsup).toContain("'durable-chat/drizzle': 'src/durable-chat/drizzle.ts'")
    // drizzle must stay external so it is never bundled into the artifact.
    expect(tsup).toMatch(/external:[\s\S]*'drizzle-orm'/)

    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; import: string }>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    expect(pkg.exports['./durable-chat/drizzle']).toEqual({
      types: './dist/durable-chat/drizzle.d.ts',
      import: './dist/durable-chat/drizzle.js',
      default: './dist/durable-chat/drizzle.js',
    })
    // The whole isolation argument rests on drizzle being an OPTIONAL peer.
    expect(pkg.peerDependenciesMeta?.['drizzle-orm']?.optional).toBe(true)
  })
})

describe('durable-chat drizzle isolation — built artifacts', () => {
  const pureDist = resolve(root, 'dist/durable-chat/index.js')
  const drizzleDist = resolve(root, 'dist/durable-chat/drizzle.js')

  it.runIf(existsSync(pureDist))('the pure artifact pulls no drizzle and no store code', () => {
    const built = readFileSync(pureDist, 'utf8')
    expect(importsFrom(built, 'drizzle-orm')).toBe(false)
    expect(built).not.toContain('createDurableChatTables')
    expect(built).not.toContain('createDrizzleDurableChatStore')
  })

  it.runIf(existsSync(drizzleDist))('the drizzle artifact keeps drizzle external', () => {
    const built = readFileSync(drizzleDist, 'utf8')
    expect(importsFrom(built, 'drizzle-orm')).toBe(true)
    expect(built).toContain('createDurableChatTables')
  })
})
