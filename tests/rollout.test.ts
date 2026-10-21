import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decideRollout, rolloutAdmits, rolloutWidens, validateRolloutPlan, type RolloutPlan, type StageMeasurement } from '../src/rollout/index'
import { readWranglerVar, runRolloutCheck } from '../src/rollout/cli'

const QA = 'ws-qa-1,ws-qa-2'
const ALL_BUT_RECENTER = '*,!ws-recenter'
const plan: RolloutPlan = {
  name: 'hospitality-routed-chat',
  variable: 'HOSPITALITY_ROUTED_BUSINESS_IDS',
  stages: [
    { name: 'qa', value: QA, minSamples: 30, kill: { first_words_p50_ms: { max: 2500 }, failure_rate: { max: 0 } } },
    { name: 'all-but-recenter', value: ALL_BUT_RECENTER, minSamples: 200,
      kill: { first_words_p50_ms: { max: 3000 }, failure_rate: { max: 0.01 } } },
    { name: 'all', value: '*', minSamples: 500, kill: { first_words_p50_ms: { max: 1500 }, failure_rate: { max: 0.01 } } },
  ],
}
const measured = (stage: string, samples: number, metrics: StageMeasurement['metrics']): StageMeasurement =>
  ({ stage, samples, metrics, source: 'front-door soak' })
const at = () => new Date('2026-10-11T22:00:00Z')

describe('rollout lists', () => {
  it('reads ids, *, !id and new-since entries the way Hospitality does', () => {
    expect(rolloutAdmits('*,!ws-recenter', { id: 'ws-1' })).toBe(true)
    expect(rolloutAdmits('*,!ws-recenter', { id: 'ws-recenter' })).toBe(false)
    expect(rolloutAdmits('ws-1,new-since:2026-10-01T00:00:00Z', { id: 'ws-2', createdAt: Date.parse('2026-10-02') })).toBe(true)
    expect(rolloutAdmits('ws-1,new-since:2026-10-01T00:00:00Z', { id: 'ws-2', createdAt: Date.parse('2026-09-02') })).toBe(false)
  })

  it('knows a widening from a narrowing', () => {
    expect(rolloutWidens(QA, ALL_BUT_RECENTER)).toBe(true)
    expect(rolloutWidens(ALL_BUT_RECENTER, '*')).toBe(true)
    expect(rolloutWidens(QA, `${QA},ws-3`)).toBe(true)
    expect(rolloutWidens(QA, `${QA},new-since:2026-10-01T00:00:00Z`)).toBe(true)
    expect(rolloutWidens(ALL_BUT_RECENTER, QA)).toBe(false)
    expect(rolloutWidens('*', ALL_BUT_RECENTER)).toBe(false)
    expect(rolloutWidens(QA, 'ws-qa-1')).toBe(false)
    expect(rolloutWidens(` ${QA} `, 'ws-qa-2,ws-qa-1')).toBe(false)
  })

  it('rejects a plan whose stages do not widen in order', () => {
    expect(() => validateRolloutPlan({ ...plan, stages: [plan.stages[1]!, plan.stages[0]!] })).toThrow(/does not widen/)
    expect(() => validateRolloutPlan({ ...plan, stages: [{ ...plan.stages[0]!, kill: {} }] })).toThrow(/no kill lines/)
  })
})

describe('decideRollout', () => {
  it('refuses the #382 widening by name: qa left at 3.54 s first-words p50 against a 2.5 s kill line', async () => {
    const decision = await decideRollout({ plan, fromValue: QA, toValue: ALL_BUT_RECENTER, now: at,
      measure: async stage => measured(stage.name, 30, { first_words_p50_ms: 3540, failure_rate: 0 }) })
    expect(decision).toMatchObject({ decision: 'refused', widens: true,
      from: { stage: 'qa' }, to: { stage: 'all-but-recenter' }, reasons: ['first_words_p50_ms 3540 over kill line 2500'] })
  })

  it('allows the next stage once the stage it leaves met every line', async () => {
    const measure = vi.fn(async () => measured('qa', 39, { first_words_p50_ms: 1400, failure_rate: 0 }))
    const decision = await decideRollout({ plan, fromValue: QA, toValue: ALL_BUT_RECENTER, measure, now: at })
    expect(decision).toMatchObject({ decision: 'allowed', reasons: [], measured: { samples: 39 } })
    expect(measure).toHaveBeenCalledWith(plan.stages[0])
  })

  it('lets an empty list take the first stage without numbers', async () => {
    await expect(decideRollout({ plan, fromValue: '', toValue: QA, measure: async () => null }))
      .resolves.toMatchObject({ decision: 'allowed', widens: true })
  })
})

