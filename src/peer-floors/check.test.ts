import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkPeerFloors, describePeerFloorViolation, formatPeerFloorReport, satisfiesRange } from './check'

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
    expect(satisfiesRange('0.40.0', '>=0.38.0 <0.41.0')).toBe(true)
    expect(satisfiesRange('0.38.0', '>=0.38.0 <0.41.0')).toBe(true)
    expect(satisfiesRange('0.36.0', '>=0.38.0 <0.41.0')).toBe(false)
    expect(satisfiesRange('0.41.0', '>=0.38.0 <0.41.0')).toBe(false)
  })

  it('accepts a prerelease of a satisfying version — a floor is about the wire contract', () => {
    expect(satisfiesRange('0.40.0-rc.1', '>=0.38.0 <0.41.0')).toBe(true)
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

describe('this package audits itself', () => {
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
