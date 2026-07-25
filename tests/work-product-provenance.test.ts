import { describe, expect, it } from 'vitest'

import type { JudgeVerdict } from '@tangle-network/agent-eval'
import {
  createInMemoryWorkProductStore,
  createWorkProductService,
  finalizeWorkProductProvenance,
  stampProvenance,
  workProductTrustInputs,
  type WorkProductRecord,
} from '../src/work-product/index'
import { trustVerdicts } from '../src/eval-campaign/index'

describe('provenance stamping + completion back-fill', () => {
  it('stampProvenance starts servingModels honestly empty', () => {
    const provenance = stampProvenance({ profileHash: 'h', runId: 'r', sessionId: 's' }, () => 42)
    expect(provenance).toEqual({ profileHash: 'h', runId: 'r', sessionId: 's', servingModels: [], producedAt: 42 })
  })

  it('finalizeWorkProductProvenance back-fills servingModels/costUsd on the record AND its history entries', async () => {
    const store = createInMemoryWorkProductStore()
    const service = createWorkProductService({ store, now: () => 1_000, generateId: () => 'wp-1' })
    const record = await service.create({
      workspaceId: 'ws',
      threadId: 't',
      scopeKey: 's',
      provenance: stampProvenance({ profileHash: 'h', runId: 'run-1' }),
    })
    await service.submit(record.id, {
      artifact: { kind: 'k', title: 'T', content: 'x' },
      checks: [],
      provenance: stampProvenance({ profileHash: 'h', runId: 'run-1' }),
    })
    // An unrelated record from another run must be untouched.
    await service.create({
      workspaceId: 'ws',
      threadId: 't2',
      scopeKey: 's2',
      id: 'wp-other',
      provenance: stampProvenance({ profileHash: 'h', runId: 'run-other' }),
    })

    const updated = await finalizeWorkProductProvenance(store, {
      workspaceId: 'ws',
      runId: 'run-1',
      servingModels: ['gpt-5'],
      costUsd: 0.42,
    })
    expect(updated.map((row) => row.id)).toEqual(['wp-1'])
    expect(updated[0]?.provenance).toMatchObject({ servingModels: ['gpt-5'], costUsd: 0.42 })
    expect(updated[0]?.history[0]?.provenance).toMatchObject({ servingModels: ['gpt-5'], costUsd: 0.42 })

    const other = await store.load('wp-other')
    expect(other?.provenance.servingModels).toEqual([])
    expect(store.events().filter((event) => event.step === 'wp.provenance')).toHaveLength(1)
  })
})

function record(id: string): WorkProductRecord {
  return {
    id,
    workspaceId: 'ws',
    threadId: null,
    scopeKey: id,
    status: 'ready',
    version: 1,
    artifact: null,
    evidence: [],
    exceptions: [],
    checks: [],
    provenance: { profileHash: 'h', runId: 'r', servingModels: [], producedAt: 1 },
    history: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

let judgeIndex = 0
const verdict = (score: number): JudgeVerdict<'quality'> => ({
  model: `judge-${++judgeIndex}`,
  perDimension: { quality: score },
  rationale: 'because',
})

describe('workProductTrustInputs — the trust-gate bridge', () => {
  it('maps records with retained judge verdicts into TrustItems and omits the rest', () => {
    const verdictsByRecord: Record<string, JudgeVerdict<'quality'>[]> = {
      a: [verdict(0.8), verdict(0.82), verdict(0.78)],
      b: [],
    }
    const items = workProductTrustInputs([record('a'), record('b'), record('c')], (row) => verdictsByRecord[row.id])
    expect(items.map((item) => item.itemId)).toEqual(['a'])
    expect(items[0]?.verdicts).toHaveLength(3)
  })

  it('feeds /eval-campaign trustVerdicts directly (compose, not duplicate)', () => {
    const items = workProductTrustInputs(
      [record('a'), record('b')],
      () => [verdict(0.8), verdict(0.81), verdict(0.79)],
    )
    const gate = trustVerdicts(items)
    expect(typeof gate.trustworthy).toBe('boolean')
    expect(gate.perItemSpread).toHaveProperty('a')
    expect(gate.perItemSpread).toHaveProperty('b')
  })
})
