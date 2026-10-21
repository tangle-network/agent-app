#!/usr/bin/env node
/**
 * `pnpm run adopt:sync` — after an adoption bumps the root `@tangle-network/*`
 * pins, copy them into both create-agent-app templates and recompute this
 * package's own Tangle peer floors.
 *
 * agent-eval's adopt-stack workflow runs this as its `post-pin` step, after it
 * writes the pins and installs (whose `prepare` builds `dist/`) and before it
 * commits, so both edits join the adoption commit instead of failing
 * `tests/scaffold-cohort.test.ts` and `src/peer-floors/check.test.ts`.
 *
 * Templates: every Tangle package a template installs or declares as a peer,
 * except the shell itself, uses the exact version in the root
 * `devDependencies` (the rule `tests/scaffold-cohort.test.ts` enforces). A
 * template Tangle package the root does not pin fails the run by name, and no
 * file is written.
 *
 * Floors: a floor admits only versions this package was tested on. For each
 * Tangle peer whose exact pin moved since `HEAD`, the floor restarts from the
 * one in `HEAD`. If that floor already admits the new pin it is kept as is;
 * otherwise it gains one window for the pin's own line, `>=pin <0.(m+1).0` on
 * 0.x and `^pin` from 1.0, and nothing between. That undoes agent-eval's
 * `widenRange`, which stretches the last window's upper bound over every
 * intermediate minor (#1210: Materialize `>=0.25.2 <0.26.0` became
 * `>=0.25.2 <0.28.0`, claiming the never-tested 0.26). Floors whose pin did not
 * move are left as written, so a hand edit survives.
 *
 * The baseline is `git show HEAD:package.json`, never the index: adopt-stack
 * runs this after editing and before committing, so `HEAD` is the pre-adoption
 * manifest whatever is staged. Run after the adoption is committed, nothing
 * differs from `HEAD` and the floors are left alone.
 *
 * Files change only when a value changes, so a second run writes nothing.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = ['create-agent-app/template/_package.json', 'create-agent-app/template-chat/_package.json']
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies']
const SCOPE = '@tangle-network/'
const SHELL = '@tangle-network/agent-app'
const RELEASE = /^(\d+)\.(\d+)\.\d+$/

const fail = (message) => {
  console.error(`adopt:sync: ${message}`)
  process.exit(1)
}
const serialize = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`

const check = join(root, 'dist/peer-floors/check.js')
if (!existsSync(check)) fail(`${check} is missing; \`pnpm install\` builds it`)
const { satisfiesRange } = await import(pathToFileURL(check).href)

const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const pins = manifest.devDependencies ?? {}

const writes = []
const changes = []
const unpinned = []

for (const file of TEMPLATES) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  const template = JSON.parse(before)
  for (const section of SECTIONS) {
    for (const [name, version] of Object.entries(template[section] ?? {})) {
      if (!name.startsWith(SCOPE) || name === SHELL) continue
      const pin = pins[name]
      if (!pin) unpinned.push(`${file} ${section} ${name}`)
      else if (pin !== version) {
        template[section][name] = pin
        changes.push(`${file} ${section} ${name}: ${version} -> ${pin}`)
      }
    }
  }
  const after = serialize(template)
  if (after !== before) writes.push([path, after])
}
if (unpinned.length) fail(`the root package.json devDependencies pin none of:\n  ${unpinned.join('\n  ')}`)

const shown = spawnSync('git', ['show', 'HEAD:package.json'], { cwd: root, encoding: 'utf8' })
if (shown.status !== 0) fail(`the peer floors restart from \`git show HEAD:package.json\`, which failed: ${shown.stderr?.trim() || shown.error?.message}`)
const committed = JSON.parse(shown.stdout)

let moved = 0
let floorsChanged = false
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  const pin = pins[name]
  const floor = committed.peerDependencies?.[name]
  const release = RELEASE.exec(pin ?? '')
  if (!name.startsWith(SCOPE) || !release || !floor || pin === committed.devDependencies?.[name]) continue
  moved += 1
  const [, major, minor] = release
  const window = major === '0' ? `>=${pin} <0.${Number(minor) + 1}.0` : `^${pin}`
  const next = satisfiesRange(pin, floor) ? floor : `${floor} || ${window}`
  if (next === range) continue
  manifest.peerDependencies[name] = next
  floorsChanged = true
  changes.push(`package.json peerDependencies ${name}: ${range} -> ${next}`)
}
if (!moved) console.error('adopt:sync: no Tangle peer pin differs from HEAD, so the peer floors are left as written')
if (floorsChanged) writes.push([manifestPath, serialize(manifest)])

for (const [path, contents] of writes) writeFileSync(path, contents)
for (const change of changes) console.log(change)
