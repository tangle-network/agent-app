/**
 * The `--chat` scaffold gate — the CI enforcement of the one-day-chat-app
 * claim (#188 wave 3). It scaffolds the chat variant into a tmp dir, installs
 * agent-app as a COPY of the published payload (package.json + dist — no
 * repo-root symlink, so an undeclared engine dep cannot resolve through this
 * repo's node_modules), links exactly the dependencies the generated
 * package.json declares, then:
 *
 *   1. typechecks the generated app with its own tsconfig against the real
 *      published types, and
 *   2. runs the generated app's OWN vitest suite — which contains the
 *      end-to-end scenario (fake sandbox producer → POST turn → NDJSON stream
 *      consumed → user+assistant rows persisted with typed parts → buffered
 *      replay) over the REAL migration SQL.
 *
 * If any shell factory the template composes changes shape, this test reds
 * before the drift ships.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, existsSync, mkdirSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(__dirname, '..')
const CLI = join(REPO, 'create-agent-app', 'index.mjs')
const DIST = join(REPO, 'dist')

function link(dest: string, src: string, required = true) {
  if (!existsSync(src)) {
    if (required) throw new Error(`chat template needs ${src} but this repo has no installed copy to link`)
    return
  }
  mkdirSync(join(dest, '..'), { recursive: true })
  // Resolve through pnpm's symlink farm to the package's real on-disk location
  // so the linked package's OWN dependencies (its `.pnpm` peer graph) resolve.
  symlinkSync(realpathSync(src), dest, 'dir')
}

/** Offline stand-in for `pnpm install`, hardened the same way as the base
 *  scaffold suite: agent-app is a payload COPY (its dist resolves siblings
 *  through the PROJECT's node_modules, like a registry install), and only
 *  packages the generated package.json declares get linked. */
function linkDeps(projectDir: string) {
  const nm = join(projectDir, 'node_modules')
  const scope = join(nm, '@tangle-network')
  mkdirSync(scope, { recursive: true })

  const appDir = join(scope, 'agent-app')
  mkdirSync(join(appDir, 'dist'), { recursive: true })
  cpSync(join(REPO, 'package.json'), join(appDir, 'package.json'))
  cpSync(DIST, join(appDir, 'dist'), { recursive: true })

  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  const declared = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]
    .flatMap((deps) => Object.keys(deps ?? {}))
    .filter((name) => name !== '@tangle-network/agent-app')

  // Wrangler is a declared devDependency the tests never execute; linking the
  // whole CLI tree buys nothing. Everything else the template declares must be
  // linkable from this repo — a declared dep the repo cannot provide is drift.
  const skip = new Set(['wrangler'])
  for (const name of new Set(declared)) {
    if (skip.has(name)) continue
    link(join(nm, name), join(REPO, 'node_modules', name))
  }
  // agent-app's own runtime dependency (zod) plus the sandbox SDK's peer graph
  // resolve through the copied payload's parent — the project's node_modules —
  // exactly as they would after a real install.
  link(join(nm, 'zod'), join(REPO, 'node_modules', 'zod'))
}

// "1.2.3" (after stripping a `^`/`>=` prefix) → comparable numeric tuple.
function minVersion(range: string): number[] {
  return range.replace(/^[~^>=\s]+/, '').split('.').map(Number)
}

