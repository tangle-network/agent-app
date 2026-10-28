#!/usr/bin/env node
/**
 * Sync both generated apps to the exact installed Tangle cohort after adoption.
 * Library dependency ranges remain authored in package.json; generated apps pin
 * the versions actually installed and tested. Run after the frozen install.
 * Peer floors retain HEAD's admitted lines and add only a newly adopted line.
 * Stage all outputs with the adoption; an unchanged second run writes nothing.
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
const declared = manifest.devDependencies ?? {}
const pins = Object.fromEntries(Object.keys(declared).filter(name => name.startsWith(SCOPE)).map(name => {
  const path = join(root, 'node_modules', name, 'package.json')
  if (!existsSync(path)) fail(`${name} is not installed; run the frozen install before adopt:sync`)
  const { version } = JSON.parse(readFileSync(path, 'utf8'))
  if (!RELEASE.test(version)) fail(`${name} has no stable installed version: ${version}`)
  return [name, version]
}))

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
  if (!name.startsWith(SCOPE) || !release || !floor || declared[name] === committed.devDependencies?.[name]) continue
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
