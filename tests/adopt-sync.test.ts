import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const REPO = resolve(__dirname, '..')
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs')
const TEMPLATES = ['create-agent-app/template/_package.json', 'create-agent-app/template-chat/_package.json']
// The template packages adoption PR #1210 bumped; 0.75.0 -> 0.75.4 is the pin that failed its gate.
const ADOPTED = {
  '@tangle-network/agent-integrations': '0.75.4',
  '@tangle-network/agent-knowledge': '22.0.4',
  '@tangle-network/brand': '1.26.2',
  '@tangle-network/sandbox-ui': '0.136.1',
  '@tangle-network/ui': '11.40.2',
}

// Strip the parent runner's VITEST_* worker vars so the nested cohort run starts clean.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))

let copy: string
const read = (path: string): Manifest => JSON.parse(readFileSync(join(copy, path), 'utf8'))
const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: copy, encoding: 'utf8', env: { ...env, CI: 'true' }, timeout: 90_000 })
const scaffoldCohort = () => run(process.execPath, [VITEST, 'run', 'tests/scaffold-cohort.test.ts'])

// A copy of what the sync and the cohort test read, with the root pins bumped
// the way agent-eval's adopt-stack bumps them before it runs `post-pin`.
beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), 'adopt-sync-'))
  for (const path of ['package.json', 'scripts/adopt-sync.mjs', 'create-agent-app', 'tests/scaffold-cohort.test.ts']) {
    cpSync(join(REPO, path), join(copy, path), { recursive: true })
  }
  symlinkSync(join(REPO, 'node_modules'), join(copy, 'node_modules'), 'dir')
  const root = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'))
  Object.assign(root.devDependencies, ADOPTED)
  writeFileSync(join(copy, 'package.json'), `${JSON.stringify(root, null, 2)}\n`)
})

afterEach(() => rmSync(copy, { recursive: true, force: true }))

it('moves both templates onto the adopted pins so the scaffold cohort passes, and a second run changes nothing', () => {
  // The cohort test must reject the bumped copy first, or its pass below proves nothing.
  const before = scaffoldCohort()
  expect(before.status, `${before.stdout}${before.stderr}`).not.toBe(0)
  expect(`${before.stdout}${before.stderr}`).toContain('agent-integrations: generated users must receive the tested engine cohort')

  const sync = run('pnpm', ['run', 'adopt:sync'])
  expect(sync.status, `${sync.stdout}${sync.stderr}`).toBe(0)

  const pins = read('package.json').devDependencies ?? {}
  for (const template of TEMPLATES) {
    const manifest = read(template)
    for (const section of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
      for (const [name, version] of Object.entries(section ?? {})) {
        if (name.startsWith('@tangle-network/') && name !== '@tangle-network/agent-app') {
          expect(version, `${template} ${name}`).toBe(pins[name])
        }
      }
    }
  }
  expect(read(TEMPLATES[0]!).peerDependencies?.['@tangle-network/agent-integrations']).toBe('0.75.4')
  expect(read(TEMPLATES[1]!).dependencies?.['@tangle-network/sandbox-ui']).toBe('0.136.1')

  const after = scaffoldCohort()
  expect(after.status, `${after.stdout}${after.stderr}`).toBe(0)

  const synced = TEMPLATES.map((template) => readFileSync(join(copy, template), 'utf8'))
  const again = run('pnpm', ['run', 'adopt:sync'])
  expect(again.status, `${again.stdout}${again.stderr}`).toBe(0)
  expect(again.stdout).not.toContain('->')
  expect(TEMPLATES.map((template) => readFileSync(join(copy, template), 'utf8'))).toEqual(synced)
}, 180_000)

it('refuses a template Tangle package the root does not pin and writes no template', () => {
  const chat = join(copy, TEMPLATES[1]!)
  const manifest = JSON.parse(readFileSync(chat, 'utf8'))
  manifest.devDependencies['@tangle-network/unpinned-engine'] = '1.0.0'
  writeFileSync(chat, `${JSON.stringify(manifest, null, 2)}\n`)
  const untouched = TEMPLATES.map((template) => readFileSync(join(copy, template), 'utf8'))

  const sync = run('pnpm', ['run', 'adopt:sync'])
  expect(sync.status).not.toBe(0)
  expect(sync.stderr).toContain('create-agent-app/template-chat/_package.json devDependencies @tangle-network/unpinned-engine')
  expect(TEMPLATES.map((template) => readFileSync(join(copy, template), 'utf8'))).toEqual(untouched)
}, 60_000)
