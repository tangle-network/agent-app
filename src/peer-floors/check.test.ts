import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkAllPeerFloors,
  checkPeerFloors,
  describePeerFloorViolation,
  formatPeerFloorReport,
  satisfiesRange,
} from './check'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The fixture trees are committed, and their module directory is deliberately
 * NOT called `node_modules` — every repo gitignores that name, so a fixture
 * using it could not be committed, and a calibration proof that is not committed
 * is a proof that stops running.
 */
const MODULES = 'fixture_modules'
const belowFloor = join(here, 'fixtures', 'below-floor')
const satisfied = join(here, 'fixtures', 'satisfied')

describe('satisfiesRange', () => {
  // The single most consequential rule here. ^0.36.0 CANNOT reach 0.38.0, which
  // is why "just reinstall" never fixes a 0.x floor violation and the pin has to
  // change. Getting this wrong makes the whole guard report false passes.
  it('treats a caret on a 0.x version as minor-locked', () => {
    expect(satisfiesRange('0.36.0', '^0.36.0')).toBe(true)
    expect(satisfiesRange('0.36.9', '^0.36.0')).toBe(true)
    expect(satisfiesRange('0.38.0', '^0.36.0')).toBe(false)
    expect(satisfiesRange('0.40.0', '^0.36.0')).toBe(false)
  })

  it('treats a caret on a 1.x version as minor-open', () => {
    expect(satisfiesRange('1.9.0', '^1.2.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false)
  })

  it('handles the compound range agent-app actually declares', () => {
    expect(satisfiesRange('0.42.1', '>=0.42.1 <0.44.0')).toBe(true)
    expect(satisfiesRange('0.43.0', '>=0.42.1 <0.44.0')).toBe(true)
    expect(satisfiesRange('0.44.0', '>=0.42.1 <0.44.0')).toBe(false)
  })

  it('accepts a prerelease of a satisfying version — a floor is about the wire contract', () => {
    expect(satisfiesRange('0.43.0-rc.1', '>=0.42.1 <0.44.0')).toBe(true)
  })

  it('handles alternation and wildcards', () => {
    expect(satisfiesRange('2.0.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false)
    expect(satisfiesRange('9.9.9', '*')).toBe(true)
  })

  it('handles tilde and exact pins', () => {
    expect(satisfiesRange('1.2.9', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false)
    expect(satisfiesRange('0.40.0', '0.40.0')).toBe(true)
    expect(satisfiesRange('0.40.1', '0.40.0')).toBe(false)
  })
})

describe('checkPeerFloors', () => {
  // CALIBRATION. A guard that cannot be shown to FAIL is indistinguishable from
  // one that does nothing — and the shape of this check ("look a version up,
  // skip if you cannot find it") fails OPEN by construction. An earlier
  // implementation in a sibling product resolved every package to null and
  // passed while the product sat four minor versions below its floor. So the
  // same code path that audits a real install is run against a committed tree
  // with a known violation and is required to reject it.
  it('rejects a tree sitting below the floor', () => {
    const report = checkPeerFloors({ appDir: belowFloor, modulesDir: MODULES })
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      name: '@tangle-network/agent-interface',
      installed: '0.36.0',
      range: '>=0.38.0 <0.41.0',
      verdict: 'below-floor',
    })
  })

  it('accepts the same tree once the floor is met', () => {
    const report = checkPeerFloors({ appDir: satisfied, modulesDir: MODULES })
    expect(report.ok).toBe(true)
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]?.verdict).toBe('satisfied')
  })

  it('names the minor-lock in the failure, because that is the fix', () => {
    const report = checkPeerFloors({ appDir: belowFloor, modulesDir: MODULES })
    const message = describePeerFloorViolation(report.violations[0]!, report.shellVersion)
    expect(message).toContain('PEER FLOOR VIOLATED')
    expect(message).toContain('minor-locked')
    expect(message).toContain('pnpm.overrides')
  })

  it('renders a report naming every audited floor', () => {
    const text = formatPeerFloorReport(checkPeerFloors({ appDir: belowFloor, modulesDir: MODULES }))
    expect(text).toContain('@tangle-network/agent-app@0.45.6')
    expect(text).toContain('@tangle-network/agent-interface')
    expect(text).toContain('FAIL')
  })

  it('throws when the shell itself is not installed, rather than reporting a pass', () => {
    expect(() => checkPeerFloors({ appDir: here, modulesDir: 'no_such_dir' }))
      .toThrow(/is not installed under/)
  })
})

describe('checkAllPeerFloors', () => {
  it('audits every installed Tangle package that declares a Tangle peer', () => {
    const reports = checkAllPeerFloors({ appDir: belowFloor, modulesDir: MODULES })

    expect(reports.map((report) => report.shellVersion)).toEqual(['0.45.6', '0.180.0'])
    expect(reports.every((report) => !report.ok)).toBe(true)
    expect(reports.map((report) => formatPeerFloorReport(report)).join('\n'))
      .toContain('@tangle-network/agent-runtime@0.180.0')
  })

  it('audits every package scope when the caller passes an empty scope', () => {
    const reports = checkAllPeerFloors({
      appDir: belowFloor,
      modulesDir: MODULES,
      scope: '',
    })

    expect(reports.map((report) => report.shell)).toEqual([
      '@tangle-network/agent-app',
      '@tangle-network/agent-runtime',
    ])
  })
})

describe('this package audits itself', () => {
  it('declares support for the current Interface line without claiming the next one', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/agent-interface']

    // Interface minors are additive. Require the minor the verified Runtime line
    // requires, admit later 2.x minors, and reject the next major.
    expect(range).toBeDefined()
    expect(satisfiesRange('1.9.0', range!)).toBe(false)
    expect(satisfiesRange('2.1.1', range!)).toBe(false)
    expect(satisfiesRange('2.10.999', range!)).toBe(false)
    expect(satisfiesRange('2.11.0', range!)).toBe(false)
    expect(satisfiesRange('2.12.0', range!)).toBe(false)
    expect(satisfiesRange('2.13.0', range!)).toBe(true)
    expect(satisfiesRange('3.0.0', range!)).toBe(false)
  })

  it('supports the verified Runtime 0.282, 0.283, 0.285, 0.289, and 0.291 lines', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/agent-runtime']

    expect(range).toBeDefined()
    // The OIDC caller is verified against published Runtime 0.282.2 and 0.283.0.
    expect(satisfiesRange('0.281.999', range!)).toBe(false)
    expect(satisfiesRange('0.282.0', range!)).toBe(false)
    expect(satisfiesRange('0.282.2', range!)).toBe(true)
    expect(satisfiesRange('0.282.999', range!)).toBe(true)
    expect(satisfiesRange('0.283.0', range!)).toBe(true)
    expect(satisfiesRange('0.283.999', range!)).toBe(true)
    expect(satisfiesRange('0.284.0', range!)).toBe(false)
    expect(satisfiesRange('0.284.999', range!)).toBe(false)
    expect(satisfiesRange('0.285.0', range!)).toBe(true)
    expect(satisfiesRange('0.285.999', range!)).toBe(true)
    expect(satisfiesRange('0.286.0', range!)).toBe(false)
    expect(satisfiesRange('0.289.0', range!)).toBe(false)
    expect(satisfiesRange('0.289.1', range!)).toBe(true)
    expect(satisfiesRange('0.289.999', range!)).toBe(true)
    expect(satisfiesRange('0.290.0', range!)).toBe(false)
    expect(satisfiesRange('0.290.999', range!)).toBe(false)
    expect(satisfiesRange('0.291.0', range!)).toBe(true)
    expect(satisfiesRange('0.291.999', range!)).toBe(true)
    expect(satisfiesRange('0.292.0', range!)).toBe(false)
  })

  it('admits the tcloud line used by the Sandbox 0.59 consumer', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/tcloud']

    expect(range).toBeDefined()
    expect(satisfiesRange('0.5.2', range!)).toBe(true)
    expect(satisfiesRange('0.6.0', range!)).toBe(false)
    expect(satisfiesRange('0.8.0', range!)).toBe(false)
    expect(satisfiesRange('0.8.1', range!)).toBe(true)
    expect(satisfiesRange('0.8.999', range!)).toBe(true)
    expect(satisfiesRange('0.9.0', range!)).toBe(false)
  })

  it('admits the tested Hub SDK 0.24 line without claiming 0.25', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/hub-sdk']

    expect(range).toBeDefined()
    expect(own.devDependencies?.['@tangle-network/hub-sdk']).toBe('0.24.0')
    expect(satisfiesRange('0.19.3', range!)).toBe(true)
    expect(satisfiesRange('0.21.0', range!)).toBe(true)
    expect(satisfiesRange('0.22.0', range!)).toBe(false)
    expect(satisfiesRange('0.22.1', range!)).toBe(true)
    expect(satisfiesRange('0.22.999', range!)).toBe(true)
    expect(satisfiesRange('0.23.0', range!)).toBe(true)
    expect(satisfiesRange('0.23.999', range!)).toBe(true)
    expect(satisfiesRange('0.24.0', range!)).toBe(true)
    expect(satisfiesRange('0.24.999', range!)).toBe(true)
    expect(satisfiesRange('0.25.0', range!)).toBe(false)
  })

  it('admits the tested Integrations lines without admitting 0.58', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/agent-integrations']

    expect(range).toBeDefined()
    for (const version of ['0.54.1', '0.58.0', '0.58.999', '0.60.0']) {
      expect(satisfiesRange(version, range!)).toBe(false)
    }
    for (const version of ['0.54.2', '0.57.0', '0.59.0', '0.59.999']) {
      expect(satisfiesRange(version, range!)).toBe(true)
    }
  })

  it('admits the Knowledge line compatible with Eval 0.203', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/agent-knowledge']

    expect(range).toBeDefined()
    expect(satisfiesRange('17.1.10', range!)).toBe(true)
    expect(satisfiesRange('18.0.0', range!)).toBe(true)
    expect(satisfiesRange('19.0.0', range!)).toBe(false)
  })

  it('requires the shared companion layout seams without claiming the next minor', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/sandbox-ui']

    expect(range).toBeDefined()
    expect(satisfiesRange('0.116.9', range!)).toBe(false)
    expect(satisfiesRange('0.117.0', range!)).toBe(true)
    expect(satisfiesRange('0.117.1', range!)).toBe(true)
    expect(satisfiesRange('0.118.0', range!)).toBe(false)
  })

  it('requires the UI release that exports openui-schema', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.['@tangle-network/ui']

    expect(range).toBeDefined()
    expect(satisfiesRange('11.11.2', range!)).toBe(false)
    expect(satisfiesRange('11.11.3', range!)).toBe(true)
    expect(satisfiesRange('11.11.5', range!)).toBe(true)
    expect(satisfiesRange('12.0.0', range!)).toBe(false)
  })

  // Each window starts at the floor this application code ran on, admits the
  // newer minor tested in an installed consumer, and claims nothing past it.
  // The Runtime refuses Sandbox
  // 0.48, so the shell refuses it too. Sandbox 0.50 adds the named instances
  // that `hosted-agent` keeps each person's box on, 0.51 adds lines, 0.52
  // runs each line member in their own named instance, 0.53 adds email lines,
  // and 0.55 adds the global line detach the hosted-agent kit uses.
  // Sandbox 0.59 is admitted for this shell's optional /sandbox adapter.
  // Sandbox 0.60.3 is the first public parser that preserves signed shared
  // Line callback identity and dispatch fields; 0.60.0–0.60.2 drop them.
  // Runtime declares its own Sandbox window for consumers that install both.
  // The Runtime 0.289.1 line requires Eval 0.201–0.203; older Runtime and
  // Knowledge lines retain their own peer contracts in combined consumers.
  const verifiedWindows: Array<[string, string[], string[], string[]]> = [
    ['@tangle-network/agent-eval', ['0.198.999'], ['0.199.0', '0.199.1', '0.199.999', '0.200.0', '0.200.1', '0.200.999', '0.201.0', '0.202.0', '0.203.0', '0.203.999'], ['0.204.0']],
    ['@tangle-network/sandbox', ['0.44.999', '0.48.0', '0.48.999'], ['0.45.0', '0.46.0', '0.47.0', '0.47.999', '0.49.0', '0.49.999', '0.50.0', '0.50.999', '0.51.0', '0.51.999', '0.52.0', '0.52.999', '0.53.0', '0.53.999', '0.54.0', '0.55.2', '0.58.1', '0.58.999', '0.59.0', '0.59.999', '0.60.3', '0.60.999'], ['0.56.0', '0.57.0', '0.58.0', '0.60.0', '0.60.1', '0.60.2', '0.61.0']],
    ['@tangle-network/agent-interface', ['2.12.999'], ['2.13.0', '2.14.0', '2.15.0'], ['3.0.0']],
  ]

  it.each(verifiedWindows)('keeps the %s peer on the verified window', async (name, below, admitted, above) => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const range = own.peerDependencies?.[name]

    expect(range).toBeDefined()
    for (const version of below) expect(satisfiesRange(version, range!)).toBe(false)
    for (const version of admitted) expect(satisfiesRange(version, range!)).toBe(true)
    for (const version of above) expect(satisfiesRange(version, range!)).toBe(false)
  })

  // Supported Runtime cohorts have different Interface floors. Check the exact
  // development cohort against the installed Runtime, not every older option.
  it.each(verifiedWindows)('installs a %s version the installed Runtime admits', async (name) => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    const runtime = JSON.parse(
      await readFile(join(root, 'node_modules', '@tangle-network', 'agent-runtime', 'package.json'), 'utf8'),
    ) as { version: string; peerDependencies?: Record<string, string> }
    const installed = own.devDependencies?.[name]
    const ownRange = own.peerDependencies?.[name]
    const runtimeRange = runtime.peerDependencies?.[name]

    expect(installed).toBeDefined()
    expect(ownRange).toBeDefined()
    expect(runtimeRange, `Runtime ${runtime.version} declares no ${name} peer`).toBeDefined()
    expect(satisfiesRange(installed!, ownRange!), `${installed} vs ${ownRange}`).toBe(true)
    expect(satisfiesRange(installed!, runtimeRange!), `${installed} vs ${runtimeRange}`).toBe(true)
  })

  // The floors this shell PUBLISHES must be satisfiable by the tree it is
  // developed against, or the contract shipped to consumers is one its own
  // author never ran. Self-audit needs the manifest passed in: a package has no
  // copy of itself in its own node_modules.
  it('declares peer floors its own dev install satisfies', async () => {
    const root = join(here, '..', '..')
    const own = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { version?: string; peerDependencies?: Record<string, string> }
    const report = checkPeerFloors({ appDir: root, shellManifest: own })
    const below = report.rows.filter((row) => row.verdict === 'below-floor')
    expect(below.map((row) => `${row.name} ${row.installed} vs ${row.range}`)).toEqual([])
  })
})

