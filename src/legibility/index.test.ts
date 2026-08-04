/**
 * End to end, over a real product tree on disk: the gate a consumer's CI runs.
 *
 * The fixture is a miniature of the four defects that shipped — an actionless
 * empty state, an engineering word in error copy, "Saved" over an unchecked
 * response, and a screen no navigation entry reaches — plus the code that must
 * stay silent.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLegibility } from './index'
import { formatLegibilityReport, legibilityReportToJson } from './report'
import type { LegibilityCheckId } from './types'

const ROUTES = `
import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/_index.tsx'),
  route('api/filings', 'routes/api.filings.ts'),
  route('app', 'routes/app.tsx', [
    route('filings', 'routes/app.filings.tsx'),
    route('deadlines', 'routes/app.deadlines.tsx'),
  ]),
] satisfies RouteConfig
`

const NAV = `
export const NAV = [{ id: 'filings', label: 'Filings', path: '/filings' }]
`

const FILINGS = `
export function Filings({ rows }: { rows: Row[] }) {
  const save = async () => {
    await fetch('/api/filings', { method: 'POST' })
    toast.success('Saved')
  }
  return (
    <main>
      <button onClick={save}>Save</button>
      {rows.length === 0 && (
        <div className="empty">
          <p>No filings yet</p>
        </div>
      )}
    </main>
  )
}
`

const CLEAN = `
export function Deadlines({ rows }: { rows: Row[] }) {
  return (
    <main>
      {rows.length === 0 && (
        <div className="empty">
          <p>No deadlines yet</p>
          <button onClick={addDeadline}>Add a deadline</button>
        </div>
      )}
    </main>
  )
}
`

const SERVER = `
export async function readAttachment(id: string) {
  const stored = await lookup(id)
  if (!stored) throw new Error('Attachment materialization failed')
  return stored
}
`

function fixture(extra: Record<string, string> = {}): { src: string; routes: string; nav: string } {
  const root = mkdtempSync(join(tmpdir(), 'legibility-e2e-'))
  const files: Record<string, string> = {
    'src/routes.ts': ROUTES,
    'src/components/nav.tsx': NAV,
    'src/routes/app.filings.tsx': FILINGS,
    'src/routes/app.deadlines.tsx': CLEAN,
    'src/lib/attachments.ts': SERVER,
    ...extra,
  }
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return { src: join(root, 'src'), routes: join(root, 'src/routes.ts'), nav: join(root, 'src/components/nav.tsx') }
}

function run(extra: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const { src, routes, nav } = fixture(extra)
  return checkLegibility({
    srcDirs: [src],
    reachability: { routeConfigFile: routes, navFiles: [nav] },
    ...config,
  })
}

const checksIn = (report: { findings: readonly { check: LegibilityCheckId }[] }): LegibilityCheckId[] =>
  [...new Set(report.findings.map((finding) => finding.check))].sort()

describe('checkLegibility over a product tree', () => {
  it('finds each of the four shipped defect classes, once', () => {
    const report = run()
    expect(report.ok).toBe(false)
    expect(checksIn(report)).toEqual([
      'dead-end-empty-state',
      'engineering-vocabulary',
      'unchecked-success',
      'unreachable-capability',
    ])
    expect(report.findings.filter((f) => f.check === 'dead-end-empty-state')).toHaveLength(1)
    expect(report.findings.find((f) => f.check === 'unreachable-capability')?.message).toContain('app/deadlines')
  })

  it('gives every finding a file, a 1-based line and a remedy', () => {
    for (const finding of run().findings) {
      expect(finding.file).toMatch(/\.tsx?$/)
      expect(finding.line).toBeGreaterThan(0)
      expect(finding.column).toBeGreaterThan(0)
      expect(finding.remedy.length).toBeGreaterThan(20)
    }
  })

  it('says nothing about the screen that got it right', () => {
    const report = run()
    expect(report.findings.filter((finding) => finding.file.includes('deadlines'))).toEqual([])
  })

  it('does not scan test files, whose fixtures contain the defects on purpose', () => {
    const withTest = run({ 'src/routes/app.filings.test.tsx': FILINGS })
    expect(withTest.findings.filter((finding) => finding.file.includes('.test.'))).toEqual([])
  })

  it('honours a reasoned suppression and reports it instead of hiding it', () => {
    const suppressed = FILINGS.replace(
      '          <p>No filings yet</p>',
      '          {/* legibility-ignore dead-end-empty-state — the composer above is the only way to file */}\n          <p>No filings yet</p>',
    )
    const report = run({ 'src/routes/app.filings.tsx': suppressed })
    expect(checksIn(report)).not.toContain('dead-end-empty-state')
    expect(report.suppressed).toHaveLength(1)
    expect(report.suppressed[0]?.reason).toContain('composer above')
  })

  it('reports an unreasoned suppression instead of honouring it', () => {
    const suppressed = FILINGS.replace(
      '          <p>No filings yet</p>',
      '          {/* legibility-ignore dead-end-empty-state */}\n          <p>No filings yet</p>',
    )
    const report = run({ 'src/routes/app.filings.tsx': suppressed })
    expect(checksIn(report)).toContain('suppression-without-reason')
    expect(checksIn(report)).toContain('dead-end-empty-state')
    expect(report.suppressed).toEqual([])
  })

  it('turns one check off wholesale when a product insists', () => {
    const report = run({}, { checks: { 'engineering-vocabulary': false } })
    expect(checksIn(report)).not.toContain('engineering-vocabulary')
    expect(report.checksRun).not.toContain('engineering-vocabulary')
  })

  it('refuses to run with nothing to scan', () => {
    expect(() => checkLegibility({ srcDirs: [] })).toThrow(/at least one directory/)
  })

  it('passes a product with none of the defects', () => {
    const { src } = fixture({ 'src/routes/app.filings.tsx': CLEAN, 'src/lib/attachments.ts': 'export const x = 1' })
    const report = checkLegibility({ srcDirs: [src] })
    expect(report.ok).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.filesScanned).toBeGreaterThan(0)
  })
})

describe('the report a developer reads at 6pm', () => {
  it('prints file:line:column, the problem and the fix for every finding', () => {
    const report = run()
    const text = formatLegibilityReport(report)
    expect(text).toContain('legibility FAILED')
    for (const finding of report.findings) {
      expect(text).toContain(`${finding.file}:${finding.line}:${finding.column}`)
      expect(text).toContain(finding.remedy)
    }
    expect(text).toContain('// legibility-ignore <check> — why this instance is right')
  })

  it('counts suppressions in the summary and prints them on request', () => {
    const suppressed = FILINGS.replace(
      '          <p>No filings yet</p>',
      '          {/* legibility-ignore dead-end-empty-state — the composer above is the only way to file */}\n          <p>No filings yet</p>',
    )
    const report = run({ 'src/routes/app.filings.tsx': suppressed })
    expect(formatLegibilityReport(report)).toContain('--list-suppressions')
    expect(formatLegibilityReport(report, { listSuppressions: true })).toContain('composer above')
  })

  it('says so plainly when there is nothing to fix', () => {
    const { src } = fixture({ 'src/routes/app.filings.tsx': CLEAN, 'src/lib/attachments.ts': 'export const x = 1' })
    expect(formatLegibilityReport(checkLegibility({ srcDirs: [src] }))).toContain('legibility OK')
  })

  it('round-trips as JSON for a product that posts findings elsewhere', () => {
    const report = run()
    const parsed: unknown = JSON.parse(legibilityReportToJson(report))
    expect((parsed as { findings: unknown[] }).findings).toHaveLength(report.findings.length)
  })
})
