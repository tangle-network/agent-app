import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatSignoffLine, formatSignoffReport, peakConcurrency } from './report'
import { runSignoff } from './run'

/**
 * End to end, against a real git repository, with real subprocesses. Nothing is
 * mocked: the install and every step are actual commands, so what these tests
 * pin is what a consumer gets.
 *
 * The install is a `node` one-liner rather than `pnpm` so the suite needs no
 * network. Everything the gate itself owns — clean tree, store keying, the
 * graph, seeds, fail-fast, the report — is exercised for real.
 */

const created: string[] = []
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

const INSTALL = `node -e "require('fs').writeFileSync('installed.txt', process.env.SIGNOFF_TEST_STORE || 'none')"`

interface RepoOptions {
  readonly steps: string
  readonly install?: string
}

function fixtureRepo(options: RepoOptions): string {
  const repo = temp('signoff-e2e-')
  git(['init', '--quiet', '--initial-branch=main'], repo)
  // See workspace.test.ts: fixtures do not run the developer's global hooks.
  git(['config', 'core.hooksPath', '/dev/null'], repo)
  git(['config', 'user.email', 'signoff@example.invalid'], repo)
  git(['config', 'user.name', 'signoff test'], repo)
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n.vite\ninstalled.txt\nout\n')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true }))
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  // A real script rather than `node -e`, because `-e` parses trailing arguments
  // as NODE options and rejects `--sequence.seed=N` outright — which is the
  // same asymmetry that made the `--` separator look necessary.
  writeFileSync(
    join(repo, 'logargs.mjs'),
    "import { appendFileSync } from 'node:fs'\n" +
      "appendFileSync(process.env.SIGNOFF_LOG, `${process.argv[2]}|${process.argv.slice(3).join(' ')}\\n`)\n",
  )
  writeFileSync(
    join(repo, 'signoff.config.mjs'),
    `export default {
  install: {
    run: ${JSON.stringify(options.install ?? INSTALL)},
    storeDirFlag: null,
    storeEnv: 'SIGNOFF_TEST_STORE',
  },
  steps: ${options.steps},
}
`,
  )
  git(['add', '.'], repo)
  git(['commit', '--quiet', '-m', 'initial'], repo)
  return repo
}

/** Records this step's name and argv into a shared log the test can read. */
function logStep(name: string): string {
  return `node logargs.mjs ${name}`
}

/**
 * Every test in this suite runs REAL work: `git init`, a real commit, a real
 * `git worktree add`, a real install command and a real step graph of
 * subprocesses. Several run `runSignoff` twice. Vitest's default 5 000 ms is a
 * budget for a unit test, and against this shape it is a stopwatch on the
 * machine rather than an assertion about the gate.
 *
 * It has already fired in exactly that way: `pnpm signoff --source head` at
 * a9e2995 went red on "the one-line summary carries the verdict…" — timed out
 * at 5 000 ms while the same test measures ~1 s idle and passes 14 of 14 runs.
 * Nothing about the gate was broken; the box was carrying other work, and this
 * gate manufactures its own load (`maxParallel: 4`, plus a second shuffled pass
 * over the whole suite). A merge gate that goes red because the machine was
 * busy is a gate people learn to re-run instead of read, and `docs/
 * local-signoff.md` already names the remedy: do not encode machine speed in a
 * per-test timeout.
 *
 * So the budget here is generous and deliberate. It is not a performance
 * assertion — a genuinely hung subprocess still fails, two orders of magnitude
 * later, and the gate's OWN `timeoutMs` is what pins step-level hangs (see the
 * `hangs` fixture below).
 */
const E2E_TIMEOUT_MS = 120_000

