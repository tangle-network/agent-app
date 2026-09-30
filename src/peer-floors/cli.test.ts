import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/peer-floors/cli.js')

function checkFixture(options: {
  declared: string
  installed: string
  section?: 'dependencies' | 'devDependencies'
  absentPin?: boolean
  devDeclaration?: string
}) {
  const root = mkdtempSync(join(tmpdir(), 'peer-check-pins-'))
  const writeManifest = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  }
  try {
    if (!existsSync(cli)) throw new Error('Build the peer-check CLI before this test')
    // The repository boundary prevents an unrelated parent install from supplying a package.
    mkdirSync(join(root, '.git'))
    writeManifest(join(root, 'package.json'), {
      name: 'fixture-consumer',
      version: '1.0.0',
      ...(options.devDeclaration ? { devDependencies: { '@tangle-network/agent-app': options.devDeclaration } } : {}),
      [options.section ?? 'dependencies']: {
        '@tangle-network/agent-app': options.declared,
        ...(options.absentPin ? { '@tangle-network/unused': '1.0.0' } : {}),
      },
    })
    writeManifest(join(root, 'node_modules/@tangle-network/agent-app/package.json'), {
      name: '@tangle-network/agent-app',
      version: options.installed,
      peerDependencies: { '@tangle-network/agent-interface': '^2.14.0' },
    })
    writeManifest(join(root, 'node_modules/@tangle-network/agent-interface/package.json'), {
      name: '@tangle-network/agent-interface',
      version: '2.14.0',
    })
    return spawnSync(process.execPath, [cli, root], { encoding: 'utf8', timeout: 30_000 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('peer-check CLI consumer pins', () => {
  it.each(['dependencies', 'devDependencies'] as const)('rejects a stale installed App despite compatible engine peers: %s', (section) => {
    const result = checkFixture({ declared: '0.50.10', installed: '0.50.9', section })
    expect(result.error).toBeUndefined()
    expect(result.stdout).toContain('all 1 floors satisfied')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DECLARED PIN VIOLATED: @tangle-network/agent-app declares 0.50.10, but 0.50.9 is installed')
  })

  it.each(['0.50.10', '0.50.10-rc.1', '0.50.10+build.1'])('accepts the exact installed artifact version %s', (version) => {
    const result = checkFixture({ declared: version, installed: version })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('declared pins: 1 installed exact Tangle versions matched')
  })

  it.each(['0.50.10', '0.50.10-rc.2'])('rejects %s when the consumer pinned a different prerelease', (installed) => {
    const result = checkFixture({ declared: '0.50.10-rc.1', installed })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DECLARED PIN VIOLATED')
  })

  it('preserves range selection and the existing treatment of an absent unused dependency', () => {
    const result = checkFixture({ declared: '^0.50.0', installed: '0.50.9', absentPin: true })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('declared pins: 0 installed exact Tangle versions matched')
  })

  it('gives the production dependency priority when the same package has a development declaration', () => {
    const result = checkFixture({ declared: '0.50.10', installed: '0.50.10', devDeclaration: '0.50.9' })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('declared pins: 1 installed exact Tangle versions matched')
  })
})
