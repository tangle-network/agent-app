import { mkdir, open, lstat, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

export const PROTECTED_HOME = '/var/lib/tangle-agent/home'
const BASE = '/var/lib/tangle-agent'
const STATE = `${BASE}/state`
const CONFIG = '/etc/tangle-agent/home.json'
const HELPER = '/usr/local/libexec/tangle-agent-home.py'
const BINDING_FILE = '.tangle-home-binding.json'
const run = promisify(execFile)
const cleanEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }

/** Identity comes only from trusted operator setup, never model arguments. */
export function validateHomeIdentity(value) {
  const record = (input, keys) => input !== null && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key))
  if (!record(value, ['workspaceId', 'stateId', 'scope'])) throw new Error('Invalid home learning identity')
  const scope = value.scope
  const subject = scope?.kind === 'personal' ? 'memberId' : scope?.kind === 'shared' ? 'groupId' : undefined
  if (!subject || !record(scope, ['kind', subject, 'agentId'])) throw new Error('Invalid home learning scope')
  if (![value.workspaceId, value.stateId, scope[subject], scope.agentId].every(field =>
    typeof field === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(field))) {
    throw new Error('Invalid home learning identity field')
  }
  return { workspaceId: value.workspaceId, stateId: value.stateId,
    scope: { kind: scope.kind, [subject]: scope[subject], agentId: scope.agentId } }
}

async function protectedEntry(path, directory = false) {
  const info = await lstat(path)
  if (info.uid !== 0 || (info.mode & 0o022) || info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
    throw new Error(`Unsafe protected home installation: ${path}`)
  }
  return info
}

/** One installed, exact-command sudo capability. No shell and no caller environment. */
export async function homeOperation(request, signal) {
  signal?.throwIfAborted()
  const input = JSON.stringify(request)
  if (Buffer.byteLength(input) > 262144) throw new Error('Home request is too large')
  // At most 8 MiB of portable text; JSON control-character escaping can expand
  // it sixfold. Ordinary single-file/status receipts retain their smaller cap.
  const maxOutput = ['snapshot', 'reconcile'].includes(request.action) ? 64 * 1024 * 1024 : 1024 * 1024
  await protectedEntry(HELPER)
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sudo', ['-n', '--', '/usr/bin/python3', '-I', HELPER], {
      cwd: '/', env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = '', errorOutput = '', size = 0, inputFailed = false, timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const stop = () => child.kill('SIGTERM')
    const timer = setTimeout(() => { timedOut = true; stop() }, 35_000)
    timer.unref()
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', bytes => {
      size += Buffer.byteLength(bytes)
      if (size > maxOutput) stop()
      else output += bytes
    })
    child.stderr.on('data', bytes => { if (errorOutput.length < 2048) errorOutput += bytes.toString('utf8') })
    child.stdin.on('error', () => { inputFailed = true })
    child.once('error', finishError)
    child.once('close', (code, killed) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) return reject(signal.reason)
      if (code !== 0 || killed || inputFailed || timedOut || size > maxOutput) {
        let detail = 'Home operation failed or is unconfirmed; inspect home_status before retrying a write'
        try { const value = JSON.parse(errorOutput); if (typeof value.error === 'string') detail = value.error }
        catch { detail = 'Protected home returned no validation receipt; inspect home_status before retrying a write' }
        return reject(new Error(detail))
      }
      try { resolve(JSON.parse(output)) } catch { reject(new Error('Invalid protected home response')) }
    })
    function finishError(error) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      reject(new Error('The protected home command could not start', { cause: error }))
    }
    child.stdin.end(input)
  })
}

/** The runtime cannot create or repair this boundary as its own UID. */
export async function initializeHome(directoryName) {
  if (directoryName !== PROTECTED_HOME || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('General agents require the installed protected home and a non-root runtime UID')
  }
  for (const directory of ['/var', '/var/lib', BASE, PROTECTED_HOME, '/etc', '/etc/tangle-agent', '/usr/local/libexec']) {
    await protectedEntry(directory, true)
  }
  await protectedEntry(CONFIG)
  const policy = JSON.parse(await readFile(CONFIG, 'utf8'))
  if (policy.runtimeUid !== process.getuid()) throw new Error('Protected home belongs to another runtime UID')
  await protectedEntry(`${PROTECTED_HOME}/AGENTS.md`)
  const digest = createHash('sha256').update(await readFile(`${PROTECTED_HOME}/AGENTS.md`)).digest('hex')
  if (digest !== policy.agentsSha256) throw new Error('Platform AGENTS.md attestation failed')
  await homeOperation({ action: 'status' })
  return PROTECTED_HOME
}

export async function checkpointHome(directoryName, signal) {
  if (directoryName !== PROTECTED_HOME) throw new Error('Invalid protected home')
  return { home: PROTECTED_HOME, ...await homeOperation({ action: 'commit' }, signal) }
}

