import { describe, expect, it } from 'vitest'
import {
  foldRecordEntries,
  recordEntryVisibleInPeriod,
  recordFail,
  recordOk,
  type FoldableRecordEntry,
  type RecordFoldRules,
} from '../../src/record'
import {
  fixtureRules,
  HEADER_COUNT,
  HEADER_LABEL,
  ITEM_AMOUNT,
  ITEM_COLLECTION,
  ITEM_NOTE,
  type FoldedShape,
} from './fixtures'

function entry(partial: Partial<FoldableRecordEntry> & Pick<FoldableRecordEntry, 'id' | 'seq' | 'path'>): FoldableRecordEntry {
  return {
    dimension: '',
    period: 2000,
    itemKey: '',
    valueJson: 'null',
    affirmedEmpty: false,
    ...partial,
  }
}

const scattered: FoldableRecordEntry[] = [
  entry({ id: 'e1', seq: 1, path: HEADER_LABEL, valueJson: '"first"', period: 1999 }),
  entry({ id: 'e2', seq: 2, path: HEADER_COUNT, valueJson: '3' }),
  entry({ id: 'e3', seq: 3, path: ITEM_AMOUNT, itemKey: 'A', valueJson: '10' }),
  entry({ id: 'e4', seq: 4, path: ITEM_NOTE, itemKey: 'A', valueJson: '"alpha"' }),
  entry({ id: 'e5', seq: 5, path: ITEM_AMOUNT, itemKey: 'B', valueJson: '32.5' }),
  entry({ id: 'e6', seq: 6, path: HEADER_LABEL, valueJson: '"second"', period: 2000 }),
]

