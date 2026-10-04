import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { satisfies, valid } from 'semver'

interface PackageManifest {
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const repo = resolve(__dirname, '..')
const readManifest = (path: string): PackageManifest =>
  JSON.parse(readFileSync(resolve(repo, path), 'utf8'))
const app = readManifest('package.json')

describe.each([{ flags: [] }, { flags: ['--chat'] }, { flags: ['--headless'] }])('scaffold version selection: $flags', ({ flags }) => {
  it('pins the released App cohort and preserves an explicit version override', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'scaffold-version-'))
    try {
      const scaffolder = readManifest('create-agent-app/package.json')
      expect(scaffolder.version).toBe(app.version)
      for (const override of [undefined, '0.49.0']) {
        const target = join(scratch, override ? 'override' : 'default')
        execFileSync(process.execPath, [
          resolve(repo, 'create-agent-app/index.mjs'), target, ...flags,
          ...(override ? ['--agent-app-version', override] : []),
        ])
        const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
        expect(manifest.dependencies['@tangle-network/agent-app'])
          .toBe(override ?? scaffolder.version)
        expect(manifest.devDependencies['@tangle-network/agent-eval'])
          .toBe(app.devDependencies?.['@tangle-network/agent-eval'])
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe.each(['template', 'template-chat'])('scaffold release cohort: %s', (template) => {
  const generated = readManifest(`create-agent-app/${template}/_package.json`)
  const installed = { ...generated.devDependencies, ...generated.dependencies }

  it('installs the exact engine versions exercised by the maintained app build', () => {
    for (const [name, version] of Object.entries(installed)) {
      if (!name.startsWith('@tangle-network/') || name === '@tangle-network/agent-app') continue
      expect(valid(version), `${name} must use an exact release version`).not.toBeNull()
      expect(version, `${name}: generated users must receive the tested engine cohort`)
        .toBe(app.devDependencies?.[name])
      const appPeerRange = app.peerDependencies?.[name]
      if (appPeerRange) {
        expect(satisfies(version, appPeerRange), `${name}@${version} violates ${appPeerRange}`).toBe(true)
      }
    }
  })

  it('keeps each generated peer contract compatible with its installed engine', () => {
    for (const [name, range] of Object.entries(generated.peerDependencies ?? {})) {
      if (!name.startsWith('@tangle-network/')) continue
      const version = installed[name]
      expect(version, `${name}: generated peer has no installed engine`).toBeTruthy()
      if (!version) throw new Error(`${name}: generated peer has no installed engine`)
      expect(satisfies(version, range), `${name}@${version} violates the generated peer ${range}`).toBe(true)
    }
  })
})
