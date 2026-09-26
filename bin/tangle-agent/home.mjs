import { mkdir, open, lstat, link, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { defaultHomeFiles } from '../../dist/hosted-agent/index.js'

const run = promisify(execFile)
const fixed = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'BOOTSTRAP.md', '.tangle/home.py'])
async function regular(path) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Agent home contains a linked or non-regular managed file')
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
/** Adapter over the kit's canonical defaultHomeFiles and home maintenance command. */
export async function initializeHome(directoryName) {
  const home = resolve(directoryName)
  await mkdir(home, { recursive: true, mode: 0o700 })
  await directory(home)
  const marker = join(home, '.initialized')
  try { await regular(marker); return home }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(join(home, '.tangle'), { recursive: true, mode: 0o700 })
  await directory(join(home, '.tangle'))
  for (const mount of defaultHomeFiles()) {
    if (!fixed.has(mount.path) || mount.resource.kind !== 'inline') throw new Error('Unsupported default home mount')
    await directory(dirname(join(home, mount.path)))
    await createOnce(join(home, mount.path), mount.resource.content,
      ['AGENTS.md', '.tangle/home.py'].includes(mount.path) ? 0o400 : 0o600)
  }
  await checkpointHome(home)
  await createOnce(marker, 'tangle-agent-home-v1\n', 0o400)
  const root = await open(home, 'r')
  try { await root.sync() } finally { await root.close() }
  return home
}

/** No second Git implementation. The existing kit command owns paths, caps, locks and commits. */
export async function checkpointHome(directoryName) {
  const home = resolve(directoryName)
  await directory(home)
  await directory(join(home, '.tangle'))
  await regular(join(home, '.tangle/home.py'))
  const { stdout } = await run('python3', [join(home, '.tangle/home.py'), 'commit'], {
    cwd: home, timeout: 30_000, maxBuffer: 1024 * 1024,
  })
  const result = JSON.parse(stdout)
  if (!result || typeof result !== 'object' || typeof result.commit !== 'string') {
    throw new Error('Home checkpoint did not return a Git commit')
  }
  return { home, ...result }
}
