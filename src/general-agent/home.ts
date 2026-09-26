import { execFile } from 'node:child_process'
import { mkdir, open, lstat, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { defaultHomeFiles, DEFAULT_HOME_LIMITS } from '../profile/home'

const exec = promisify(execFile)
export const GENERAL_HOME = '/home/agent/tangle-home'

/** Seed once, never rematerialize mutable memory over an existing home. */
export async function initializeGeneralHome(root = GENERAL_HOME): Promise<string> {
  if (!root.startsWith('/')) throw new Error('The agent home must be absolute')
  root = resolve(root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Agent home cannot be a symlink')
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { timeout: 10_000 })
  const marker = join(root, '.tangle-home-v1')
  try { await lstat(marker); return root } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const paths: string[] = []
  for (const file of defaultHomeFiles()) {
    if (file.resource.kind !== 'inline') throw new Error('Default home must be inline')
    const path = join(root, file.path)
    try {
      const handle = await open(path, 'wx', 0o600)
      try { await handle.writeFile(file.resource.content) } finally { await handle.close() }
      paths.push(file.path)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  await mkdir(join(root, 'memory'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'artifacts'), { recursive: true, mode: 0o700 })
  await git('init', '--quiet')
  // Never stage the entire workspace, environment, browser profile or artifacts.
  if (paths.length) {
    await git('add', '--', ...paths)
    await git('-c', 'user.name=Tangle agent', '-c', 'user.email=agent@tangle.tools',
      'commit', '--only', '--no-gpg-sign', '-m', 'Initialize the Tangle agent home', '--', ...paths)
  }
  const handle = await open(marker, 'w', 0o600)
  try { await handle.writeFile('1\n') } finally { await handle.close() }
  return root
}

export async function inspectGeneralHome(root = GENERAL_HOME) {
  const files: Record<string, { bytes: number; limit: number; withinLimit: boolean }> = {}
  for (const [name, limit] of Object.entries(DEFAULT_HOME_LIMITS)) {
    if (!name.endsWith('.md')) continue
    const data = await readFile(join(root, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0)
      throw error
    })
    files[name] = { bytes: data.length, limit, withinLimit: data.length <= limit }
  }
  const { stdout } = await exec('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 10_000 })
  return { root, head: stdout.trim(), files }
}
