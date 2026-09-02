import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PNPM_VERSION = '11.24.0'
const NPM_VERSION = '12.0.2'
const NODE_RANGE = '>=22.13'
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const PACK_TIMEOUT_MS = 2 * 60 * 1000
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const createAgentAppDir = join(repo, 'create-agent-app')
const require = createRequire(import.meta.url)
const npmPackagePath = require.resolve('npm/package.json')
const npmCli = join(dirname(npmPackagePath), 'bin', 'npm-cli.js')
const dependencyCohort = process.env.AGENT_APP_TEST_COHORT
  ? JSON.parse(process.env.AGENT_APP_TEST_COHORT)
  : {}

function commandLabel(command, args) {
  return [command, ...args].map((value) => JSON.stringify(value)).join(' ')
}

function assertSuccess(result, label) {
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${label} timed out`)
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} exited with status ${result.status ?? 'unknown'}`)
  }
}

function run(command, args, { cwd = repo, env, timeout = COMMAND_TIMEOUT_MS } = {}) {
  const label = commandLabel(command, args)
  process.stdout.write(`\n$ ${label}\n`)
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    timeout,
  })
  assertSuccess(result, label)
}

function capture(command, args, { cwd = repo, env, timeout = COMMAND_TIMEOUT_MS } = {}) {
  const label = commandLabel(command, args)
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 20 * 1024 * 1024,
    timeout,
  })
  if (result.status !== 0 || result.error) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
  }
  assertSuccess(result, label)
  return result.stdout
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function assertPaths(pack, expectedPaths) {
  const files = new Map(pack.files.map((file) => [file.path, file]))
  for (const path of expectedPaths) {
    if (!files.has(path)) {
      throw new Error(`${pack.name} tarball is missing ${path}`)
    }
  }
  return files
}

function packPackage(cwd, destination, env) {
  const output = capture(
    process.execPath,
    [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd, env, timeout: PACK_TIMEOUT_MS },
  )
  const packs = Object.values(JSON.parse(output))
  if (packs.length !== 1) {
    throw new Error(`npm pack returned ${packs.length} results for ${cwd}`)
  }
  return packs[0]
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function applyDependencyCohort(manifest, cohort, variant) {
  for (const [name, version] of Object.entries(cohort)) {
    let found = false
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (manifest[section]?.[name] !== undefined) {
        manifest[section][name] = version
        found = true
      }
    }
    if (!found) throw new Error(`${variant} generated project does not declare cohort package ${name}`)
  }
}

function assertGeneratedPeerFloors(project, env) {
  const source = [
    "import { checkAllPeerFloors } from '@tangle-network/agent-app/peer-floors'",
    'const reports = checkAllPeerFloors({ appDir: process.cwd() })',
    'const violations = reports.flatMap((report) => report.violations)',
    "if (violations.length > 0) throw new Error(JSON.stringify(violations))",
    "process.stdout.write(`all ${reports.length} installed Tangle peer contracts satisfied\\n`)",
  ].join('\n')
  run(process.execPath, ['--input-type=module', '--eval', source], { cwd: project, env })
}

function assertToolVersions(env) {
  const npmPackage = JSON.parse(readFileSync(npmPackagePath, 'utf8'))
  assertEqual(npmPackage.version, NPM_VERSION, 'installed npm package version')
  assertEqual(
    capture(process.execPath, [npmCli, '--version'], { env, timeout: PACK_TIMEOUT_MS }).trim(),
    NPM_VERSION,
    'npm executable version',
  )
  assertEqual(
    capture('pnpm', ['--version'], { env, timeout: PACK_TIMEOUT_MS }).trim(),
    PNPM_VERSION,
    'pnpm executable version',
  )
}

