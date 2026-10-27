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
// The template packages adoption PR #1210 bumped (its failing pin was Integrations
// 0.75.0 -> 0.75.4). Each gets the next patch of today's pin, so the test keeps
// bumping forward after later adoptions.
const BUMPED = [
  '@tangle-network/agent-integrations',
  '@tangle-network/agent-knowledge',
  '@tangle-network/brand',
  '@tangle-network/sandbox-ui',
  '@tangle-network/ui',
]
const INTEGRATIONS = '@tangle-network/agent-integrations'
// A pre-1.0 peer whose floor is a `>=x <0.y.0` window; Materialize was this package until its 1.0.
const WINDOWED = '@tangle-network/browser-agent-driver'
const nextPatch = (version: string) => version.replace(/\d+$/, (patch) => String(Number(patch) + 1))
const widenLast = (range: string, by: number) =>
  range.replace(/<(\d+)\.(\d+)\.0$/, (_, major: string, minor: string) => `<${major}.${Number(minor) + by}.0`)

// Strip the parent runner's VITEST_* worker vars so the nested runs start clean.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))
const repoManifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Required<Manifest>

let copy: string
const read = (path: string): Manifest => JSON.parse(readFileSync(join(copy, path), 'utf8'))
const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: copy, encoding: 'utf8', env: { ...env, CI: 'true' }, timeout: 90_000 })
const git = (...args: string[]) => {
  const result = run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=adopt-sync-test', '-c', 'user.email=adopt-sync-test@invalid', ...args])
  expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0)
}
const vitest = (file: string) => run(process.execPath, [VITEST, 'run', file])
const sync = () => run('pnpm', ['run', 'adopt:sync'])

let committedFloor: string
let untested: string
let adopted: string
let widened: string

// A copy of what the sync and both consistency tests read, committed as the
// pre-adoption HEAD. The bumped manifest is then written the way adopt-stack
// writes it before `post-pin` (pins moved, peer upper bounds widened) and
// STAGED, so a sync that read the index instead of HEAD would see no moved pin.
// The windowed peer skips one minor, as Materialize did in #1210 (0.25.2 -> 0.27.0),
// and the widened floor claims the skipped minor.
beforeEach(() => {
  copy = mkdtempSync(join(tmpdir(), 'adopt-sync-'))
  for (const path of ['package.json', 'scripts/adopt-sync.mjs', 'create-agent-app', 'tests/scaffold-cohort.test.ts', 'src/peer-floors']) {
    cpSync(join(REPO, path), join(copy, path), { recursive: true })
  }
  symlinkSync(join(REPO, 'node_modules'), join(copy, 'node_modules'), 'dir')
  symlinkSync(join(REPO, 'dist'), join(copy, 'dist'), 'dir')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'pre-adoption')

  const root = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'))
  committedFloor = root.peerDependencies[WINDOWED]
  const last = /<0\.(\d+)\.0$/.exec(committedFloor)
  expect(last, `${WINDOWED} floor ${committedFloor} must end in a >=x <0.y.0 window`).not.toBeNull()
  const upper = Number(last![1])
  untested = `0.${upper}.0`
  adopted = `0.${upper + 1}.0`
  widened = widenLast(committedFloor, 2)
  for (const name of BUMPED) root.devDependencies[name] = nextPatch(root.devDependencies[name])
  root.devDependencies[WINDOWED] = adopted
  root.peerDependencies[WINDOWED] = widened
  root.peerDependencies[INTEGRATIONS] = widenLast(root.peerDependencies[INTEGRATIONS], 2)
  writeFileSync(join(copy, 'package.json'), `${JSON.stringify(root, null, 2)}\n`)
  git('add', 'package.json')
})

afterEach(() => rmSync(copy, { recursive: true, force: true }))

it('moves both templates and the peer floors onto the adopted cohort so both consistency tests pass, and a second run changes nothing', () => {
  // Both defects must be present first, or the passes below prove nothing.
  const before = vitest('tests/scaffold-cohort.test.ts')
  expect(before.status, `${before.stdout}${before.stderr}`).not.toBe(0)
  expect(`${before.stdout}${before.stderr}`).toContain('generated users must receive the tested engine cohort')
  expect(satisfiesRange(untested, widened), `${widened} claims ${untested}`).toBe(true)

  const first = sync()
  expect(first.status, `${first.stdout}${first.stderr}`).toBe(0)

  const pins = read('package.json').devDependencies ?? {}
  for (const name of BUMPED) expect(pins[name]).toBe(nextPatch(repoManifest.devDependencies[name]!))
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
  expect(read(TEMPLATES[0]!).peerDependencies?.[INTEGRATIONS]).toBe(pins[INTEGRATIONS])
  expect(read(TEMPLATES[1]!).dependencies?.['@tangle-network/sandbox-ui']).toBe(pins['@tangle-network/sandbox-ui'])

  // The floor keeps every committed window and gains the adopted minor alone.
  const floors = read('package.json').peerDependencies ?? {}
  expect(floors[WINDOWED]).toBe(`${committedFloor} || >=${adopted} <0.${Number(adopted.split('.')[1]) + 1}.0`)
  expect(satisfiesRange(adopted, floors[WINDOWED]!)).toBe(true)
  expect(satisfiesRange(untested, floors[WINDOWED]!), `${floors[WINDOWED]} claims the untested ${untested}`).toBe(false)
  // A committed floor that already admits its moved pin returns to HEAD's value,
  // undoing the widening; every other floor is as committed.
  for (const [name, range] of Object.entries(repoManifest.peerDependencies)) {
    if (name !== WINDOWED) expect(floors[name], name).toBe(range)
  }

  const cohort = vitest('tests/scaffold-cohort.test.ts')
  expect(cohort.status, `${cohort.stdout}${cohort.stderr}`).toBe(0)
  const peerFloors = vitest('src/peer-floors/check.test.ts')
  expect(peerFloors.status, `${peerFloors.stdout}${peerFloors.stderr}`).toBe(0)

  const files = [...TEMPLATES, 'package.json']
  const synced = files.map((file) => readFileSync(join(copy, file), 'utf8'))
  const again = sync()
  expect(again.status, `${again.stdout}${again.stderr}`).toBe(0)
  expect(again.stdout).not.toContain('->')
  expect(files.map((file) => readFileSync(join(copy, file), 'utf8'))).toEqual(synced)
}, 240_000)

it('refuses a template Tangle package the root does not pin and writes no file', () => {
  const chat = join(copy, TEMPLATES[1]!)
  const manifest = JSON.parse(readFileSync(chat, 'utf8'))
  manifest.devDependencies['@tangle-network/unpinned-engine'] = '1.0.0'
  writeFileSync(chat, `${JSON.stringify(manifest, null, 2)}\n`)
  const files = [...TEMPLATES, 'package.json']
  const untouched = files.map((file) => readFileSync(join(copy, file), 'utf8'))

  const refused = sync()
  expect(refused.status).not.toBe(0)
  expect(refused.stderr).toContain('create-agent-app/template-chat/_package.json devDependencies @tangle-network/unpinned-engine')
  expect(files.map((file) => readFileSync(join(copy, file), 'utf8'))).toEqual(untouched)
}, 60_000)
