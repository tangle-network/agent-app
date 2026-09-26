import { mkdir, open, lstat, readFile, readdir, link, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { defaultHomeFiles, DEFAULT_HOME_LIMITS } from '../../dist/hosted-agent/index.js'

const run = promisify(execFile)
const fixed = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'BOOTSTRAP.md'])
const note = path => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(path)
const managed = path => fixed.has(path) || note(path)
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Tangle agent', GIT_AUTHOR_EMAIL: 'agent@localhost',
  GIT_COMMITTER_NAME: 'Tangle agent', GIT_COMMITTER_EMAIL: 'agent@localhost' }
for (const key of Object.keys(gitEnv)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete gitEnv[key]
}
async function git(home, args) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
    '--git-dir', join(home, '.git'), '--work-tree', home, ...args], {
    cwd: home, env: gitEnv, timeout: 30_000, maxBuffer: 1024 * 1024,
  })
}
async function regular(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Agent home contains a non-regular managed file')
  return stat
}
async function directory(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Agent home directories must not redirect elsewhere')
}
async function createOnce(path, content, mode) {
  const temporary = `${path}.${randomUUID()}.initializing`
  const file = await open(temporary, 'wx', mode)
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
    try { await link(temporary, path) }
    catch (error) { if (error.code !== 'EEXIST') throw error; await regular(path) }
  } finally { await file.close(); await unlink(temporary) }
}
/** Write-once bootstrap. A deleted BOOTSTRAP.md or note is not recreated on resume. */
export async function initializeHome(directoryName) {
  const home = resolve(directoryName)
  await mkdir(home, { recursive: true, mode: 0o700 })
  await directory(home)
  const marker = join(home, '.initialized')
  try { await regular(marker); return home }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const mount of defaultHomeFiles()) {
    if (!fixed.has(mount.path) || mount.resource.kind !== 'inline') throw new Error('Unsupported default home mount')
    await createOnce(join(home, mount.path), mount.resource.content, mount.path === 'AGENTS.md' ? 0o400 : 0o600)
  }
  await mkdir(join(home, 'memory'), { recursive: true, mode: 0o700 })
  await directory(join(home, 'memory'))
  try { await directory(join(home, '.git')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    await run('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', home], { env: gitEnv, timeout: 30_000 })
  }
  await checkpointHome(home)
  await createOnce(marker, 'tangle-agent-home-v1\n', 0o400)
  const root = await open(home, 'r')
  try { await root.sync() } finally { await root.close() }
  return home
}

/** A checkpoint safeguard, not a restriction on the owner's full private shell. */
export async function checkpointHome(directoryName) {
  const home = resolve(directoryName)
  await directory(home)
  await directory(join(home, '.git'))
  await directory(join(home, 'memory'))
  const tracked = (await git(home, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean)
  if (tracked.some(path => !managed(path))) throw new Error('Home repository tracks undeclared files; checkpoint refused')
  const paths = new Set([...fixed, ...tracked])
  for (const entry of await readdir(join(home, 'memory'), { withFileTypes: true })) {
    if (note(`memory/${entry.name}`)) paths.add(`memory/${entry.name}`)
  }
  if (paths.size > 1000) throw new Error('Consolidate old home notes before checkpointing more than 1000 files')
  // Validate all existing files before changing the Git index.
  const missing = []
  for (const path of paths) {
    let stat
    try { stat = await regular(join(home, path)) }
    catch (error) { if (error.code === 'ENOENT') { missing.push(path); continue } throw error }
    const limit = note(path) ? DEFAULT_HOME_LIMITS.dailyNote : DEFAULT_HOME_LIMITS[path]
    if (stat.size > limit) throw new Error(`Home checkpoint refused: ${path} exceeds ${limit} bytes`)
    const text = await readFile(join(home, path), 'utf8')
    // This detects recognizable credentials, not every possible secret.
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-tan-|hubcap_|ghp_)[A-Za-z0-9_-]{12,}/.test(text)) {
      throw new Error(`Home checkpoint refused: ${path} appears to contain credentials`)
    }
  }
  for (const path of paths) {
    if (missing.includes(path)) await git(home, ['rm', '--cached', '--ignore-unmatch', '--', path])
    else await git(home, ['add', '--', path])
  }
  const changed = (await git(home, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean)
  if (changed.some(path => !managed(path))) throw new Error('Home index contains undeclared files; checkpoint refused')
  if (changed.length) await git(home, ['commit', '--quiet', '-m', 'Checkpoint agent home'])
  return { home, commit: (await git(home, ['rev-parse', 'HEAD'])).stdout.trim(), changed }
}