describe('the walk stops at the repository boundary', () => {
  // A `node_modules` ABOVE a checkout belongs to something else. Node would
  // happily resolve through it; this must not, because inheriting one silently
  // changes the verdict. Measured: a stray /tmp/node_modules shadowing a single
  // package produced a confident FAIL for a repo that was above every floor.
  it('does not inherit a package from outside the repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'peer-floor-boundary-'))
    try {
      // An ancestor tree holding an OLD version of the peer.
      await mkdir(join(root, MODULES, '@tangle-network', 'agent-interface'), { recursive: true })
      await writeFile(
        join(root, MODULES, '@tangle-network', 'agent-interface', 'package.json'),
        JSON.stringify({ name: '@tangle-network/agent-interface', version: '0.36.0' }),
      )

      // The repo sits inside it, declares the peer, and has its own agent-app
      // but no copy of agent-interface.
      const repo = join(root, 'app')
      await mkdir(join(repo, MODULES, '@tangle-network', 'agent-app'), { recursive: true })
      await writeFile(join(repo, '.git'), 'gitdir: elsewhere')
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { '@tangle-network/agent-interface': '0.40.0' } }),
      )
      await writeFile(
        join(repo, MODULES, '@tangle-network', 'agent-app', 'package.json'),
        JSON.stringify({
          name: '@tangle-network/agent-app',
          version: '0.45.11',
          peerDependencies: { '@tangle-network/agent-interface': '>=0.38.0 <0.41.0' },
        }),
      )

      const report = checkPeerFloors({ appDir: repo, modulesDir: MODULES })
      const row = report.rows.find((r) => r.name === '@tangle-network/agent-interface')

      // NOT 'below-floor' from the ancestor's 0.36.0 — the version is simply
      // not readable inside the repo, which is its own (also failing) verdict.
      expect(row?.installed).toBeNull()
      expect(row?.verdict).toBe('absent-but-declared')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
