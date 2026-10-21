#!/usr/bin/env node
/**
 * `pnpm run adopt:sync` — copy the root `@tangle-network/*` pins into both
 * create-agent-app templates after an adoption bumps them.
 *
 * agent-eval's adopt-stack workflow runs this as its `post-pin` step, so the
 * template pins join the adoption commit instead of failing
 * `tests/scaffold-cohort.test.ts`. That test owns the rule this applies: every
 * Tangle package a template installs or declares as a peer, except the shell
 * itself, uses the exact version in the root `devDependencies`.
 *
 * A template Tangle package the root does not pin fails the run by name rather
 * than keeping a version nothing here exercises, and then writes no file.
 * Files change only when a pin changes, so a second run writes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = ['create-agent-app/template/_package.json', 'create-agent-app/template-chat/_package.json']
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies']

const pins = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies ?? {}
const unpinned = []
const writes = []
const changes = []

for (const file of TEMPLATES) {
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  const manifest = JSON.parse(before)
  for (const section of SECTIONS) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@tangle-network/') || name === '@tangle-network/agent-app') continue
      const pin = pins[name]
      if (!pin) {
        unpinned.push(`${file} ${section} ${name}`)
      } else if (pin !== version) {
        manifest[section][name] = pin
        changes.push(`${file} ${section} ${name}: ${version} -> ${pin}`)
      }
    }
  }
  const after = `${JSON.stringify(manifest, null, 2)}\n`
  if (after !== before) writes.push([path, after])
}

if (unpinned.length) {
  console.error(`adopt:sync: the root package.json devDependencies pin none of:\n  ${unpinned.join('\n  ')}`)
  process.exit(1)
}
for (const [path, contents] of writes) writeFileSync(path, contents)
for (const change of changes) console.log(change)
