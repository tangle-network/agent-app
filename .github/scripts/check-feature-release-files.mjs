#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const target = `origin/${process.env.GITHUB_BASE_REF || 'main'}`
const base = execFileSync('git', ['merge-base', target, 'HEAD'], { encoding: 'utf8' }).trim()
const show = (path) => execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' })

for (const path of ['package.json', 'create-agent-app/package.json']) {
  const before = JSON.parse(show(path)).version
  const after = JSON.parse(readFileSync(path, 'utf8')).version
  if (before !== after) {
    throw new Error(`feature PR changed ${path} version ${before} -> ${after}; release workflow owns versions`)
  }
}

const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
if (changed.includes('CHANGELOG.md')) {
  throw new Error('feature PR changed CHANGELOG.md; release workflow owns changelog generation')
}
console.log('feature release files clean')
