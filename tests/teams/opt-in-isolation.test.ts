/**
 * The whole point of the teams module: it is OPT-IN by construction. A consumer
 * must reach for `@tangle-network/agent-app/teams` explicitly, and nothing they
 * get by default may pull teams code or the optional `drizzle-orm` peer.
 *
 * Until 0.44.0 that guarantee was enforced against the root barrel (`.`), which
 * had to be checked for `./teams` re-exports. The barrel is gone — `.` is no
 * longer an entry point at all — so the guarantee is now unconditional and the
 * test asserts the stronger fact: there is no bare entry to leak through.
 * The remaining tests prove the pure `./teams` leaf SOURCE imports no
 * drizzle / react / env, and that the drizzle subpath is the one real boundary.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

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

describe('built `.` artifact — it must not come back', () => {
  it('the build emits no dist/index.js', () => {
    expect(existsSync(distIndex)).toBe(false)
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