/** Deterministic shuffle so a failure reproduces from the seed. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const j = state % (i + 1)
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

describe('foldRecordEntries determinism', () => {
  it('produces the same result for every input order', () => {
    const baseline = foldRecordEntries(scattered, { rules: fixtureRules, period: 2000 })
    expect(baseline.succeeded).toBe(true)
    if (!baseline.succeeded) return

    for (let seed = 1; seed <= 40; seed++) {
      const folded = foldRecordEntries(shuffle(scattered, seed), { rules: fixtureRules, period: 2000 })
      expect(folded.succeeded).toBe(true)
      if (!folded.succeeded) return
      expect(folded.value.value, `seed ${seed}`).toEqual(baseline.value.value)
      expect(folded.value.entryCount, `seed ${seed}`).toBe(baseline.value.entryCount)
    }
  })

  it('orders items by seq, not by arrival', () => {
    const folded = foldRecordEntries(shuffle(scattered, 7), { rules: fixtureRules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.items.map((item) => item.key)).toEqual(['A', 'B'])
  })

  it('last write at the same key wins, whatever the arrival order', () => {
    const rewritten = [
      entry({ id: 'x2', seq: 20, path: HEADER_COUNT, valueJson: '9' }),
      entry({ id: 'x1', seq: 10, path: HEADER_COUNT, valueJson: '1' }),
    ]
    for (const order of [rewritten, [...rewritten].reverse()]) {
      const folded = foldRecordEntries(order, { rules: fixtureRules, period: 2000 })
      expect(folded.succeeded).toBe(true)
      if (!folded.succeeded) return
      expect(folded.value.value.header.count).toBe(9)
    }
  })
})

describe('period resolution', () => {
  it('carry-forward keeps only the newest entry at or before the period', () => {
    const folded = foldRecordEntries(scattered, { rules: fixtureRules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.header.label).toBe('second')
  })

  it('carry-forward resolves to the older entry at an earlier period', () => {
    const folded = foldRecordEntries(scattered, { rules: fixtureRules, period: 1999 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.header.label).toBe('first')
    expect(folded.value.value.header.count).toBe(null)
  })

  it('an exact-scope entry is invisible outside its own period', () => {
    const folded = foldRecordEntries(
      [entry({ id: 'p1', seq: 1, path: HEADER_COUNT, valueJson: '5', period: 2000 })],
      { rules: fixtureRules, period: 2001 },
    )
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.header.count).toBe(null)
    expect(folded.value.entryCount).toBe(0)
  })

  it('defaults every path to exact when the rules declare no scope', () => {
    const scopeless: RecordFoldRules<FoldedShape> = { ...fixtureRules, periodScope: undefined }
    const folded = foldRecordEntries(scattered, { rules: scopeless, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.header.label).toBe('second')
    expect(recordEntryVisibleInPeriod('exact', 1999, 2000)).toBe(false)
    expect(recordEntryVisibleInPeriod('carry-forward', 1999, 2000)).toBe(true)
  })
})

describe('negative assertions', () => {
  it('retracts at its seq and lets a later entry repopulate', () => {
    const entries = [
      entry({ id: 'r1', seq: 1, path: ITEM_AMOUNT, itemKey: 'A', valueJson: '10' }),
      entry({ id: 'r2', seq: 2, path: ITEM_COLLECTION, affirmedEmpty: true }),
      entry({ id: 'r3', seq: 3, path: ITEM_AMOUNT, itemKey: 'C', valueJson: '4' }),
    ]
    const folded = foldRecordEntries(shuffle(entries, 3), { rules: fixtureRules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.items.map((item) => item.key)).toEqual(['C'])
    expect(folded.value.value.emptied).toEqual([])
    expect(folded.value.value.total).toBe(4)
  })

  it('leaves the path marked empty when nothing repopulates it', () => {
    const entries = [
      entry({ id: 'r1', seq: 1, path: ITEM_AMOUNT, itemKey: 'A', valueJson: '10' }),
      entry({ id: 'r2', seq: 2, path: ITEM_COLLECTION, affirmedEmpty: true }),
    ]
    const folded = foldRecordEntries(entries, { rules: fixtureRules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.items).toEqual([])
    expect(folded.value.value.emptied).toEqual([ITEM_COLLECTION])
  })

  it('rejects the whole fold when the rules define no retract', () => {
    const noRetract: RecordFoldRules<FoldedShape> = { ...fixtureRules, retract: undefined }
    const folded = foldRecordEntries(
      [entry({ id: 'r1', seq: 1, path: ITEM_COLLECTION, affirmedEmpty: true })],
      { rules: noRetract, period: 2000 },
    )
    expect(folded.succeeded).toBe(false)
    if (folded.succeeded) return
    expect(folded.code).toBe('fold-failed')
    expect(folded.error).toContain('no retract')
  })
})

describe('fold failures are loud', () => {
  it('rejects an entry the rules cannot place, naming its id', () => {
    const folded = foldRecordEntries(
      [entry({ id: 'bad-1', seq: 1, path: 'nothing.here', valueJson: '1' })],
      { rules: fixtureRules, period: 2000 },
    )
    expect(folded.succeeded).toBe(false)
    if (folded.succeeded) return
    expect(folded.error).toContain('bad-1')
    expect(folded.error).toContain('nothing.here')
  })

  it('rejects unparseable stored JSON instead of skipping the entry', () => {
    const folded = foldRecordEntries(
      [entry({ id: 'bad-2', seq: 1, path: HEADER_COUNT, valueJson: '{oops' })],
      { rules: fixtureRules, period: 2000 },
    )
    expect(folded.succeeded).toBe(false)
    if (folded.succeeded) return
    expect(folded.error).toContain('unparseable')
  })

  it('surfaces a finalize failure', () => {
    const failing: RecordFoldRules<FoldedShape> = {
      ...fixtureRules,
      finalize: () => recordFail('fold-failed', 'derived value unavailable'),
    }
    const folded = foldRecordEntries([], { rules: failing, period: 2000 })
    expect(folded.succeeded).toBe(false)
    if (folded.succeeded) return
    expect(folded.error).toContain('derived value unavailable')
  })

  it('rejects a non-integer period', () => {
    const folded = foldRecordEntries([], { rules: fixtureRules, period: 2000.5 })
    expect(folded.succeeded).toBe(false)
    if (folded.succeeded) return
    expect(folded.code).toBe('invalid-input')
  })
})

describe('derived values', () => {
  it('computes them on every fold rather than reading a stored total', () => {
    const folded = foldRecordEntries(scattered, { rules: fixtureRules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.total).toBe(42.5)
  })

  it('starts from a fresh accumulator each call', () => {
    const first = foldRecordEntries(scattered, { rules: fixtureRules, period: 2000 })
    const second = foldRecordEntries([], { rules: fixtureRules, period: 2000 })
    expect(first.succeeded && second.succeeded).toBe(true)
    if (!first.succeeded || !second.succeeded) return
    expect(second.value.value.items).toEqual([])
    expect(first.value.value.items).toHaveLength(2)
  })

  it('applies a rule failure from apply, not silently', () => {
    const rules: RecordFoldRules<FoldedShape> = {
      ...fixtureRules,
      apply: () => recordOk(undefined),
    }
    const folded = foldRecordEntries(scattered, { rules, period: 2000 })
    expect(folded.succeeded).toBe(true)
    if (!folded.succeeded) return
    expect(folded.value.value.items).toEqual([])
  })
})
