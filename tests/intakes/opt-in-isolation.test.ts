/**
 * The whole point of the intakes module: it is OPT-IN by construction. A
 * consumer that imports only `.` (the bare entry) must pull ZERO intakes code
 * and must NOT require the optional `drizzle-orm` peer. These tests prove that
 * three ways:
 *   1. The root barrel SOURCE re-exports nothing from `./intakes*`.
 *   2. The built `.` artifact contains no intakes symbols and no drizzle-from-intakes.
 *   3. The pure `./intakes` leaf SOURCE imports no drizzle / react / env.
 * Tests 2-3 read built artifacts when present; they self-skip (not silently
 * pass) before a build, and the source-level guards (1, 3) always run.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')

describe('opt-in by construction — root barrel source', () => {
  it('src/index.ts re-exports nothing from intakes', () => {
    const source = readFileSync(resolve(root, 'src/index.ts'), 'utf8')
    expect(source).not.toMatch(/['"]\.\/intakes/)
    expect(source).not.toMatch(/intakes-react/)
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

const distIndex = resolve(root, 'dist/index.js')
const builtDescribe = existsSync(distIndex) ? describe : describe.skip

builtDescribe('built `.` artifact — the tax stays clean', () => {
  it('dist/index.js pulls no intakes chunk and no drizzle-from-intakes', () => {
    const built = readFileSync(distIndex, 'utf8')
    expect(built).not.toMatch(/createIntakeTables/)
    expect(built).not.toMatch(/createUserIntakeStore/)
    expect(built).not.toMatch(/createIntakeApi/)
    expect(built).not.toMatch(/IntakeInterview/)
    expect(built).not.toMatch(/from\s*['"]\.\/intakes/)
  })

  it('the pure ./intakes chunk carries no drizzle-orm import', () => {
    const intakesIndex = resolve(root, 'dist/intakes/index.js')
    if (!existsSync(intakesIndex)) return
    const built = readFileSync(intakesIndex, 'utf8')
    expect(built).not.toMatch(/from\s*['"]drizzle-orm/)
  })

  it('the drizzle subpath chunk keeps drizzle-orm external (import, not bundled)', () => {
    const drizzleChunk = resolve(root, 'dist/intakes/drizzle.js')
    if (!existsSync(drizzleChunk)) return
    const built = readFileSync(drizzleChunk, 'utf8')
    expect(built).toMatch(/from\s*['"]drizzle-orm/)
  })
})
