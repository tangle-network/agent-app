import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, mkdirSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Repo root — the real @tangle-network/agent-app package (its package.json `exports`
// map every subpath the generated skeleton imports to a built `dist/*` artifact).
const REPO = resolve(__dirname, '..')
const CLI = join(REPO, 'create-agent-app', 'index.mjs')
const DIST = join(REPO, 'dist')

// Link the generated project's @tangle-network/* deps to this repo's real packages
// so `tsc` resolves the exact published types offline (no network install). The
// generated project depends on agent-app + the agent-eval/agent-integrations peers;
// all three already live in this repo's node_modules (agent-app IS this repo).
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
  // agent-app → repo root (has package.json `exports` + the built `dist`).
  symlinkSync(REPO, join(scope, 'agent-app'), 'dir')
  for (const peer of ['agent-eval', 'agent-integrations', 'agent-knowledge', 'agent-runtime']) {
    link(join(scope, peer), join(REPO, 'node_modules', '@tangle-network', peer))
  }
  // tsc + its lib, node types, and vitest (a generated-project devDependency) —
  // resolved to their real pnpm paths so transitive types resolve offline.
  link(join(nm, 'typescript'), join(REPO, 'node_modules', 'typescript'))
  link(join(nm, '@types', 'node'), join(REPO, 'node_modules', '@types', 'node'))
  link(join(nm, 'vitest'), join(REPO, 'node_modules', 'vitest'))
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
  })

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