/** Image/operator install only. Uses the same canonical profile seed records. */
export async function installProtectedHome(runtimeUser, learningIdentity = null) {
  if (process.getuid?.() !== 0 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(runtimeUser ?? '')) {
    throw new Error('install-home requires root and an explicit non-root runtime user')
  }
  const identity = learningIdentity === null ? null : validateHomeIdentity(learningIdentity)
  const uid = Number((await run('/usr/bin/id', ['-u', runtimeUser])).stdout.trim())
  const gid = Number((await run('/usr/bin/id', ['-g', runtimeUser])).stdout.trim())
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('Invalid runtime UID/GID')
  for (const [directory, mode] of [[BASE, 0o755], [PROTECTED_HOME, 0o755], [STATE, 0o700],
    ['/etc/tangle-agent', 0o755], ['/usr/local/libexec', 0o755], ['/etc/sudoers.d', 0o750]]) {
    await mkdir(directory, { recursive: true, mode })
    await protectedEntry(directory, true)
  }
  if ((await lstat(STATE)).dev !== (await lstat(PROTECTED_HOME)).dev) throw new Error('Home and journal must share one persistent filesystem')
  // Preflight both immutable volume markers before changing any seed/config.
  // Reinstalling a bound home requires the same explicit operator identity.
  let markers = 0
  for (const directory of [PROTECTED_HOME, STATE]) {
    const marker = `${directory}/${BINDING_FILE}`
    try {
      await protectedEntry(marker)
      const existing = validateHomeIdentity(JSON.parse(await readFile(marker, 'utf8')))
      if (JSON.stringify(existing) !== JSON.stringify(identity)) throw new Error('Home learning identity does not match the installed volume')
      markers++
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (markers === 1) throw new Error('Home and journal learning identity markers must be restored together')
  try {
    await protectedEntry(CONFIG)
    const previous = JSON.parse(await readFile(CONFIG, 'utf8')).identity
    if (previous != null && (markers !== 2 || JSON.stringify(validateHomeIdentity(previous)) !== JSON.stringify(identity))) {
      throw new Error('Cannot replace an existing home learning identity')
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  async function replace(path, body, mode) {
    const temporary = join(dirname(path), `.tangle-${randomUUID()}`)
    const file = await open(temporary, 'wx', mode)
    try {
      await file.writeFile(body)
      await file.sync()
      await rename(temporary, path)
      const directory = await open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      await file.close()
      try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  const { defaultHomeFiles, DEFAULT_HOME_LIMITS } = await import('../../dist/hosted-agent/index.js')
  const seeds = defaultHomeFiles().filter(mount => mount.path !== '.tangle/home.py')
  const agents = seeds.find(mount => mount.path === 'AGENTS.md')?.resource.content
  if (!agents) throw new Error('The installed package has no canonical AGENTS.md')
  let initialized = false
  try { await protectedEntry(`${STATE}/initialized`); initialized = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const mount of seeds) {
    if (mount.resource.kind !== 'inline' || !Object.hasOwn(DEFAULT_HOME_LIMITS, mount.path)) throw new Error('Unsupported home seed')
    if (initialized && mount.path !== 'AGENTS.md') continue
    const path = `${PROTECTED_HOME}/${mount.path}`
    try {
      await protectedEntry(path)
      if (mount.path !== 'AGENTS.md') continue
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await replace(path, mount.resource.content, 0o444)
  }
  if (identity) for (const directory of [PROTECTED_HOME, STATE]) {
    await replace(`${directory}/${BINDING_FILE}`, JSON.stringify(identity), directory === STATE ? 0o400 : 0o444)
  }
  await replace(CONFIG, JSON.stringify({ runtimeUid: uid, caps: DEFAULT_HOME_LIMITS, identity,
    agentsSha256: createHash('sha256').update(agents).digest('hex') }), 0o444)
  await replace(HELPER, await readFile(new URL('./home-maintenance.py', import.meta.url)), 0o444)
  // Verify inherited sudoers ordering rather than silently leaving a broad grant.
  const policyFile = '/etc/sudoers.d/zz-tangle-agent-home'
  await replace(policyFile, `Defaults:${runtimeUser} env_reset,secure_path="/usr/bin:/bin"\n` +
    `${runtimeUser} ALL=(ALL:ALL) !ALL\n` +
    `${runtimeUser} ALL=(root) NOPASSWD: NOSETENV: /usr/bin/python3 -I ${HELPER}\n`, 0o440)
  await run('/usr/sbin/visudo', ['-cf', policyFile], { env: cleanEnv })
  let rootCommandDenied = false
  try { await run('/usr/bin/sudo', ['-n', '--', '/usr/bin/id', '-u'], { uid, gid, env: cleanEnv }) }
  catch (error) { if (error.code === 1) rootCommandDenied = true; else throw error }
  if (!rootCommandDenied) throw new Error('Runtime still has a broad sudo grant; refuse the image')
  const status = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sudo', ['-n', '--', '/usr/bin/python3', '-I', HELPER],
      { uid, gid, cwd: '/', env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', bytes => { output += bytes.toString() })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', code => {
      try { if (code !== 0) throw new Error('Privileged home command did not pass its real UID probe'); resolve(JSON.parse(output)) }
      catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify({ action: 'status' }))
  })
  if (!status.commit) throw new Error('Protected home has no Git checkpoint')
  await replace(`${STATE}/initialized`, 'tangle-agent-home-v2\n', 0o400)
  return { home: PROTECTED_HOME, runtimeUid: uid, commit: status.commit, identity, checkpointScope: 'local' }
}
