import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [manifestPath, sourceSha, output] = process.argv.slice(2)
if (!manifestPath || !/^[0-9a-f]{40}$/.test(sourceSha ?? '') ||
    (output !== undefined && output !== '--json') || process.argv.length > 5) {
  throw new Error('Usage: next-release-version.mjs <package.json> <source-sha> [--json]')
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
const messages = execFileSync('git', ['log', '--first-parent', '--format=%B%x00', range], { encoding: 'utf8' })
  .split('\0').map((message) => message.trim()).filter(Boolean)
const subjects = messages.map((message) => message.split('\n')[0])
const breaking = subjects.some((subject) => /^[a-z]+(?:\([^)]+\))?!:/.test(subject))
let next
if (match[1] === '0') {
  // Every library is 1.0 or later: a 0.x version graduates at its next release
  // (agent-runtime docs/release-versioning.md).
  next = '1.0.0'
} else if (breaking) {
  next = match[1] === '0'
    ? `0.${BigInt(match[2]) + 1n}.0`
    : `${BigInt(match[1]) + 1n}.0.0`
} else {
  next = `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`
}
// A skip marker suppresses its own commit, never executable work still waiting
// below it. Version-only callers (including the atomic writer) keep their API.
const pending = messages.some((message) => !message.includes('[skip release]'))
process.stdout.write(output === '--json' ? JSON.stringify({ version: next, pending }) : next)
