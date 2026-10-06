import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [manifestPath, sourceSha] = process.argv.slice(2)
if (!manifestPath || !/^[0-9a-f]{40}$/.test(sourceSha ?? '')) {
  throw new Error('Usage: next-release-version.mjs <package.json> <source-sha>')
}

const { version } = JSON.parse(readFileSync(manifestPath, 'utf8'))
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
if (!match) throw new Error(`Invalid base package version: ${version}`)

// Match write-release.sh's first-parent release boundary; the writer has no tags.
const lastRelease = execFileSync('git', [
  'log', '--first-parent', '-1', '--format=%H', '--extended-regexp',
  '--grep=^chore\\(release\\): [0-9]+\\.[0-9]+\\.[0-9]+ \\[skip release\\]$', sourceSha,
], { encoding: 'utf8' }).trim()
const range = lastRelease ? `${lastRelease}..${sourceSha}` : sourceSha
const subjects = execFileSync('git', ['log', '--first-parent', '--format=%s', range], { encoding: 'utf8' })
  .trim().split('\n')
const breaking = subjects.some((subject) => /^[a-z]+(?:\([^)]+\))?!:/.test(subject))
let next
if (breaking) {
  next = match[1] === '0'
    ? `0.${BigInt(match[2]) + 1n}.0`
    : `${BigInt(match[1]) + 1n}.0.0`
} else {
  next = `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`
}
process.stdout.write(next)
