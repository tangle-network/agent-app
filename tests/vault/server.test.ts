import { describe, expect, it } from 'vitest'
import {
  assessVaultDeletionBatch,
  compareIncarnationBaseline,
  VAULT_DELETION_REFUSAL_MIN_LIVE_FILES,
  VAULT_DELETION_REFUSAL_RATIO,
  type FilesystemIncarnationLike,
} from '../../src/vault/server'

/** Build a baseline path list `p0..p{n-1}` and take the first `survive` of
 *  them as the surviving (non-deleted) set — mirrors how gtm derives
 *  `wouldDeletePaths` from a live baseline minus what's still present. */
function paths(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `p${i}`)
}

describe('assessVaultDeletionBatch — constants', () => {
  it('exports the exact gtm thresholds', () => {
    expect(VAULT_DELETION_REFUSAL_RATIO).toBe(0.75)
    expect(VAULT_DELETION_REFUSAL_MIN_LIVE_FILES).toBe(10)
  })
})

describe('assessVaultDeletionBatch — gtm parity fixtures', () => {
  it('1 live, 0 survive -> refused all-files (below both floors)', () => {
    const baseline = paths(1)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: baseline })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('all-files')
    expect(result.wouldDelete).toBe(1)
    expect(result.baselineLive).toBe(1)
  })

  it('11 live, 1 survives -> refused ratio-exceeded; 10 deletion paths', () => {
    const baseline = paths(11)
    const survivor = baseline[0]!
    const deletions = baseline.filter((p) => p !== survivor)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('ratio-exceeded')
    expect(result.wouldDeletePaths.length).toBe(10)
    expect(result.wouldDeletePaths).toEqual([...deletions].sort())
  })

  it('2 live, 1 survives (0.5 ratio) -> allowed', () => {
    const baseline = paths(2)
    const deletions = [baseline[0]!]
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.allowed).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(result.deletionRatio).toBeCloseTo(0.5)
  })

  it('2 live, manifestEmpty -> refused empty-manifest, ratio 1', () => {
    const baseline = paths(2)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: [], manifestEmpty: true })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('empty-manifest')
    expect(result.deletionRatio).toBe(1)
    expect(result.wouldDeletePaths).toEqual([...baseline].sort())
  })

  it('95 live, 1 survives (94/95) -> refused ratio-exceeded, NOT all-files', () => {
    const baseline = paths(95)
    const survivor = baseline[0]!
    const deletions = baseline.filter((p) => p !== survivor)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('ratio-exceeded')
    expect(result.wouldDelete).toBe(94)
    expect(result.baselineLive).toBe(95)
  })

  it('20 live, 1 deleted (0.05) -> allowed', () => {
    const baseline = paths(20)
    const deletions = [baseline[0]!]
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.allowed).toBe(true)
    expect(result.deletionRatio).toBeCloseTo(0.05)
  })

  it('3 live, 2 deleted (0.667 ratio, count 3 < 10) -> allowed (ratio-floor)', () => {
    const baseline = paths(3)
    const deletions = baseline.slice(0, 2)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.allowed).toBe(true)
    expect(result.deletionRatio).toBeCloseTo(2 / 3)
  })
})

describe('assessVaultDeletionBatch — ratio boundaries', () => {
  it('12 live / 9 deleted (ratio exactly 0.75) -> refused', () => {
    const baseline = paths(12)
    const deletions = baseline.slice(0, 9)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.deletionRatio).toBeCloseTo(0.75)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('ratio-exceeded')
  })

  it('10 live / 7 deleted (0.7) -> allowed', () => {
    const baseline = paths(10)
    const deletions = baseline.slice(0, 7)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.deletionRatio).toBeCloseTo(0.7)
    expect(result.allowed).toBe(true)
  })

  it('9 live / 8 deleted (0.889 ratio, count 9 < 10) -> allowed (one survives)', () => {
    const baseline = paths(9)
    const deletions = baseline.slice(0, 8)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: deletions })
    expect(result.deletionRatio).toBeCloseTo(8 / 9)
    expect(result.allowed).toBe(true)
  })
})

describe('assessVaultDeletionBatch — reason precedence', () => {
  it('manifestEmpty + full proposedDeletions -> empty-manifest wins over all-files', () => {
    const baseline = paths(5)
    const result = assessVaultDeletionBatch({
      baselinePaths: baseline,
      proposedDeletions: baseline,
      manifestEmpty: true,
    })
    expect(result.reason).toBe('empty-manifest')
  })

  it('non-empty manifest wiping everything -> all-files (not ratio-exceeded)', () => {
    const baseline = paths(20)
    const result = assessVaultDeletionBatch({
      baselinePaths: baseline,
      proposedDeletions: baseline,
      manifestEmpty: false,
    })
    expect(result.reason).toBe('all-files')
  })
})