describe('runSignoff (end to end)', { timeout: E2E_TIMEOUT_MS }, () => {
  it('runs every declared step in a clean tree and reports a pass', async () => {
    const log = join(temp('signoff-log-'), 'log.txt')
    writeFileSync(log, '')
    const repo = fixtureRepo({
      steps: `[
        { name: 'typecheck', run: ${JSON.stringify(logStep('typecheck'))} },
        { name: 'build', run: ${JSON.stringify(logStep('build'))} },
      ]`,
    })
    process.env.SIGNOFF_LOG = log
    try {
      const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head' })

      expect(report.ok).toBe(true)
      expect(report.steps.map((step) => step.status)).toEqual(['passed', 'passed'])
      expect(report.install.exitCode).toBe(0)
      expect(readFileSync(log, 'utf8').trim().split('\n').sort()).toEqual(['build|', 'typecheck|'])
      // The install really ran inside the clean tree, not the developer's.
      expect(existsSync(join(repo, 'installed.txt'))).toBe(false)
    } finally {
      delete process.env.SIGNOFF_LOG
    }
  })

  it('the one-line summary carries the verdict, the commit it judged, and the step tally', async () => {
    // CLAUDE.md accepts this line as PR proof in place of the report block, and
    // `--quiet` prints it. Both readings depend on the sha and the tally being
    // the run's real ones, not the shape of the sentence.
    const passing = fixtureRepo({
      steps: `[
        { name: 'typecheck', run: "node -e \\"process.exit(0)\\"" },
        { name: 'tests', run: "node -e \\"process.exit(0)\\"" },
      ]`,
    })
    const green = await runSignoff({ repoDir: passing, cacheDir: temp('signoff-cache-'), source: 'head' })
    const greenLine = formatSignoffLine(green)
    expect(greenLine).toContain('signoff PASS')
    expect(greenLine).toContain(green.repo.head.slice(0, 12))
    expect(greenLine).toContain('2/2 steps')
    expect(greenLine).toContain(`seed ${green.seedBase}`)
    expect(greenLine.split('\n')).toHaveLength(1)

    const failing = fixtureRepo({
      steps: `[
        { name: 'typecheck', run: "node -e \\"process.exit(1)\\"" },
      ]`,
    })
    const red = await runSignoff({ repoDir: failing, cacheDir: temp('signoff-cache-'), source: 'head' })
    const redLine = formatSignoffLine(red)
    expect(redLine).toContain('signoff FAIL')
    expect(redLine).toContain('0/1 steps')
  })

  it('a gitignored stale artifact in the developer checkout is NOT in the tree the steps see', async () => {
    // The whole thesis in one assertion: today's bug survived locally because a
    // warm cache was present. If it can reach the run, the gate is theatre.
    const repo = fixtureRepo({
      steps: `[
        { name: 'no stale cache', run: "node -e \\"if (require('fs').existsSync('.vite')) { console.error('STALE CACHE PRESENT'); process.exit(3) }\\"" },
      ]`,
    })
    mkdirSync(join(repo, '.vite'), { recursive: true })
    writeFileSync(join(repo, '.vite', 'deps.json'), '{"warm":true}')

    const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'working-tree' })
    expect(report.ok).toBe(true)
  })

  it('names the failing step, its exit code and its output — never a bare red line', async () => {
    const repo = fixtureRepo({
      steps: `[
        { name: 'typecheck', run: "node -e \\"console.error('src/a.ts(3,1): error TS2304'); process.exit(2)\\"" },
      ]`,
    })
    const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head' })

    expect(report.ok).toBe(false)
    const step = report.steps[0]
    expect(step?.status).toBe('failed')
    expect(step?.attempts[0]?.exitCode).toBe(2)
    expect(step?.attempts[0]?.output).toContain('error TS2304')

    const text = formatSignoffReport(report)
    expect(text).toContain('SIGN-OFF FAILED')
    expect(text).toContain('FAILED: typecheck')
    expect(text).toContain('error TS2304')
  })

  it('fail-fast stops the rest; --keep-going runs them and still refuses to judge a blocked step', async () => {
    const steps = `[
      { name: 'typecheck', run: "node -e \\"process.exit(1)\\"" },
      { name: 'tests', run: "node -e \\"process.exit(0)\\"" },
      { name: 'generated', needs: ['typecheck'], run: "node -e \\"process.exit(0)\\"" },
    ]`
    const cacheDir = temp('signoff-cache-')

    const strict = await runSignoff({ repoDir: fixtureRepo({ steps }), cacheDir, source: 'head', maxParallel: 1 })
    expect(strict.steps.find((step) => step.name === 'tests')?.status).toBe('skipped')

    const wide = await runSignoff({
      repoDir: fixtureRepo({ steps }),
      cacheDir,
      source: 'head',
      keepGoing: true,
      maxParallel: 1,
    })
    expect(wide.steps.find((step) => step.name === 'tests')?.status).toBe('passed')
    expect(wide.steps.find((step) => step.name === 'generated')?.status).toBe('blocked')
    expect(wide.ok).toBe(false)
  })

  it('runs a shuffled step once per seed and records every seed in the proof', async () => {
    const logDir = temp('signoff-log-')
    const log = join(logDir, 'log.txt')
    writeFileSync(log, '')
    const repo = fixtureRepo({
      steps: `[
        { name: 'unit tests', run: ${JSON.stringify(logStep('tests'))}, shuffle: true },
      ]`,
    })

    process.env.SIGNOFF_LOG = log
    try {
      const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head', seed: 4242 })
      const attempts = report.steps[0]?.attempts ?? []
      expect(attempts).toHaveLength(2)
      const seeds = attempts.map((attempt) => attempt.seed)
      expect(new Set(seeds).size).toBe(2)

      const lines = readFileSync(log, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      for (const seed of seeds) expect(lines.some((line) => line.includes(`--sequence.seed=${seed}`))).toBe(true)

      // Same base seed reproduces the same orders — the recorded-seed contract.
      const replay = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head', seed: 4242 })
      expect(replay.steps[0]?.attempts.map((attempt) => attempt.seed)).toEqual(seeds)
    } finally {
      delete process.env.SIGNOFF_LOG
    }
  })

  it('stops at the first failing order and keeps the seed that found it', async () => {
    const repo = fixtureRepo({
      steps: `[
        { name: 'flaky', run: "node -e \\"process.exit(1)\\"", shuffle: { runs: 3 } },
      ]`,
    })
    const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head', seed: 7 })
    const attempts = report.steps[0]?.attempts ?? []
    // Three seeds were planned; the run stops at the order that went red.
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.seed).not.toBeNull()
    expect(formatSignoffReport(report)).toContain(`seed      ${attempts[0]?.seed}`)
  })

  it('overlaps independent steps and reports the measured wall-clock win', async () => {
    const sleeper = (ms: number) => `node -e "setTimeout(() => {}, ${ms})"`
    const repo = fixtureRepo({
      steps: `[
        { name: 'a', run: ${JSON.stringify(sleeper(400))} },
        { name: 'b', run: ${JSON.stringify(sleeper(400))} },
        { name: 'c', run: ${JSON.stringify(sleeper(400))} },
      ]`,
    })
    const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head' })

    expect(report.ok).toBe(true)
    expect(peakConcurrency(report.steps)).toBe(3)
    const stepsWall = Math.max(...report.steps.map((step) => step.finishedAtMs ?? 0))
    const stepsSerial = report.steps.reduce((total, step) => total + step.durationMs, 0)
    expect(stepsSerial).toBeGreaterThan(stepsWall * 1.8)
  })

  it('reuses the store when the lockfile is unchanged and goes cold when it moves', async () => {
    const cacheDir = temp('signoff-cache-')
    const repo = fixtureRepo({ steps: `[{ name: 'noop', run: "node -e \\"\\"" }]` })

    const cold = await runSignoff({ repoDir: repo, cacheDir, source: 'head' })
    expect(cold.install.cacheHit).toBe(false)
    // The install writes into the store dir, which is what makes it a hit next time.
    writeFileSync(join(cold.install.storeDir, 'files'), 'blob')

    const warm = await runSignoff({ repoDir: repo, cacheDir, source: 'head' })
    expect(warm.install.cacheHit).toBe(true)
    expect(warm.install.cacheKey).toBe(cold.install.cacheKey)

    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# moved\n')
    git(['commit', '--quiet', '-am', 'bump lockfile'], repo)
    const bumped = await runSignoff({ repoDir: repo, cacheDir, source: 'head' })
    expect(bumped.install.cacheKey).not.toBe(cold.install.cacheKey)
    expect(bumped.install.cacheHit).toBe(false)
  })

  it('a failed install fails the run and marks every step unjudged, never "0 failures"', async () => {
    const repo = fixtureRepo({
      steps: `[{ name: 'typecheck', run: "node -e \\"process.exit(0)\\"" }]`,
      install: `node -e "console.error('ERR_PNPM_OUTDATED_LOCKFILE'); process.exit(1)"`,
    })
    const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head' })

    expect(report.ok).toBe(false)
    expect(report.install.exitCode).toBe(1)
    expect(report.steps.every((step) => step.status === 'skipped')).toBe(true)
    const text = formatSignoffReport(report)
    expect(text).toContain('install FAILED')
    expect(text).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
  })

  it('kills a step that runs past its timeout instead of hanging the gate', async () => {
    const repo = fixtureRepo({
      steps: `[{ name: 'hangs', run: "node -e \\"setInterval(() => {}, 1000)\\"", timeoutMs: 700 }]`,
    })
    const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head' })
    expect(report.ok).toBe(false)
    expect(report.steps[0]?.attempts[0]?.timedOut).toBe(true)
    expect(formatSignoffReport(report)).toContain('TIMED OUT')
  })

  it('removes the clean tree by default and keeps it on request', async () => {
    const repo = fixtureRepo({ steps: `[{ name: 'noop', run: "node -e \\"\\"" }]` })
    const cacheDir = temp('signoff-cache-')

    const removed = await runSignoff({ repoDir: repo, cacheDir, source: 'head' })
    expect(existsSync(removed.workspace)).toBe(false)

    const kept = await runSignoff({ repoDir: repo, cacheDir, source: 'head', keepWorkspace: true })
    expect(existsSync(kept.workspace)).toBe(true)
    expect(kept.workspaceRetained).toBe(true)
  })

  it('the proof names the bytes verified and the command that reproduces it', async () => {
    const repo = fixtureRepo({ steps: `[{ name: 'noop', run: "node -e \\"\\"" }]` })
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, version: '0.0.1' }))

    const report = await runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'working-tree', seed: 31337 })
    expect(report.repo.dirty).toBe(true)
    expect(report.repo.diffSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(report.reproduce).toContain('--seed 31337')
    expect(report.reproduce).toContain('--source working-tree')

    const text = formatSignoffReport(report)
    expect(text).toContain('patch       sha256:')
    expect(text).toContain('reproduce: agent-app-signoff')
  })

  it('refuses a config whose graph cannot run, before paying for an install', async () => {
    const repo = fixtureRepo({
      steps: `[
        { name: 'a', needs: ['b'], run: "node -e \\"\\"" },
        { name: 'b', needs: ['a'], run: "node -e \\"\\"" },
      ]`,
    })
    await expect(runSignoff({ repoDir: repo, cacheDir: temp('signoff-cache-'), source: 'head' })).rejects.toThrow(
      /dependency cycle/,
    )
  })
})