function installAndRunScaffolder({
  env,
  packedAgentApp,
  packedCreateAgentApp,
  packedVersion,
  scratch,
  variant,
}) {
  const storeDir = join(scratch, 'store')
  const runner = join(scratch, 'runners', variant)
  const project = join(scratch, 'projects', variant)
  mkdirSync(runner, { recursive: true })
  writeJson(join(runner, 'package.json'), {
    name: `generated-${variant}-runner`,
    version: '0.0.0',
    private: true,
    engines: { node: NODE_RANGE },
    packageManager: `pnpm@${PNPM_VERSION}`,
    dependencies: {
      '@tangle-network/create-agent-app': `file:${packedCreateAgentApp}`,
    },
  })

  // The runner carries no pnpm-workspace.yaml of its own, so pnpm's
  // workspace-root search walks up out of the scratch dir and can land on a
  // stray pnpm-workspace.yaml in the OS temp dir (or whatever TMPDIR points
  // into). pnpm then installs THAT workspace — printing "Already up to date"
  // while never creating the runner's node_modules — and the gate dies with
  // ENOENT reading the scaffolder's installed package.json. --ignore-workspace
  // pins this install to the runner directory alone. The generated project
  // needs no such flag: its template pnpm-workspace.yaml already makes it its
  // own workspace root.
  run(
    'pnpm',
    ['install', '--ignore-workspace', '--ignore-scripts', '--strict-peer-dependencies', '--store-dir', storeDir],
    { cwd: runner, env },
  )

  const installedPackage = JSON.parse(
    readFileSync(join(runner, 'node_modules', '@tangle-network', 'create-agent-app', 'package.json'), 'utf8'),
  )
  assertEqual(installedPackage.version, packedVersion, `${variant} installed scaffolder version`)
  assertEqual(installedPackage.bin?.['create-agent-app'], 'index.mjs', `${variant} installed scaffolder bin`)

  const installedCli = join(runner, 'node_modules', '.bin', 'create-agent-app')
  if ((statSync(installedCli).mode & 0o111) === 0) {
    throw new Error(`${variant} installed create-agent-app bin is not executable`)
  }

  const cliArgs = [project, '--name', `generated-${variant}`]
  if (variant === 'chat') cliArgs.push('--chat')
  run(installedCli, cliArgs, { cwd: runner, env, timeout: PACK_TIMEOUT_MS })

  const packagePath = join(project, 'package.json')
  const renovatePath = join(project, 'renovate.json')
  const workspacePath = join(project, 'pnpm-workspace.yaml')
  const workspaceBeforeInstall = readFileSync(workspacePath, 'utf8')
  if (!workspaceBeforeInstall.includes('strictPeerDependencies: true')) {
    throw new Error(`${variant} generated project does not fail installs on incompatible peers`)
  }
  if (!workspaceBeforeInstall.includes('minimumReleaseAge: 4320')) {
    throw new Error(`${variant} generated project does not hold external releases for 72 hours`)
  }
  if (!workspaceBeforeInstall.includes('  zod: 4.4.3')) {
    throw new Error(`${variant} generated project does not pin zod to the mature workspace version`)
  }
  const generatedPackage = JSON.parse(readFileSync(packagePath, 'utf8'))
  const expectedRange = `^${packedVersion}`
  assertEqual(
    generatedPackage.dependencies?.['@tangle-network/agent-app'],
    expectedRange,
    `${variant} default @tangle-network/agent-app range`,
  )
  assertEqual(generatedPackage.packageManager, `pnpm@${PNPM_VERSION}`, `${variant} package manager`)
  assertEqual(generatedPackage.engines?.node, NODE_RANGE, `${variant} Node range`)
  assertEqual(generatedPackage.scripts?.['peer-check'], 'agent-app-peer-check', `${variant} peer check`)
  assertEqual(generatedPackage.scripts?.signoff, 'agent-app-signoff', `${variant} signoff`)
  assertEqual(readFileSync(join(project, '.nvmrc'), 'utf8').trim(), '22', `${variant} Node pin`)
  if (!existsSync(renovatePath)) throw new Error(`${variant} generated project is missing renovate.json`)
  const renovate = JSON.parse(readFileSync(renovatePath, 'utf8'))
  assertEqual(
    renovate.extends?.includes('github>tangle-network/agent-app:renovate.json'),
    true,
    `${variant} canonical dependency policy`,
  )

  applyDependencyCohort(generatedPackage, dependencyCohort, variant)
  generatedPackage.dependencies['@tangle-network/agent-app'] = `file:${packedAgentApp}`
  writeJson(packagePath, generatedPackage)

  run('pnpm', ['install', '--strict-peer-dependencies', '--store-dir', storeDir], { cwd: project, env })
  assertGeneratedPeerFloors(project, env)
  run('pnpm', ['typecheck'], { cwd: project, env })
  run('pnpm', ['test'], { cwd: project, env })
  run(
    'pnpm',
    ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', '.wrangler-dry-run'],
    { cwd: project, env },
  )
  assertEqual(
    readFileSync(workspacePath, 'utf8'),
    workspaceBeforeInstall,
    `${variant} dependency policy after install`,
  )
}

