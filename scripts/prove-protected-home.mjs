#!/usr/bin/env node
/** Run inside a fresh, disposable general-agent image as its real runtime UID.
 * No fake filesystem, helper, sudo, Git, or profile implementation is used.
 */
import assert from 'node:assert/strict'
import { readFile, writeFile, chmod, rename, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { initializeHome, homeOperation, PROTECTED_HOME } from '../bin/tangle-agent/home.mjs'

if (process.env.TANGLE_HOME_PROOF_DISPOSABLE !== '1' || process.getuid?.() === 0) {
  throw new Error('Run only in a fresh disposable image, as its configured non-root runtime UID, with TANGLE_HOME_PROOF_DISPOSABLE=1')
}
const exec = promisify(execFile)
const receipt = (step, evidence) => console.log(JSON.stringify({ step, at: new Date().toISOString(), ...evidence }))
const hash = body => createHash('sha256').update(body).digest('hex')
const agents = `${PROTECTED_HOME}/AGENTS.md`
const before = await readFile(agents)
await initializeHome(PROTECTED_HOME)
const initial = await homeOperation({ action: 'status' })
for (const path of ['USER.md', 'MEMORY.md', 'IDENTITY.md']) {
  assert.equal((await homeOperation({ action: 'read', path })).content, '', 'Use a fresh disposable home, not a real member home')
}
receipt('installed-boundary', { uid: process.getuid(), commit: initial.commit, agentsSha256: hash(before) })

for (const [name, operation] of [
  ['direct-write', () => writeFile(agents, 'must not land')],
  ['chmod', () => chmod(agents, 0o644)],
  ['unlink', () => unlink(agents)],
  ['oversized-direct-memory-write', () => writeFile(`${PROTECTED_HOME}/USER.md`, 'x'.repeat(4001))],
]) {
  await assert.rejects(operation, error => ['EACCES', 'EPERM', 'EROFS'].includes(error.code))
  receipt(name, { denied: true })
}
const replacement = `/tmp/tangle-home-replace-${process.pid}`
await writeFile(replacement, 'must not land', { flag: 'wx', mode: 0o600 })
try {
  await assert.rejects(() => rename(replacement, agents), error => ['EACCES', 'EPERM', 'EROFS', 'EXDEV'].includes(error.code))
} finally { await unlink(replacement) }
assert.equal(hash(await readFile(agents)), hash(before))
receipt('replacement', { denied: true, agentsSha256: hash(before) })

await assert.rejects(() => exec('/usr/bin/sudo', ['-n', '--', '/usr/bin/id', '-u']), error => error.code === 1)
await assert.rejects(() => exec('/usr/bin/sudo', ['-n', '--', '/usr/bin/python3', '-I', '/usr/local/libexec/tangle-agent-home.py', 'extra']), error => error.code === 1)
receipt('sudo-confinement', { arbitraryCommandDenied: true, extraArgumentDenied: true })

await assert.rejects(() => homeOperation({ action: 'write', path: 'AGENTS.md', content: 'must not land' }))
await assert.rejects(() => homeOperation({ action: 'write', path: '../escape', content: 'must not land' }))
await assert.rejects(() => homeOperation({ action: 'write', path: 'USER.md', content: 'x'.repeat(4001) }))
assert.equal((await homeOperation({ action: 'read', path: 'USER.md' })).content, '')
receipt('writer-validation', { agentsDenied: true, traversalDenied: true, oversizedWriteDeniedBeforeMutation: true })

const preference = '2000-01-01: Prefiere respuestas breves con fuentes.\n'
const changed = await homeOperation({ action: 'write', path: 'USER.md', content: preference })
assert.match(changed.commit, /^[0-9a-f]{40}$/)
assert.notEqual(changed.commit, initial.commit)
await initializeHome(PROTECTED_HOME)
assert.equal((await homeOperation({ action: 'read', path: 'USER.md' })).content, preference)
await homeOperation({ action: 'write', path: 'IDENTITY.md', content: 'Disposable Tangle home proof.\n' })
await homeOperation({ action: 'bootstrap' })
await initializeHome(PROTECTED_HOME)
await assert.rejects(() => readFile(`${PROTECTED_HOME}/BOOTSTRAP.md`), { code: 'ENOENT' })
receipt('restart-and-bootstrap', { commit: changed.commit, preferenceRetained: true, bootstrapNotRecreated: true })

const snapshot = await homeOperation({ action: 'status' })
await homeOperation({ action: 'append', path: 'USER.md', content: '2000-01-01: Later preference.\n' })
await assert.rejects(() => homeOperation({ action: 'consolidate', user: preference, memory: 'stale', expectedHead: snapshot.commit }))
const latest = await homeOperation({ action: 'status' })
const consolidated = await homeOperation({ action: 'consolidate', user: preference, memory: 'A synthetic proof fact.\n', expectedHead: latest.commit })
assert.match(consolidated.commit, /^[0-9a-f]{40}$/)
assert.equal((await homeOperation({ action: 'read', path: 'MEMORY.md' })).content, 'A synthetic proof fact.\n')
assert.equal(hash(await readFile(agents)), hash(before))
receipt('consolidation', { staleSnapshotDenied: true, commit: consolidated.commit, agentsSha256: hash(before) })
