/**
 * `agent-app-invariants`: an invariant passes only on recorded passing
 * verdicts, not applicable only where the deployment shows it, and the cron
 * check must have read every cron the deployment configures.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { LAUNCH_INVARIANT_IDS, type InvariantVerdict } from '../../src/launch-invariants/index'
import { buildConformanceReport, formatConformanceReport, readDeploymentFacts } from '../../src/launch-invariants/conformance'
import { runConformance } from '../../src/launch-invariants/cli'

const crons = ['0,1 * * * *', '7,22,37,52 * * * *']
const facts = { wranglerFiles: ['wrangler.toml'], configuredCrons: crons, hasD1: true }
const passing = (): InvariantVerdict[] => LAUNCH_INVARIANT_IDS.map((invariant) => ({
  invariant,
  subject: 'probe',
  pass: true,
  details: ['held'],
  ...(invariant === 'isolated-jobs' ? { data: { configuredCrons: crons } } : {}),
}))
const config = { product: 'probe', test: 'true' }

describe('the conformance report', () => {
  it('holds when every invariant recorded a passing verdict and the tests exited 0', () => {
    const report = buildConformanceReport({ config, facts, verdicts: passing(), testExitCode: 0 })
    expect([report.pass, report.passed, report.total]).toEqual([true, 9, 9])
    expect(formatConformanceReport(report)).toContain('launch invariants — probe: 9 of 9 hold')
  })

  it('fails an invariant no check recorded, one with a failing verdict, and a non-zero test exit', () => {
    const verdicts = passing().filter((verdict) => verdict.invariant !== 'limit-alarms')
    verdicts.push({ invariant: 'bounded-reads', subject: 'reliability', pass: false, details: ['one query returned 48.0 MB'] })
    const report = buildConformanceReport({ config, facts, verdicts, testExitCode: 1 })
    const status = Object.fromEntries(report.invariants.map((invariant) => [invariant.id, invariant.status]))
    expect([status['limit-alarms'], status['bounded-reads'], report.pass, report.passed]).toEqual(['fail', 'fail', false, 7])
    expect(report.invariants.find((invariant) => invariant.id === 'bounded-reads')!.lines).toEqual(['reliability: one query returned 48.0 MB'])
  })

  it('accepts not applicable only when the deployment shows it', () => {
    const verdicts = passing().filter((verdict) => !['isolated-jobs', 'honest-settlement'].includes(verdict.invariant))
    const notApplicable = { 'isolated-jobs': 'no scheduled work', 'honest-settlement': 'no turns' }
    const withCrons = buildConformanceReport({ config: { ...config, notApplicable }, facts, verdicts, testExitCode: 0 })
    expect(withCrons.invariants.filter((invariant) => invariant.status === 'fail').map((invariant) => invariant.lines[0])).toEqual([
      'declared not applicable ("no scheduled work"), but the deployment does not show no configured crons',
      'declared not applicable ("no turns"), but this invariant applies to every agent app',
    ])
    const noCrons = buildConformanceReport({ config: { ...config, notApplicable: { 'isolated-jobs': 'no scheduled work' } }, facts: { ...facts, configuredCrons: [] }, verdicts: passing().filter((verdict) => verdict.invariant !== 'isolated-jobs'), testExitCode: 0 })
    expect(noCrons.invariants.find((invariant) => invariant.id === 'isolated-jobs')!.status).toBe('not-applicable')
    expect(noCrons.pass).toBe(true)
  })

  it('fails the cron check when it did not read every configured cron', () => {
    const verdicts = passing().map((verdict) => verdict.invariant === 'isolated-jobs' ? { ...verdict, data: { configuredCrons: [crons[0]] } } : verdict)
    const report = buildConformanceReport({ config, facts, verdicts, testExitCode: 0 })
    expect(report.invariants.find((invariant) => invariant.id === 'isolated-jobs')!.lines[0]).toBe('the check did not read every configured cron: "7,22,37,52 * * * *" (from wrangler.toml)')
  })
})

describe('agent-app-invariants', () => {
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('runs the app\'s invariant command and reads the verdicts it recorded', async () => {
    dir = mkdtempSync(join(tmpdir(), 'invariants-app-'))
    writeFileSync(join(dir, 'wrangler.toml'), `[triggers]\ncrons = ${JSON.stringify(crons)}\n\n[[d1_databases]]\nbinding = "DB"\n`)
    const lines = passing().map((verdict) => JSON.stringify(verdict)).join('\n')
    writeFileSync(join(dir, 'record.mjs'), `import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.AGENT_APP_INVARIANTS_RESULTS, ${JSON.stringify(`${lines}\n`)})\n`)
    writeFileSync(join(dir, 'launch-invariants.config.json'), JSON.stringify({ product: 'probe', test: `"${process.execPath}" record.mjs` }))
    expect(readDeploymentFacts(dir)).toEqual(facts)
    const report = await runConformance({ appDir: dir })
    expect([report.pass, report.passed, report.testExitCode]).toEqual([true, 9, 0])
  })
})

describe('known failures', () => {
  it('records a known failure without failing the run, counts it as not holding, and fails once it passes', async () => {
    const { recordInvariant } = await import('../../src/launch-invariants/testing')
    const failing: InvariantVerdict = { invariant: 'honest-settlement', subject: 'scenarios', pass: false, details: ['scenario user-stop: no turn record was read back'] }
    const recorded = recordInvariant(failing, { knownFailing: 'Workflow scenarios not driven yet (L4)' })
    expect(recorded.knownFailing).toBe('Workflow scenarios not driven yet (L4)')
    expect(() => recordInvariant({ ...failing, pass: true, details: ['7 scenarios settle'] }, { knownFailing: 'Workflow scenarios not driven yet (L4)' }))
      .toThrow('this invariant now holds; remove its knownFailing marker')
    expect(() => recordInvariant(failing)).toThrow('FAIL honest-settlement')

    const verdicts = passing().map((verdict) => verdict.invariant === 'honest-settlement' ? recorded : verdict)
    const report = buildConformanceReport({ config, facts, verdicts, testExitCode: 0 })
    expect([report.pass, report.passed, report.knownFailing]).toEqual([true, 8, 1])
    expect(formatConformanceReport(report)).toContain('launch invariants — probe: 8 of 9 hold, 1 known failing')
    expect(formatConformanceReport(report)).toContain('RESULT: not launch-grade yet; 1 known failing, no regressions')
  })
})
