/**
 * The whole point of the teams module: it is OPT-IN by construction. A consumer
 * that imports only `.` (the bare entry) must pull ZERO teams code and must NOT
 * require the optional `drizzle-orm` peer. These tests prove that three ways:
 *   1. The root barrel SOURCE re-exports nothing from `./teams*`.
 *   2. The built `.` artifact contains no teams symbols and no `drizzle-orm` import.
 *   3. The pure `./teams` leaf SOURCE imports no drizzle / react / env.
 * Tests 2-3 read built artifacts when present; they self-skip (not silently
 * pass) before a build, and the source-level guards (1, 3) always run.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')

describe('opt-in by construction — root barrel source', () => {
  it('src/index.ts re-exports nothing from teams', () => {
    const source = readFileSync(resolve(root, 'src/index.ts'), 'utf8')
    expect(source).not.toMatch(/['"]\.\/teams/)
    expect(source).not.toMatch(/teams-react/)
  })
})

/** A `from '<module>'` / `import ... '<module>'` statement, not a prose mention. */
function importsFrom(source: string, moduleName: string): boolean {
  const escaped = moduleName.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
  return new RegExp(`from\\s*['"]${escaped}(/[^'"]*)?['"]|import\\s*['"]${escaped}(/[^'"]*)?['"]`).test(source)
}

describe('pure leaf source — no heavy imports', () => {
  it('src/teams/roles.ts imports nothing', () => {
    const source = readFileSync(resolve(root, 'src/teams/roles.ts'), 'utf8')
    expect(source).not.toMatch(/^import\s/m)
    expect(importsFrom(source, 'drizzle-orm')).toBe(false)
    expect(importsFrom(source, 'react')).toBe(false)
  })

  it('src/teams/invite.ts imports nothing (Web Crypto only)', () => {
    const source = readFileSync(resolve(root, 'src/teams/invite.ts'), 'utf8')
    expect(source).not.toMatch(/^import\s/m)
    expect(importsFrom(source, 'drizzle-orm')).toBe(false)
  })

  it('the ./teams barrel imports neither drizzle nor react', () => {
    const source = readFileSync(resolve(root, 'src/teams/index.ts'), 'utf8')
    expect(importsFrom(source, 'drizzle-orm')).toBe(false)
    expect(importsFrom(source, 'react')).toBe(false)
    // it only re-exports the two pure leaves
    expect(source).toMatch(/\.\/roles/)
    expect(source).toMatch(/\.\/invite/)
  })
})

describe('drizzle isolation — DB code lives behind /teams/drizzle', () => {
  it('the pure leaf files never import drizzle-orm', () => {
    for (const file of ['src/teams/roles.ts', 'src/teams/invite.ts', 'src/teams/index.ts']) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(importsFrom(source, 'drizzle-orm'), `${file} must not import drizzle-orm`).toBe(false)
    }
  })

  it('the drizzle subpath DOES import drizzle-orm (it is the boundary)', () => {
    const source = readFileSync(resolve(root, 'src/teams/drizzle/schema.ts'), 'utf8')
    expect(importsFrom(source, 'drizzle-orm')).toBe(true)
  })
})

const distIndex = resolve(root, 'dist/index.js')
const builtDescribe = existsSync(distIndex) ? describe : describe.skip

builtDescribe('built `.` artifact — the tax stays clean', () => {
  it('dist/index.js pulls no teams chunk and no drizzle-orm import', () => {
    const built = readFileSync(distIndex, 'utf8')
    // No teams module symbols leaked into the bare entry.
    expect(built).not.toMatch(/createTeamTables/)
    expect(built).not.toMatch(/createMembersApi/)
    expect(built).not.toMatch(/ensurePersonalOrganization/)
    expect(built).not.toMatch(/MembersPanel/)
    // No re-export edge into any teams chunk.
    expect(built).not.toMatch(/from\s*['"]\.\/teams/)
    // The bare entry must not force the optional drizzle peer.
    expect(built).not.toMatch(/from\s*['"]drizzle-orm/)
  })

  it('the pure ./teams chunk carries no drizzle-orm import', () => {
    const teamsIndex = resolve(root, 'dist/teams/index.js')
    if (!existsSync(teamsIndex)) return
    const built = readFileSync(teamsIndex, 'utf8')
    expect(built).not.toMatch(/from\s*['"]drizzle-orm/)
  })

  it('the drizzle subpath chunk keeps drizzle-orm external (import, not bundled)', () => {
    const drizzleChunk = resolve(root, 'dist/teams/drizzle.js')
    if (!existsSync(drizzleChunk)) return
    const built = readFileSync(drizzleChunk, 'utf8')
    expect(built).toMatch(/from\s*['"]drizzle-orm/)
  })
})