function main(scratch) {
  const home = join(scratch, 'home')
  const temp = join(scratch, 'tmp')
  const npmCache = join(scratch, 'npm-cache')
  const packsDir = join(scratch, 'packs')
  const userNpmrc = join(scratch, 'user-npmrc')
  const globalNpmrc = join(scratch, 'global-npmrc')
  for (const dir of [home, temp, npmCache, packsDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(userNpmrc, '')
  writeFileSync(globalNpmrc, '')

  const inheritedPath = process.env.PATH
  if (!inheritedPath) throw new Error('PATH is required')
  const env = {
    PATH: inheritedPath,
    CI: 'true',
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    COREPACK_HOME: join(home, '.cache', 'corepack'),
    PNPM_HOME: join(home, '.local', 'share', 'pnpm'),
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    NPM_CONFIG_USERCONFIG: userNpmrc,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'false',
    NO_COLOR: '1',
    WRANGLER_SEND_METRICS: 'false',
  }

  assertToolVersions(env)

  const agentAppPack = packPackage(repo, packsDir, env)
  const createAgentAppPack = packPackage(createAgentAppDir, packsDir, env)
  assertEqual(agentAppPack.name, '@tangle-network/agent-app', 'Agent App tarball package name')
  assertEqual(createAgentAppPack.name, '@tangle-network/create-agent-app', 'scaffolder tarball package name')
  assertEqual(createAgentAppPack.version, agentAppPack.version, 'packed package versions')

  assertPaths(agentAppPack, [
    'package.json',
    'dist/runtime/index.js',
    'dist/runtime/index.d.ts',
    'dist/studio-react/styles.d.ts',
    'dist/theme/styles.d.ts',
  ])
  const createFiles = assertPaths(createAgentAppPack, [
    'index.mjs',
    'package.json',
    'template-common/.nvmrc',
    'template-common/renovate.json',
    'template/_package.json',
    'template/_tsconfig.json',
    'template/pnpm-workspace.yaml',
    'template/src/worker.ts',
    'template/tests/agent-app.test.ts',
    'template-chat/_package.json',
    'template-chat/_tsconfig.json',
    'template-chat/pnpm-workspace.yaml',
    'template-chat/migrations/0002_agent_gateway.sql',
    'template-chat/src/gateway.ts',
    'template-chat/src/worker.ts',
    'template-chat/tests/chat-turn.e2e.test.ts',
  ])
  if ((createFiles.get('index.mjs').mode & 0o111) === 0) {
    throw new Error('create-agent-app tarball bin is not executable')
  }

  const packedAgentApp = join(packsDir, agentAppPack.filename)
  const packedCreateAgentApp = join(packsDir, createAgentAppPack.filename)
  process.stdout.write(
    `Packed ${agentAppPack.name}@${agentAppPack.version} (${agentAppPack.entryCount} files) and ` +
      `${createAgentAppPack.name}@${createAgentAppPack.version} (${createAgentAppPack.entryCount} files).\n`,
  )

  for (const variant of ['default', 'chat']) {
    installAndRunScaffolder({
      env,
      packedAgentApp,
      packedCreateAgentApp,
      packedVersion: agentAppPack.version,
      scratch,
      variant,
    })
  }
}

let scratch
try {
  scratch = mkdtempSync(join(tmpdir(), 'agent-app-generated-'))
  chmodSync(scratch, 0o700)
  main(scratch)
} finally {
  if (scratch) rmSync(scratch, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 })
}
