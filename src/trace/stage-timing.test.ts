import { describe, expect, it, vi } from 'vitest'
import {
  buildStageTimingRecord,
  createStageTiming,
  type StageTimingRecord,
} from './stage-timing'

describe('stage timing', () => {
  it('builds a bounded record and removes credential-shaped detail', () => {
    const record = buildStageTimingRecord(
      {
        runId: 'run-1',
        workspaceId: 'workspace-1',
        path: 'cold-create',
      },
      'authorize.session',
      100,
      25,
      {
        detail: {
          cache: 'hit',
          apiKey: 'must-not-appear',
          token: 'must-not-appear',
          count: 2,
          infinite: Number.POSITIVE_INFINITY,
        },
      },
    )

    expect(record).toMatchObject({
      evt: 'stage_timing',
      v: 1,
      stage: 'authorize.session',
      kind: 'leaf',
      startedAt: 100,
      durationMs: 25,
      outcome: 'ok',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      path: 'cold-create',
      detail: { cache: 'hit', count: 2, infinite: null },
    })
    expect(record?.detail).not.toHaveProperty('apiKey')
    expect(record?.detail).not.toHaveProperty('token')
  })

  it('bounds every attacker-influenced string and detail count', () => {
    const long = 'x'.repeat(200)
    const detail = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`key-${index}`, long]),
    )
    detail[long] = long
    const record = buildStageTimingRecord(
      { runId: long, workspaceId: long, path: long },
      long,
      1,
      2,
      { detail },
    )

    expect(record?.runId).toHaveLength(128)
    expect(record?.workspaceId).toHaveLength(128)
    expect(record?.path).toHaveLength(128)
    expect(record?.stage).toHaveLength(80)
    expect(Object.keys(record?.detail ?? {})).toHaveLength(8)
    expect(Object.keys(record?.detail ?? {}).every((key) => key.length <= 64)).toBe(true)
    expect(Object.values(record?.detail ?? {}).every((value) => String(value).length <= 64)).toBe(true)
  })

  it('returns the measured value and preserves the original timeout', async () => {
    const records: StageTimingRecord[] = []
    let clock = 100
    const timing = createStageTiming({
      context: { runId: 'run-2' },
      emit: (record) => {
        records.push(record)
      },
      now: () => clock,
    })
    const success = timing.measure('turn.compose', {}, async () => {
      clock = 125
      return 42
    })
    await expect(success).resolves.toBe(42)

    const failure = Object.assign(new Error('upstream failed'), { code: 'ETIMEDOUT' })
    const failed = timing.measure('turn.first-event', {}, async () => {
      clock = 175
      throw failure
    })
    await expect(failed).rejects.toBe(failure)

    expect(records).toEqual([
      expect.objectContaining({ stage: 'turn.compose', durationMs: 25, outcome: 'ok' }),
      expect.objectContaining({ stage: 'turn.first-event', durationMs: 50, outcome: 'timeout' }),
    ])
  })

  it('returns the measured value when the injected clock throws', async () => {
    const emit = vi.fn()
    const timing = createStageTiming({
      context: { runId: 'run-clock' },
      emit,
      now: () => {
        throw new Error('clock unavailable')
      },
    })

    await expect(timing.measure('turn.compose', {}, async () => 42)).resolves.toBe(42)
    expect(emit).not.toHaveBeenCalled()
  })

  it('contains a clock failure while finishing success or failure', async () => {
    let calls = 0
    const emit = vi.fn()
    const timing = createStageTiming({
      context: { runId: 'run-finish-clock' },
      emit,
      now: () => {
        calls += 1
        if (calls % 2 === 0) throw new Error('clock unavailable')
        return 10
      },
    })

    await expect(timing.measure('turn.success', {}, async () => 42)).resolves.toBe(42)
    const failure = Object.create(null)
    await expect(
      timing.measure('turn.failure', {}, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(emit).not.toHaveBeenCalled()
  })

  it('preserves the identity of a hostile rejected value', async () => {
    const failure = Object.create(null)
    const timing = createStageTiming({
      context: { runId: 'run-hostile-error' },
      emit: vi.fn(),
      now: () => 10,
    })

    const result = timing.measure('turn.first-event', {}, async () => {
      throw failure
    })

    await expect(result).rejects.toBe(failure)
  })

  it('drops credential-shaped and unsupported detail values', () => {
    const detail = {
      safe: 'ok',
      header: 'Bearer do-not-leak',
      nested: { token: 'do-not-leak' },
      unsupported: BigInt(1),
    } as unknown as StageTimingRecord['detail']
    const record = buildStageTimingRecord(
      { runId: 'run-detail' },
      'turn.detail',
      1,
      2,
      { detail },
    )

    expect(record?.detail).toEqual({ safe: 'ok' })
    expect(JSON.stringify(record)).not.toContain('Bearer')
    expect(JSON.stringify(record)).not.toContain('do-not-leak')
  })

  it('rejects runtime-invalid outcome and kind values', () => {
    expect(
      buildStageTimingRecord(
        { runId: 'run-invalid-outcome' },
        'turn.invalid-outcome',
        1,
        2,
        { outcome: 'unknown' as never },
      ),
    ).toBeNull()
    expect(
      buildStageTimingRecord(
        { runId: 'run-invalid-kind' },
        'turn.invalid-kind',
        1,
        2,
        { kind: 'branch' as never },
      ),
    ).toBeNull()
  })

  it('emits a handle once and merges start and finish detail', () => {
    const records: StageTimingRecord[] = []
    let clock = 10
    const timing = createStageTiming({
      context: { runId: 'run-3' },
      emit: (record) => {
        records.push(record)
      },
      now: () => clock,
    })
    const handle = timing.start('sandbox.bootstrap', { detail: { path: 'cold' } })
    clock = 20
    handle.done({ detail: { cache: 'miss' } })
    handle.fail(new Error('late cleanup'))

    expect(records).toEqual([
      expect.objectContaining({
        stage: 'sandbox.bootstrap',
        durationMs: 10,
        detail: { path: 'cold', cache: 'miss' },
      }),
    ])
  })

  it('contains invalid records and carrier failures', () => {
    const emit = vi.fn(() => {
      throw new Error('logging unavailable')
    })
    const timing = createStageTiming({
      context: { runId: 'run-4' },
      emit,
      now: () => 10,
    })

    expect(() => timing.recordDuration('', 10, 2)).not.toThrow()
    expect(emit).not.toHaveBeenCalled()
    expect(() => timing.recordDuration('authorize', 10, 2)).not.toThrow()
    expect(emit).toHaveBeenCalledOnce()
  })

  it('contains an asynchronous carrier rejection', async () => {
    const timing = createStageTiming({
      context: { runId: 'run-5' },
      emit: async () => {
        throw new Error('remote collector unavailable')
      },
      now: () => 10,
    })

    expect(() => timing.recordDuration('authorize', 1, 2)).not.toThrow()
    await Promise.resolve()
  })

  it('generates a run id only when the caller does not provide one', () => {
    const createRunId = vi.fn(() => 'generated-run')
    const emitted: StageTimingRecord[] = []
    const timing = createStageTiming({
      emit: (record) => {
        emitted.push(record)
      },
      createRunId,
      now: () => 10,
    })
    timing.recordDuration('turn', 1, 2)

    expect(createRunId).toHaveBeenCalledOnce()
    expect(emitted[0]?.runId).toBe('generated-run')
  })
})
