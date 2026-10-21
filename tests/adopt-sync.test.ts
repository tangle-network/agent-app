import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { satisfiesRange } from '../src/peer-floors/check'

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
const MATERIALIZE = '@tangle-network/agent-profile-materialize'

// Strip the parent runner's VITEST_* worker vars so the nested cohort run starts clean.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))

let copy: string
const read = (path: string): Manifest => JSON.parse(readFileSync(join(copy, path), 'utf8'))
const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: copy, encoding: 'utf8', env: { ...env, CI: 'true' }, timeout: 90_000 })
const vitest = (file: string) => run(process.execPath, [VITEST, 'run', file])
const scaffoldCohort = () => vitest('tests/scaffold-cohort.test.ts')

let committedFloor: string
let untested: string
let adopted: string
let widened: string

// A copy of what the sync and both consistency tests read. Its git index holds
// the manifest before the adoption, as adopt-stack's clean checkout does; the
// working tree then gets the pins and peer floors the way adopt-stack writes
// them before it runs `post-pin`. Materialize skips one minor, as it did in
// #1210 (0.25.2 -> 0.27.0), and agent-eval's widenRange stretches the last
// window over it, so the widened floor claims the skipped minor.
beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), 'adopt-sync-'))
  for (const path of ['package.json', 'scripts/adopt-sync.mjs', 'create-agent-app', 'tests/scaffold-cohort.test.ts', 'src/peer-floors']) {
    cpSync(join(REPO, path), join(copy, path), { recursive: true })
  }
  symlinkSync(join(REPO, 'node_modules'), join(copy, 'node_modules'), 'dir')
  symlinkSync(join(REPO, 'dist'), join(copy, 'dist'), 'dir')
  expect(run('git', ['init', '-q']).status).toBe(0)
  expect(run('git', ['add', '-A']).status).toBe(0)

  const root = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'))
  committedFloor = root.peerDependencies[MATERIALIZE]
  const last = /^>=(\S+) <0\.(\d+)\.0$/.exec(committedFloor.split('||').at(-1)!.trim())
  expect(last, `${MATERIALIZE} floor ${committedFloor} must end in a >=x <0.y.0 window`).not.toBeNull()
  const upper = Number(last![2])
  untested = `0.${upper}.0`
  adopted = `0.${upper + 1}.0`
  widened = committedFloor.replace(/<0\.\d+\.0$/, `<0.${upper + 2}.0`)
  Object.assign(root.devDependencies, ADOPTED, { [MATERIALIZE]: adopted })
  root.peerDependencies[MATERIALIZE] = widened
  writeFileSync(join(copy, 'package.json'), `${JSON.stringify(root, null, 2)}\n`)
})

afterEach(() => rmSync(copy, { recursive: true, force: true }))

it('moves both templates and the peer floors onto the adopted cohort so both consistency tests pass, and a second run changes nothing', () => {
  // Both defects must be present first, or the passes below prove nothing.
  const before = scaffoldCohort()
  expect(before.status, `${before.stdout}${before.stderr}`).not.toBe(0)
  expect(`${before.stdout}${before.stderr}`).toContain('agent-integrations: generated users must receive the tested engine cohort')
  expect(satisfiesRange(untested, widened), `${widened} claims ${untested}`).toBe(true)

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

  // The floor keeps every committed window and gains the adopted minor alone.
  const floor = read('package.json').peerDependencies?.[MATERIALIZE]
  expect(floor).toBe(`${committedFloor} || >=${adopted} <0.${Number(adopted.split('.')[1]) + 1}.0`)
  expect(satisfiesRange(adopted, floor!)).toBe(true)
  expect(satisfiesRange(untested, floor!), `${floor} claims the untested ${untested}`).toBe(false)
  // Floors whose committed window already admits the new pin stay as committed.
  expect(read('package.json').peerDependencies?.['@tangle-network/agent-integrations'])
    .toBe(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).peerDependencies['@tangle-network/agent-integrations'])

  const after = scaffoldCohort()
  expect(after.status, `${after.stdout}${after.stderr}`).toBe(0)
  const floors = vitest('src/peer-floors/check.test.ts')
  expect(floors.status, `${floors.stdout}${floors.stderr}`).toBe(0)

  const files = [...TEMPLATES, 'package.json']
  const synced = files.map((file) => readFileSync(join(copy, file), 'utf8'))
  const again = run('pnpm', ['run', 'adopt:sync'])
  expect(again.status, `${again.stdout}${again.stderr}`).toBe(0)
  expect(again.stdout).not.toContain('->')
  expect(files.map((file) => readFileSync(join(copy, file), 'utf8'))).toEqual(synced)
}, 240_000)

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
