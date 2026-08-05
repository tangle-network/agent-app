import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkflowNodePin, scanMergeGateNodePins, triggersOnPullRequest } from './workflow-pin'

/**
 * The calibration case these tests encode: legal-agent `4c0d688` was red in CI
 * on `Cannot bundle Node.js built-in "node:sqlite"` and the sign-off gate
 * signed it off, because the only Node pin in the repo lives in the workflow
 * the gate replaces. The fixtures below are the real `on:` blocks and
 * `setup-node` steps from the three fleet workflows.
 */

const created: string[] = []
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signoff-workflow-'))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeWorkflow(repo: string, name: string, body: string): void {
  const dir = join(repo, '.github', 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
}

/** legal-agent / tax-agent `deploy.yml`, verbatim in shape. */
const DEPLOY_WORKFLOW = `name: deploy
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  ci:
    runs-on: [self-hosted, ci-linux]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
`

/** agent-app `publish.yml`: push-only, and it runs a DIFFERENT major. */
const PUBLISH_WORKFLOW = `name: Publish
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  package_release:
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24.18.0
`

const majorOf = (raw: string): number | null => {
  const match = /^v?(\d+)(?:\.|$)/.exec(raw.trim())
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
}

describe('triggersOnPullRequest', () => {
  it('reads the block form every fleet workflow writes', () => {
    expect(triggersOnPullRequest(DEPLOY_WORKFLOW)).toBe(true)
  })

  it('reads the inline list form', () => {
    expect(triggersOnPullRequest('on: [push, pull_request]\njobs: {}\n')).toBe(true)
    expect(triggersOnPullRequest('on: pull_request\njobs: {}\n')).toBe(true)
    expect(triggersOnPullRequest('on: [push]\njobs: {}\n')).toBe(false)
  })

  it('reads a quoted `on` key — YAML 1.1 makes a bare one the boolean true', () => {
    expect(triggersOnPullRequest("'on':\n  pull_request:\n")).toBe(true)
    expect(triggersOnPullRequest('"on":\n  pull_request:\n')).toBe(true)
  })

  it('does not mistake a trigger OPTION for a trigger', () => {
    // A sequence entry named `pull_request` under `workflow_run.types` reads
    // exactly like a trigger key one level up, so only the nesting level tells
    // them apart. A workflow that runs AFTER a PR workflow is not the gate.
    expect(
      triggersOnPullRequest('on:\n  workflow_run:\n    types:\n      - pull_request\njobs: {}\n'),
    ).toBe(false)
  })

  it('is false for a push-only workflow', () => {
    expect(triggersOnPullRequest(PUBLISH_WORKFLOW)).toBe(false)
  })
})

describe('scanMergeGateNodePins', () => {
  it('reads the pin out of the workflow that gates a merge', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'deploy.yml', DEPLOY_WORKFLOW)
    expect(scanMergeGateNodePins(repo)).toEqual([
      { file: '.github/workflows/deploy.yml', value: '22', via: 'node-version' },
    ])
  })

  it('IGNORES a push-only workflow — agent-app publishes on 24 and gates on 22', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'ci.yml', DEPLOY_WORKFLOW)
    writeWorkflow(repo, 'publish.yml', PUBLISH_WORKFLOW)
    expect(scanMergeGateNodePins(repo).map((pin) => pin.value)).toEqual(['22'])
  })

  it('skips a matrix expression rather than pinning to its literal text', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'ci.yml', 'on:\n  pull_request:\njobs:\n  b:\n    steps:\n      - with:\n          node-version: ${{ matrix.node }}\n')
    expect(scanMergeGateNodePins(repo)).toEqual([])
  })

  it('drops a trailing comment and surrounding quotes from the value', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'ci.yml', "on:\n  pull_request:\njobs:\n  b:\n    steps:\n      - with:\n          node-version: '22' # the runtime we ship\n")
    expect(scanMergeGateNodePins(repo)[0]?.value).toBe('22')
  })

  it('follows node-version-file to the pin it names', () => {
    const repo = tempRepo()
    writeFileSync(join(repo, '.node-version'), '# pinned for the workers runtime\n22.22.3\n')
    writeWorkflow(repo, 'ci.yml', 'on:\n  pull_request:\njobs:\n  b:\n    steps:\n      - with:\n          node-version-file: .node-version\n')
    expect(scanMergeGateNodePins(repo)).toEqual([
      { file: '.github/workflows/ci.yml', value: '22.22.3', via: 'node-version-file .node-version' },
    ])
  })

  it('fails loud on a node-version-file that does not exist', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'ci.yml', 'on:\n  pull_request:\njobs:\n  b:\n    steps:\n      - with:\n          node-version-file: .nvmrc\n')
    expect(() => scanMergeGateNodePins(repo)).toThrow(/does not exist/)
  })

  it('returns nothing when a repo has no workflows at all', () => {
    expect(scanMergeGateNodePins(tempRepo())).toEqual([])
  })
})

describe('resolveWorkflowNodePin', () => {
  it('resolves the fleet shape — the pin that was there all along', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'deploy.yml', DEPLOY_WORKFLOW)
    expect(resolveWorkflowNodePin(repo, majorOf)).toEqual({
      major: 22,
      declared: '22',
      source: '.github/workflows/deploy.yml (node-version)',
    })
  })

  it('names every workflow when several agree', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'a.yml', DEPLOY_WORKFLOW)
    writeWorkflow(repo, 'b.yml', DEPLOY_WORKFLOW)
    expect(resolveWorkflowNodePin(repo, majorOf)?.source).toBe(
      '.github/workflows/a.yml, .github/workflows/b.yml (node-version)',
    )
  })

  it('REFUSES when two merge-gate workflows pin different majors', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'a.yml', DEPLOY_WORKFLOW)
    writeWorkflow(repo, 'b.yml', DEPLOY_WORKFLOW.replace('node-version: 22', 'node-version: 20'))
    expect(() => resolveWorkflowNodePin(repo, majorOf)).toThrow(/different Node majors/)
    expect(() => resolveWorkflowNodePin(repo, majorOf)).toThrow(/nodeVersion/)
  })

  it('reports an alias it cannot resolve as no pin, never as a guess', () => {
    const repo = tempRepo()
    writeWorkflow(repo, 'ci.yml', DEPLOY_WORKFLOW.replace('node-version: 22', "node-version: 'lts/*'"))
    expect(resolveWorkflowNodePin(repo, majorOf)).toBeNull()
  })
})
