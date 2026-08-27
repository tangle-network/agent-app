import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, existsSync, mkdirSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Repo root — the real @tangle-network/agent-app package (its package.json `exports`
// map every subpath the generated skeleton imports to a built `dist/*` artifact).
const REPO = resolve(__dirname, '..')
const CLI = join(REPO, 'create-agent-app', 'index.mjs')
const DIST = join(REPO, 'dist')

// Link the generated project's @tangle-network/* deps to this repo's real packages
// so `tsc` + `vitest` resolve the exact published types/artifacts offline (no
// network install).
function link(dest: string, src: string) {
  if (!existsSync(src)) return
  mkdirSync(join(dest, '..'), { recursive: true })
  // Resolve through pnpm's symlink farm to the package's real on-disk location so
  // the linked package's OWN dependencies (its `.pnpm` peer graph) still resolve.
  symlinkSync(realpathSync(src), dest, 'dir')
}

function linkDeps(projectDir: string) {
  const nm = join(projectDir, 'node_modules')
  const scope = join(nm, '@tangle-network')
  mkdirSync(scope, { recursive: true })
  // agent-app: COPY the published payload (package.json `exports` + built
  // `dist`), do NOT symlink the repo root. A symlink lets Node walk up into the
  // repo's own node_modules, silently resolving engine packages the template
  // never declared — masking exactly the missing-peer bug class this suite must
  // catch. The copy has no parent node_modules, like a real registry install.
  const appDir = join(scope, 'agent-app')
  mkdirSync(join(appDir, 'dist'), { recursive: true })
  cpSync(join(REPO, 'package.json'), join(appDir, 'package.json'))
  cpSync(DIST, join(appDir, 'dist'), { recursive: true })
  // Engine packages: link exactly what the GENERATED package.json declares — no
  // more. This mirrors a user's `pnpm install`: a dep the template forgot to
  // declare stays unresolvable here and fails the typecheck/test below the same
  // way it fails the user (that is how the missing agent-runtime peer shipped).
  // A declared dep the repo cannot provide is template drift — fail loud.
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  const declared = new Set(
    [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]
      .flatMap((deps) => Object.keys(deps ?? {}))
      .filter((name) => name.startsWith('@tangle-network/') && name !== '@tangle-network/agent-app'),
  )
  for (const name of declared) {
    const short = name.slice('@tangle-network/'.length)
    const src = join(REPO, 'node_modules', '@tangle-network', short)
    if (!existsSync(src)) {
      throw new Error(`template declares ${name} but this repo has no installed copy to link`)
    }
    symlinkSync(realpathSync(src), join(scope, short), 'dir')
  }
  // tsc + its lib, node types, and vitest (a generated-project devDependency) —
  // resolved to their real pnpm paths so transitive types resolve offline.
  link(join(nm, 'typescript'), join(REPO, 'node_modules', 'typescript'))
  link(join(nm, '@types', 'node'), join(REPO, 'node_modules', '@types', 'node'))
  link(join(nm, 'vitest'), join(REPO, 'node_modules', 'vitest'))
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

describe('create-agent-app scaffolder', () => {
  let projectDir: string

  beforeAll(() => {
    // The skeleton imports the built subpath artifacts; require the build to exist.
    if (!existsSync(join(DIST, 'config', 'index.d.ts'))) {
      throw new Error('dist/ not built — run `pnpm build` before this test')
    }
    const tmp = mkdtempSync(join(tmpdir(), 'create-agent-app-'))
    projectDir = join(tmp, 'demo-agent')
    execFileSync('node', [CLI, projectDir, '--name', 'demo-agent'], { stdio: 'pipe' })
    linkDeps(projectDir)
  })

  it('emits the expected DATA + CODE + breadcrumb files', () => {
    const expected = [
      'agent.config.ts',
      'src/agent-app.ts',
      'src/worker.ts',
      'scripts/knowledge-ingest.mjs',
      'knowledge/README.md',
      'tests/agent-app.test.ts',
      'package.json',
      'tsconfig.json',
      'wrangler.toml',
      'AGENTS.md',
      'CLAUDE.md',
      'CUSTOMIZE.md',
      'KNOWLEDGE.md',
      '.gitignore',
    ]
    for (const f of expected) {
      expect(existsSync(join(projectDir, f)), `missing ${f}`).toBe(true)
    }
  })

  it('substitutes the project name into package.json + agent.config.ts', () => {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('demo-agent')
    expect(pkg.dependencies['@tangle-network/agent-app']).toBeTruthy()
    expect(pkg.scripts['knowledge:ingest']).toBe('node scripts/knowledge-ingest.mjs')
    const cfg = readFileSync(join(projectDir, 'agent.config.ts'), 'utf8')
    expect(cfg).toContain("name: 'demo-agent'")
    // No unsubstituted tokens leak into the output.
    expect(cfg).not.toMatch(/__[A-Z_]+__/)
    expect(JSON.stringify(pkg)).not.toMatch(/__[A-Z_]+__/)
  })

  it('template engine pins match agent-app peerDependencies (drift gate)', () => {
    const appPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const gen = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    // Every engine peer the template pins must be pinned to agent-app's own range.
    for (const [name, range] of Object.entries(gen.peerDependencies)) {
      if (!name.startsWith('@tangle-network/')) continue
      expect(appPkg.peerDependencies[name], `template pins ${name} but it is not an agent-app peer`).toBeTruthy()
      expect(range, `template pins ${name}@${range}; agent-app wants ${appPkg.peerDependencies[name]}`).toBe(
        appPkg.peerDependencies[name],
      )
    }
    // Every REQUIRED engine peer of agent-app must be declared by the template —
    // an omission is exactly the class of bug that shipped (missing agent-runtime).
    for (const [name, range] of Object.entries(appPkg.peerDependencies)) {
      if (!name.startsWith('@tangle-network/')) continue
      if (appPkg.peerDependenciesMeta?.[name]?.optional) continue
      expect(gen.peerDependencies[name], `agent-app requires peer ${name}@${range}; the template omits it`).toBe(range)
    }
    // Each pinned engine peer must come with a devDependency that installs a
    // version meeting the peer floor (otherwise `pnpm install` warns/underserves).
    for (const [name, peerRange] of Object.entries(gen.peerDependencies)) {
      const dev = gen.devDependencies[name]
      expect(dev, `${name} has a peer pin but no devDependency to install it`).toBeTruthy()
      expect(
        versionGte(minVersion(dev as string), minVersion(peerRange)),
        `${name} devDependency ${dev} is below the peer floor ${peerRange}`,
      ).toBe(true)
    }
  })

  it('the generated skeleton typechecks against the real agent-app types', () => {
    // Run the project's own `tsc --noEmit` with its own tsconfig. This is the real
    // proof: agent.config.ts + the composer + the chat route resolve every
    // @tangle-network/agent-app subpath and satisfy AgentAppConfig.
    const tsc = join(projectDir, 'node_modules', 'typescript', 'bin', 'tsc')
    let output = ''
    try {
      execFileSync('node', [tsc, '--noEmit', '--project', join(projectDir, 'tsconfig.json')], {
        cwd: projectDir,
        stdio: 'pipe',
      })
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer }
      output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
      throw new Error(`generated skeleton failed typecheck:\n${output}`)
    }
  }, 120_000)

  it("the generated skeleton's own test suite passes against the real agent-app dist", () => {
    // Run the project's `vitest run` exactly as a user would. Unlike the
    // typecheck (d.ts-level), this executes the dist chunks — so an engine
    // package a chunk `import`s at runtime but the template forgot to declare
    // (the shipped agent-runtime bug) fails here even when types resolve.
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
        timeout: 90_000,
      })
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
      const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
      throw new Error(`generated skeleton test suite failed:\n${output || e.message}`)
    }
  }, 120_000)

  it('knowledge:ingest runs (DRY) and reports the seeded knowledge dir', () => {
    const out = execFileSync('node', [join(projectDir, 'scripts', 'knowledge-ingest.mjs')], {
      cwd: projectDir,
      stdio: 'pipe',
    }).toString()
    expect(out).toContain('knowledge:ingest')
    expect(out).toContain('DRY run')
    // It discovers the declared vault source from agent.config.ts.
    expect(out).toContain('vault://knowledge')
  })
})
