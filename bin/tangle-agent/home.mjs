import { mkdir, open, lstat, readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { defaultHomeFiles, DEFAULT_HOME_LIMITS } from '../../dist/profile/index.js'

const run = promisify(execFile)
const fixed = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'BOOTSTRAP.md'])
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Tangle agent', GIT_AUTHOR_EMAIL: 'agent@localhost',
  GIT_COMMITTER_NAME: 'Tangle agent', GIT_COMMITTER_EMAIL: 'agent@localhost' }
for (const key of Object.keys(gitEnv)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete gitEnv[key]
}
async function git(home, args) {
  return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '--git-dir', join(home, '.git'), '--work-tree', home, ...args], {
    cwd: home, env: gitEnv, timeout: 30_000, maxBuffer: 1024 * 1024,
  })
}
async function regular(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Agent home contains a non-regular managed file')
  return stat
}
/** Write-once bootstrap: a resumed agent never remounts empty MEMORY.md over its history. */
export async function initializeHome(directory) {
  const home = resolve(directory)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const root = await lstat(home)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Agent home must be a real directory')
  for (const mount of defaultHomeFiles()) {
    if (!fixed.has(mount.path) || mount.resource.kind !== 'inline') throw new Error('Unsupported default home mount')
    const path = join(home, mount.path)
    let file
    try { file = await open(path, 'wx', mount.path === 'AGENTS.md' ? 0o400 : 0o600) }
    catch (error) { if (error.code !== 'EEXIST') throw error; await regular(path); continue }
    try { await file.writeFile(mount.resource.content, 'utf8'); await file.sync() }
    finally { await file.close() }
  }
  await mkdir(join(home, 'memory'), { recursive: true, mode: 0o700 })
  const gitPath = join(home, '.git')
  try {
    const stat = await lstat(gitPath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Agent home git directory must not redirect elsewhere')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await run('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', home], { env: gitEnv, timeout: 30_000 })
  }
  // Existing user files are never overwritten; the first checkpoint records only
  // declared home notes. Credentials, transcripts and arbitrary workspace files
  // are never swept into this repository by a broad `git add .`.
  await checkpointHome(home)
  return home
}

export async function checkpointHome(directory) {
  const home = resolve(directory)
  const paths = [...fixed]
  const notes = await readdir(join(home, 'memory'), { withFileTypes: true })
  for (const note of notes) {
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(note.name)) paths.push(`memory/${note.name}`)
  }
  for (const path of paths) {
    let stat
    try { stat = await regular(join(home, path)) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const limit = path.startsWith('memory/') ? DEFAULT_HOME_LIMITS.dailyNote : DEFAULT_HOME_LIMITS[path]
    if (stat.size > limit) throw new Error(`Home checkpoint refused: ${path} exceeds ${limit} bytes; consolidate it first`)
    // Detection is deliberately not represented as a complete secret classifier.
    const text = await readFile(join(home, path), 'utf8')
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-tan-|hubcap_|ghp_)[A-Za-z0-9_-]{12,}/.test(text)) {
      throw new Error(`Home checkpoint refused: ${path} appears to contain credentials`)
    }
    await git(home, ['add', '--', path])
  }
  const changed = (await git(home, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean)
  if (changed.some(path => !paths.includes(path))) throw new Error('Home index contains undeclared files; checkpoint refused')
  if (changed.length) await git(home, ['commit', '--quiet', '-m', 'Checkpoint agent home'])
  const commit = (await git(home, ['rev-parse', 'HEAD'])).stdout.trim()
  return { home, commit, changed }
}
