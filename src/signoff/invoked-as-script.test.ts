import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { invokedAsScript } from './invoked-as-script'

/**
 * The shape under test is a package manager's bin shim, so the fixture is a
 * real symlinked directory rather than a hand-written pair of strings — the
 * defect this guards is precisely that two strings naming the same file are not
 * equal, and a fixture made of strings can only encode the assumption that
 * broke.
 */
describe('invokedAsScript', () => {
  let root: string
  let realCli: string
  let moduleUrl: string
  let throughLink: string

  beforeAll(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'signoff-bin-'))
    mkdirSync(join(root, 'store', 'pkg', 'dist'), { recursive: true })
    mkdirSync(join(root, 'node_modules'), { recursive: true })

    realCli = join(root, 'store', 'pkg', 'dist', 'cli.js')
    writeFileSync(realCli, '')
    // What pnpm/npm build: node_modules/<pkg> is a symlink to the real package
    // directory, and the shim spells the entry THROUGH it.
    symlinkSync(join(root, 'store', 'pkg'), join(root, 'node_modules', 'pkg'), 'dir')
    throughLink = join(root, 'node_modules', 'pkg', 'dist', 'cli.js')

    // Node resolves a module's realpath, so this is what `import.meta.url` is
    // when the file is loaded through either spelling.
    moduleUrl = pathToFileURL(realCli).href
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('is true when the entry is spelled through a symlinked package directory', () => {
    // The two strings differ; that difference is the whole defect.
    expect(pathToFileURL(throughLink).href).not.toBe(moduleUrl)
    expect(invokedAsScript(moduleUrl, throughLink)).toBe(true)
  })

  test('is true for the plain real path', () => {
    expect(invokedAsScript(moduleUrl, realCli)).toBe(true)
  })

  test('is false for a different file in the same directory', () => {
    const other = join(root, 'store', 'pkg', 'dist', 'other.js')
    writeFileSync(other, '')
    expect(invokedAsScript(moduleUrl, other)).toBe(false)
  })

  test('is false when there is no entry at all', () => {
    expect(invokedAsScript(moduleUrl, undefined)).toBe(false)
    expect(invokedAsScript(moduleUrl, '')).toBe(false)
  })

  test('is false, not a throw, when the entry does not exist', () => {
    expect(invokedAsScript(moduleUrl, join(root, 'store', 'pkg', 'dist', 'absent.js'))).toBe(false)
  })
})