describe('agent-app-rollout-check', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function repo(fromValue: string, toValue: string, p50: number, sub = '.') {
    dir = mkdtempSync(join(tmpdir(), 'rollout-check-'))
    const app = join(dir, sub)
    mkdirSync(app, { recursive: true })
    // Plumbing only: a fixture commit through commit-tree runs none of the host's commit hooks.
    const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...identity } }).trim()
    const wrangler = (value: string) => `name = "app"\n\n[vars]\n# The routed lane.\nHOSPITALITY_ROUTED_BUSINESS_IDS = "${value}"\n\n[env.staging.vars]\nHOSPITALITY_ROUTED_BUSINESS_IDS = "*"\n`
    git('init', '-q', '-b', 'main')
    writeFileSync(join(app, 'wrangler.toml'), wrangler(fromValue))
    git('add', '.')
    git('update-ref', 'refs/heads/main', git('commit-tree', git('write-tree'), '-m', 'base'))
    writeFileSync(join(app, 'wrangler.toml'), wrangler(toValue))
    writeFileSync(join(app, 'rollout.config.mjs'), `export default {
      plans: ${JSON.stringify([plan])},
      async measure({ stage }) { return { stage: stage.name, samples: 30, metrics: { first_words_p50_ms: ${p50}, failure_rate: 0 } } },
    }`)
    return sub === '.' ? dir : app
  }

  it('reads only the top-level [vars] value', () => {
    expect(readWranglerVar('[vars]\nA = "x"\n[env.staging.vars]\nA = "y"\n', 'A')).toBe('x')
    expect(readWranglerVar('[env.staging.vars]\nA = "y"\n', 'A')).toBeNull()
  })

  it('refuses the change at the base ref and records it in the ledger', async () => {
    const appDir = repo(QA, ALL_BUT_RECENTER, 3540)
    const [decision] = await runRolloutCheck({ appDir, base: 'main', record: '.rollout/decisions.jsonl' })
    expect(decision).toMatchObject({ decision: 'refused', from: { value: QA }, to: { value: ALL_BUT_RECENTER } })
    const ledger = readFileSync(join(appDir, '.rollout/decisions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(ledger).toEqual([expect.objectContaining({ decision: 'refused', reasons: ['first_words_p50_ms 3540 over kill line 2500'] })])
  })

  it('reads the base from the source checkout when signoff runs it in a clean tree without .git', async () => {
    // Source repo with the app under apps/web; the clean tree is a plain copy.
    repo(QA, ALL_BUT_RECENTER, 3540, 'apps/web')
    const source = dir!
    const tree = mkdtempSync(join(tmpdir(), 'rollout-tree-'))
    try {
      const appDir = join(tree, 'apps', 'web')
      cpSync(join(source, 'apps', 'web'), appDir, { recursive: true })
      delete process.env.SIGNOFF_SOURCE_REPO
      delete process.env.SIGNOFF_TREE
      await expect(runRolloutCheck({ appDir, base: 'main', record: '.rollout/decisions.jsonl' })).rejects.toThrow(/cannot read wrangler.toml at main/)
      process.env.SIGNOFF_SOURCE_REPO = source
      process.env.SIGNOFF_TREE = tree
      await expect(runRolloutCheck({ appDir, base: 'main', record: '.rollout/decisions.jsonl' }))
        .resolves.toEqual([expect.objectContaining({ decision: 'refused', from: expect.objectContaining({ value: QA }) })])
    } finally {
      delete process.env.SIGNOFF_SOURCE_REPO
      delete process.env.SIGNOFF_TREE
      rmSync(tree, { recursive: true, force: true })
    }
  })

  it('allows it when the numbers meet the lines', async () => {
    const appDir = repo(QA, ALL_BUT_RECENTER, 1300)
    await expect(runRolloutCheck({ appDir, base: 'main', record: '.rollout/decisions.jsonl' }))
      .resolves.toEqual([expect.objectContaining({ decision: 'allowed' })])
  })
})