function versionGte(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

describe('create-agent-app --chat scaffolder', () => {
  let projectDir: string

  beforeAll(() => {
    if (!existsSync(join(DIST, 'chat-routes', 'index.d.ts'))) {
      throw new Error('dist/ not built — run `pnpm build` before this test')
    }
    const tmp = mkdtempSync(join(tmpdir(), 'create-agent-app-chat-'))
    projectDir = join(tmp, 'demo-chat')
    execFileSync('node', [CLI, projectDir, '--name', 'demo-chat', '--chat'], { stdio: 'pipe' })
    linkDeps(projectDir)
  })

  it('emits the chat vertical: config, composer, sandbox lane, migration, dev page, its own e2e test', () => {
    const expected = [
      'agent.config.ts',
      'prompts/system.md',
      'declarations.d.ts',
      'src/chat.ts',
      'src/sandbox.ts',
      'src/worker.ts',
      'src/env.ts',
      'src/db/schema.ts',
      'migrations/0001_init.sql',
      'public/index.html',
      'tests/chat-turn.e2e.test.ts',
      'package.json',
      'tsconfig.json',
      'vitest.config.ts',
      'wrangler.toml',
      '.dev.vars.example',
      'AGENTS.md',
      'CLAUDE.md',
      'CUSTOMIZE.md',
      'README.md',
      '.gitignore',
    ]
    for (const f of expected) {
      expect(existsSync(join(projectDir, f)), `missing ${f}`).toBe(true)
    }
  })

  it('substitutes tokens across package.json, agent.config.ts, wrangler.toml, and the dev page', () => {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('demo-chat')
    expect(pkg.dependencies['@tangle-network/agent-app']).toBeTruthy()
    const cfg = readFileSync(join(projectDir, 'agent.config.ts'), 'utf8')
    expect(cfg).toContain("name: 'demo-chat'")
    for (const file of ['agent.config.ts', 'wrangler.toml', 'public/index.html', 'prompts/system.md']) {
      expect(readFileSync(join(projectDir, file), 'utf8'), `unsubstituted token in ${file}`).not.toMatch(/__[A-Z_]+__/)
    }
    expect(JSON.stringify(pkg)).not.toMatch(/__[A-Z_]+__/)
    const wrangler = readFileSync(join(projectDir, 'wrangler.toml'), 'utf8')
    expect(wrangler).toContain('migrations_dir = "migrations"')
  })

  it('template engine pins satisfy agent-app peerDependencies (drift gate)', () => {
    const appPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const gen = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    // Every @tangle-network engine the template declares (as a runtime dep or a
    // peer pin) must be an agent-app peer, at or above agent-app's floor.
    const declaredEngines: Record<string, string> = {
      ...gen.peerDependencies,
      ...gen.dependencies,
    }
    for (const [name, range] of Object.entries(declaredEngines)) {
      if (!name.startsWith('@tangle-network/') || name === '@tangle-network/agent-app') continue
      const floor = appPkg.peerDependencies[name]
      expect(floor, `template declares ${name} but it is not an agent-app peer`).toBeTruthy()
      expect(
        versionGte(minVersion(range), minVersion(floor as string)),
        `template pins ${name}@${range}, below agent-app's peer floor ${floor}`,
      ).toBe(true)
    }
    // The engines the chat vertical imports at module top must ride as REAL
    // dependencies — a generated app is an application, not a library.
    for (const name of [
      '@tangle-network/agent-runtime',
      '@tangle-network/sandbox',
      '@tangle-network/agent-interface',
      'better-auth',
      'drizzle-orm',
    ]) {
      expect(gen.dependencies[name], `missing runtime dependency ${name}`).toBeTruthy()
    }
    // agent-app's REQUIRED (non-optional) engine peers must all be declared
    // somewhere installable, or `pnpm install` warns out of the box.
    for (const [name] of Object.entries(appPkg.peerDependencies)) {
      if (!name.startsWith('@tangle-network/')) continue
      if (appPkg.peerDependenciesMeta?.[name]?.optional) continue
      expect(
        gen.dependencies[name] ?? gen.devDependencies[name],
        `agent-app requires peer ${name}; the template installs nothing for it`,
      ).toBeTruthy()
    }
  })

  it('the generated app typechecks against the real agent-app dist types', () => {
    const tsc = join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc')
    try {
      execFileSync('node', [tsc, '--noEmit', '--project', join(projectDir, 'tsconfig.json')], {
        cwd: projectDir,
        stdio: 'pipe',
      })
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer }
      const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
      throw new Error(`generated chat app failed typecheck:\n${output}`)
    }
  }, 120_000)

  it("the generated app's OWN e2e suite passes: fake producer → turn → stream → persisted parts → replay", () => {
    // This is the one-day-claim gate: the template ships a working end-to-end
    // test, and CI proves it stays working against the current shell. It also
    // executes the dist chunks for real, so an engine package a chunk imports
    // at runtime but the template forgot to declare fails here.
    const vitestCli = join(projectDir, 'node_modules', 'vitest', 'vitest.mjs')
    // Strip the parent runner's VITEST_* worker vars so the child starts clean.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')),
    ) as Record<string, string>
    try {
      execFileSync('node', [vitestCli, 'run'], {
        cwd: projectDir,
        stdio: 'pipe',
        env: { ...env, CI: 'true' },
        timeout: 120_000,
      })
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
      const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
      throw new Error(`generated chat app's own test suite failed:\n${output || e.message}`)
    }
  }, 180_000)
})
