import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNodeVersion, resolveNodeRequirement } from './node-version'

/** The fleet's real merge-gate shape: pull_request trigger, `node-version: 22`. */
const PR_WORKFLOW = `name: deploy
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
`

function writeWorkflow(repo: string, name: string, body: string): void {
  const dir = join(repo, '.github', 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

/**
 * The runtime the gate verifies has to be the runtime the product ships. This
 * is not hypothetical here: all three fleet workflows pin `node-version: 22`
 * and this development host runs 24, so an unguarded local gate signs off a
 * runtime CI never tested.
 */

const created: string[] = []
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signoff-node-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('resolveNodeRequirement', () => {
  it('takes the explicit config declaration first', () => {
    expect(resolveNodeRequirement(tempRepo(), '22')).toEqual({
      major: 22,
      declared: '22',
      source: 'signoff config `nodeVersion`',
    })
  })

  it('reads .nvmrc, with or without the v prefix', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.nvmrc'), 'v22.22.3\n')
    expect(resolveNodeRequirement(repo)?.major).toBe(22)
    writeFileSync(join(repo, '.nvmrc'), '20\n')
    expect(resolveNodeRequirement(repo)?.major).toBe(20)
  })

  it('reports no requirement for an alias it cannot resolve without a network call', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.nvmrc'), 'lts/iron\n')
    expect(resolveNodeRequirement(repo)).toBeNull()
  })

  it('ignores engines.node — it is a FLOOR, and reading it as a pin refuses every version above it', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ engines: { node: '>=18' } }))
    expect(resolveNodeRequirement(repo)).toBeNull()
  })

  it('refuses a declaration with no major rather than guessing one', () => {
    expect(() => resolveNodeRequirement(tempRepo(), 'latest')).toThrow(/does not start with a major/)
  })

  it('returns null when the repo pins nothing, so the proof can say so', () => {
    expect(resolveNodeRequirement(tempRepo())).toBeNull()
  })

  it('reads the merge-gate workflow when no .nvmrc exists — the fleet state that produced a false PASS', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'deploy.yml', PR_WORKFLOW)
    expect(resolveNodeRequirement(repo)).toEqual({
      major: 22,
      declared: '22',
      source: '.github/workflows/deploy.yml (node-version)',
    })
  })

  it('lets .nvmrc win when both agree, so the proof names the pin humans read', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.nvmrc'), '22.22.3\n')
    writeWorkflow(repo, 'deploy.yml', PR_WORKFLOW)
    expect(resolveNodeRequirement(repo)?.source).toBe('.nvmrc')
  })

  it('REFUSES when .nvmrc and the merge-gate workflow name different runtimes', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.nvmrc'), '20\n')
    writeWorkflow(repo, 'deploy.yml', PR_WORKFLOW)
    expect(() => resolveNodeRequirement(repo)).toThrow(/cannot verify two runtimes/)
  })

  it('still lets an explicit config declaration settle a disagreement', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.nvmrc'), '20\n')
    writeWorkflow(repo, 'deploy.yml', PR_WORKFLOW)
    expect(resolveNodeRequirement(repo, '22')?.major).toBe(22)
  })
})

describe('assertNodeVersion', () => {
  const pin = { major: 22, declared: '22', source: '.nvmrc' } as const

  it('REFUSES a run on a different major — the shape this gate exists to stop', () => {
    expect(() => assertNodeVersion(pin, 'v24.13.0')).toThrow(/pins Node 22 \(\.nvmrc\) and you are running v24\.13\.0/)
  })

  it('names the fix rather than only the problem', () => {
    expect(() => assertNodeVersion(pin, 'v24.13.0')).toThrow(/nvm use 22/)
  })

  it('accepts any patch of the pinned major — a patch is not a different runtime', () => {
    expect(() => assertNodeVersion(pin, 'v22.22.3')).not.toThrow()
    expect(() => assertNodeVersion(pin, 'v22.0.0')).not.toThrow()
  })

  it('does nothing when the repo pins nothing', () => {
    expect(() => assertNodeVersion(null, 'v24.13.0')).not.toThrow()
  })
})
