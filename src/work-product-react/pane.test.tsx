// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { WorkProductPane } from './index'
import type { WorkProductRecord } from '../work-product/types'

// jsdom has no ResizeObserver; sandbox-ui's PillTabs measures with one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const RECORD: WorkProductRecord = {
  id: 'wp-1',
  workspaceId: 'ws',
  threadId: 't-1',
  scopeKey: 'contract:acme-msa',
  status: 'ready',
  version: 2,
  artifact: {
    kind: 'redline',
    title: 'Acme MSA Redline',
    path: 'out/acme-msa.md',
    content: 'Indemnification: mutual, capped at fees.\n',
    baseline: { content: 'Indemnification: unlimited, one-way.\n' },
  },
  evidence: [
    {
      id: 'e1',
      sourceRef: 'corpus/ca-civ-2782.md',
      locator: { range: '¶2', quote: 'construction contracts may not…' },
      target: 'clause:indemnification',
      claim: 'Unlimited one-way indemnity is unenforceable here',
    },
  ],
  exceptions: [
    { id: 'x1', severity: 'material', kind: 'inconsistent_source', message: 'Two governing-law clauses', resolved: false },
  ],
  checks: [{ id: 'c1', name: 'evidence_coverage', passed: true, source: 'platform' }],
  provenance: { profileHash: 'hash-abcdef1234', runId: 'run-1', servingModels: ['gpt-5'], producedAt: 1 },
  history: [
    {
      version: 1,
      status: 'superseded',
      provenance: { profileHash: 'hash-old', runId: 'run-0', servingModels: ['gpt-5'], producedAt: 0 },
      artifactPath: 'snapshots/v1.md',
      at: 0,
    },
    {
      version: 2,
      status: 'ready',
      provenance: { profileHash: 'hash-abcdef1234', runId: 'run-1', servingModels: ['gpt-5'], producedAt: 1 },
      artifactPath: 'snapshots/v2.md',
      at: 1,
    },
  ],
  createdAt: 0,
  updatedAt: 1,
}

describe('WorkProductPane (sandbox-ui composition)', () => {
  it('defaults to the product-chosen tab: diff for a redline product', () => {
    render(<WorkProductPane workProduct={RECORD} defaultTab="diff" />)
    // Diff stats from computeDiffStats over baseline → current.
    expect(screen.getByText('+1')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
  })

  it('lineage tab renders the evidence table', () => {
    render(<WorkProductPane workProduct={RECORD} defaultTab="lineage" />)
    expect(screen.getByText('clause:indemnification')).toBeTruthy()
    expect(screen.getByText('corpus/ca-civ-2782.md')).toBeTruthy()
  })

  it('tabs switch: exceptions and checks render their lists', () => {
    render(<WorkProductPane workProduct={RECORD} defaultTab="artifact" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Exceptions (1)' }))
    expect(screen.getByText('Two governing-law clauses')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Checks (1)' }))
    expect(screen.getByText('evidence_coverage')).toBeTruthy()
  })

  it('history tab loads a version compare through the injected loadVersionBody seam', async () => {
    const loadVersionBody = vi.fn(async (ref: string) => (ref === 'snapshots/v1.md' ? 'old body\n' : 'new body\n'))
    render(<WorkProductPane workProduct={RECORD} defaultTab="history" loadVersionBody={loadVersionBody} />)
    expect(screen.getByText('v1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compare v1 → v2' }))
    await waitFor(() => expect(screen.getByText('v1 → v2')).toBeTruthy())
    expect(loadVersionBody).toHaveBeenCalledWith('snapshots/v1.md')
    expect(loadVersionBody).toHaveBeenCalledWith('snapshots/v2.md')
  })

  it('falls back to artifact when the requested default tab is unavailable', () => {
    const noBaseline: WorkProductRecord = {
      ...RECORD,
      artifact: { kind: 'redline', title: 'T', content: 'x' },
    }
    render(<WorkProductPane workProduct={noBaseline} defaultTab="diff" />)
    // No diff tab without a baseline; the artifact body renders instead.
    expect(screen.queryByRole('tab', { name: 'Diff' })).toBeNull()
  })
})