describe('assessVaultDeletionBatch — other behaviors', () => {
  it('reports deletionRatio even when allowed', () => {
    const baseline = paths(4)
    const result = assessVaultDeletionBatch({ baselinePaths: baseline, proposedDeletions: [baseline[0]!] })
    expect(result.allowed).toBe(true)
    expect(result.deletionRatio).toBeCloseTo(0.25)
  })

  it('supports a custom policy override', () => {
    const baseline = paths(4)
    const deletions = baseline.slice(0, 2) // ratio 0.5
    const strict = assessVaultDeletionBatch({
      baselinePaths: baseline,
      proposedDeletions: deletions,
      policy: { refusalRatio: 0.4, minLiveFiles: 4 },
    })
    expect(strict.allowed).toBe(false)
    expect(strict.reason).toBe('ratio-exceeded')

    const lenient = assessVaultDeletionBatch({
      baselinePaths: baseline,
      proposedDeletions: deletions,
      policy: { refusalRatio: 0.9, minLiveFiles: 4 },
    })
    expect(lenient.allowed).toBe(true)
  })

  it('empty baseline -> deletionRatio 0, allowed', () => {
    const result = assessVaultDeletionBatch({ baselinePaths: [], proposedDeletions: [] })
    expect(result.allowed).toBe(true)
    expect(result.deletionRatio).toBe(0)
    expect(result.baselineLive).toBe(0)
    expect(result.wouldDeletePaths).toEqual([])
  })

  it('proposedDeletions is intersected with baselinePaths (unknown paths ignored)', () => {
    const baseline = paths(5)
    const result = assessVaultDeletionBatch({
      baselinePaths: baseline,
      proposedDeletions: [...baseline.slice(0, 1), 'not-in-baseline'],
    })
    expect(result.wouldDelete).toBe(1)
    expect(result.wouldDeletePaths).toEqual([baseline[0]])
  })
})

function readyIncarnation(overrides: Partial<FilesystemIncarnationLike> = {}): FilesystemIncarnationLike {
  return {
    filesystemIncarnationId: 'inc-123',
    filesystemIncarnationProvenance: 'fresh',
    filesystemIncarnationReadiness: 'ready',
    ...overrides,
  }
}

describe('compareIncarnationBaseline', () => {
  it('match: baseline id equals current id, ready, valid provenance', () => {
    const result = compareIncarnationBaseline('inc-123', readyIncarnation())
    expect(result).toEqual({ verdict: 'match' })
  })

  it('mismatch: carries both ids', () => {
    const result = compareIncarnationBaseline('inc-old', readyIncarnation({ filesystemIncarnationId: 'inc-new' }))
    expect(result).toEqual({ verdict: 'mismatch', baselineId: 'inc-old', currentId: 'inc-new' })
  })

  it('no-baseline: no baselineId recorded', () => {
    const result = compareIncarnationBaseline(undefined, readyIncarnation())
    expect(result).toEqual({ verdict: 'no-baseline' })
  })

  it("not-ready: readiness is literally 'transitioning'", () => {
    const result = compareIncarnationBaseline(
      'inc-123',
      readyIncarnation({ filesystemIncarnationReadiness: 'transitioning' }),
    )
    expect(result).toEqual({ verdict: 'not-ready', readiness: 'transitioning' })
  })

  it('not-ready: readiness is undefined', () => {
    const result = compareIncarnationBaseline(
      'inc-123',
      readyIncarnation({ filesystemIncarnationReadiness: undefined }),
    )
    expect(result).toEqual({ verdict: 'not-ready', readiness: undefined })
  })

  it('unidentified: missing id', () => {
    const result = compareIncarnationBaseline('inc-123', readyIncarnation({ filesystemIncarnationId: undefined }))
    expect(result).toEqual({ verdict: 'unidentified' })
  })

  it('unidentified: empty-string id', () => {
    const result = compareIncarnationBaseline('inc-123', readyIncarnation({ filesystemIncarnationId: '' }))
    expect(result).toEqual({ verdict: 'unidentified' })
  })

  it('unidentified: invalid provenance', () => {
    const result = compareIncarnationBaseline(
      'inc-123',
      // Deliberately invalid at the type level to prove the runtime check
      // rejects malformed input a caller might get from an untyped source.
      readyIncarnation({ filesystemIncarnationProvenance: 'corrupted' as FilesystemIncarnationLike['filesystemIncarnationProvenance'] }),
    )
    expect(result).toEqual({ verdict: 'unidentified' })
  })

  it('fail-closed precedence: not-ready beats mismatch', () => {
    const result = compareIncarnationBaseline(
      'inc-old',
      readyIncarnation({ filesystemIncarnationId: 'inc-new', filesystemIncarnationReadiness: 'transitioning' }),
    )
    expect(result.verdict).toBe('not-ready')
  })

  it('fail-closed precedence: unidentified short-circuits before baseline compare', () => {
    const result = compareIncarnationBaseline(
      'inc-new', // would otherwise "match" a coincidentally-equal id
      readyIncarnation({ filesystemIncarnationId: 'inc-new', filesystemIncarnationProvenance: undefined as unknown as 'fresh' }),
    )
    expect(result.verdict).toBe('unidentified')
  })
})
