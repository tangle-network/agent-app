import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  canonicalRecordJson,
  defaultRecordMaterialDifference,
  detectRecordConflict,
  recordKeyString,
  recordUlid,
  resolveWriteReviewState,
  validateRecordValue,
  RECORD_KEY_SENTINEL,
  RECORD_PERIOD_SENTINEL,
  RECORD_REVIEW_STATES,
  type RecordWritePolicy,
} from '../../src/record'

const policy: RecordWritePolicy = {
  schemas: {},
  reviewStateOnWrite: { direct: 'accepted', extracted: 'proposed' },
}

describe('canonical value encoding', () => {
  it('sorts object keys at every depth so key order never reads as a change', () => {
    const a = canonicalRecordJson({ b: 2, a: { d: 4, c: [{ f: 6, e: 5 }] } })
    const b = canonicalRecordJson({ a: { c: [{ e: 5, f: 6 }], d: 4 }, b: 2 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":[{"e":5,"f":6}],"d":4},"b":2}')
  })

  it('preserves array order, which IS meaning', () => {
    expect(canonicalRecordJson([1, 2])).not.toBe(canonicalRecordJson([2, 1]))
  })

  it('encodes an unserializable value as null rather than undefined', () => {
    expect(canonicalRecordJson(undefined)).toBe('null')
    expect(() => JSON.parse(canonicalRecordJson(undefined))).not.toThrow()
  })
})

describe('the conflict rule', () => {
  const head = { sourceKind: 'direct', valueJson: '1', affirmedEmpty: false }

  it('fires on a different source kind with a different value', () => {
    expect(detectRecordConflict(policy, head, { sourceKind: 'extracted', valueJson: '2', affirmedEmpty: false })).toBe(true)
  })

  it('is silent when the same source kind restates', () => {
    expect(detectRecordConflict(policy, head, { sourceKind: 'direct', valueJson: '2', affirmedEmpty: false })).toBe(false)
  })

  it('is silent when another source kind corroborates', () => {
    expect(detectRecordConflict(policy, head, { sourceKind: 'extracted', valueJson: '1', affirmedEmpty: false })).toBe(false)
  })

  it('fires when one side asserts emptiness and the other a value', () => {
    expect(defaultRecordMaterialDifference(
      { sourceKind: 'direct', valueJson: 'null', affirmedEmpty: true },
      { sourceKind: 'extracted', valueJson: 'null', affirmedEmpty: false },
    )).toBe(true)
  })

  it('is silent when there is no head at all', () => {
    expect(detectRecordConflict(policy, undefined, { sourceKind: 'extracted', valueJson: '2', affirmedEmpty: false })).toBe(false)
  })

  it('honours a consumer override', () => {
    const tolerant: RecordWritePolicy = { ...policy, isMateriallyDifferent: () => false }
    expect(detectRecordConflict(tolerant, head, { sourceKind: 'extracted', valueJson: '2', affirmedEmpty: false })).toBe(false)
  })
})

describe('review state on write', () => {
  it('reads the consumer map', () => {
    const direct = resolveWriteReviewState(policy, 'direct')
    expect(direct.succeeded && direct.value).toBe('accepted')
    const extracted = resolveWriteReviewState(policy, 'extracted')
    expect(extracted.succeeded && extracted.value).toBe('proposed')
  })

  it('refuses an undeclared source kind and names the declared ones', () => {
    const result = resolveWriteReviewState(policy, 'nope')
    expect(result.succeeded).toBe(false)
    if (result.succeeded) return
    expect(result.code).toBe('unknown-source-kind')
    expect(result.error).toContain('direct, extracted')
  })
})

describe('validators', () => {
  it('accepts a real zod schema through the structural safeParse contract', () => {
    const ok = validateRecordValue(z.number().int().positive(), 7)
    expect(ok.succeeded && ok.value).toBe(7)
  })

  it('flattens a zod failure into readable messages', () => {
    const bad = validateRecordValue(z.number().int().positive(), -1)
    expect(bad.succeeded).toBe(false)
    if (bad.succeeded) return
    expect(bad.code).toBe('invalid-value')
    expect(bad.error.length).toBeGreaterThan(0)
  })

  it('returns the value the schema COERCED, not the raw input', () => {
    const coerced = validateRecordValue(z.coerce.number(), '42')
    expect(coerced.succeeded && coerced.value).toBe(42)
  })

  it('accepts a plain function validator', () => {
    const validator = (value: unknown) => typeof value === 'string'
      ? ({ succeeded: true, value: value.trim() } as const)
      : ({ succeeded: false, error: 'not a string', code: 'invalid-value' } as const)
    const ok = validateRecordValue(validator, '  hi ')
    expect(ok.succeeded && ok.value).toBe('hi')
    const bad = validateRecordValue(validator, 3)
    expect(bad.succeeded).toBe(false)
  })
})

describe('keys', () => {
  it('joins on a separator no stored text can contain', () => {
    const joined = recordKeyString({ dimension: 'a', path: 'b', itemKey: 'c', period: 1 })
    expect(joined.split('\u0000')).toEqual(['a', 'b', 'c', '1'])
  })

  it('keeps keys distinct when a segment contains dots, spaces or the empty sentinel', () => {
    const keys = [
      { dimension: '', path: 'a.b', itemKey: '', period: 0 },
      { dimension: '', path: 'a', itemKey: 'b', period: 0 },
      { dimension: 'a', path: 'b', itemKey: '', period: 0 },
      { dimension: '', path: 'a b', itemKey: '', period: 0 },
      { dimension: '', path: 'a.b', itemKey: '', period: 1 },
    ]
    expect(new Set(keys.map(recordKeyString)).size).toBe(keys.length)
  })

  it('exposes sentinels that are values, never null', () => {
    expect(RECORD_KEY_SENTINEL).toBe('')
    expect(RECORD_PERIOD_SENTINEL).toBe(0)
    expect(RECORD_KEY_SENTINEL).not.toBe(null)
    expect(RECORD_REVIEW_STATES).toEqual(['proposed', 'accepted', 'rejected'])
  })
})

describe('id minting', () => {
  it('produces 26 sortable characters that track creation time', () => {
    const early = recordUlid(1_000_000_000_000)
    const late = recordUlid(1_000_000_001_000)
    expect(early).toHaveLength(26)
    expect(late > early).toBe(true)
  })

  it('never repeats within one millisecond', () => {
    const ids = new Set(Array.from({ length: 500 }, () => recordUlid(1_700_000_000_000)))
    expect(ids.size).toBe(500)
  })

  it('refuses an out-of-range timestamp instead of emitting a malformed id', () => {
    expect(() => recordUlid(-1)).toThrow(/out of range/)
    expect(() => recordUlid(2 ** 49)).toThrow(/out of range/)
  })
})

describe('the pure leaf takes no peer', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'record')

  /** Every `from '…'` / `import '…'` specifier in a file. */
  function specifiers(file: string): string[] {
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((match) => match[1] as string)
  }

  it('the leaf files import only each other', () => {
    for (const file of ['model.ts', 'fold.ts', 'ulid.ts', 'index.ts']) {
      for (const specifier of specifiers(join(root, file))) {
        expect(specifier.startsWith('.'), `${file} imports '${specifier}'`).toBe(true)
      }
    }
  })

  it('drizzle-orm appears only behind the /record/drizzle subpath', () => {
    for (const file of ['model.ts', 'fold.ts', 'ulid.ts', 'index.ts']) {
      expect(specifiers(join(root, file)).some((s) => s.startsWith('drizzle-orm'))).toBe(false)
    }
    const drizzleSpecifiers = ['drizzle/schema.ts', 'drizzle/store.ts']
      .flatMap((file) => specifiers(join(root, file)))
    expect(drizzleSpecifiers.some((s) => s.startsWith('drizzle-orm'))).toBe(true)
  })
})

describe('the module carries no domain vocabulary', () => {
  // The whole point of extracting this: three products hand-rolled the same
  // store and each baked its own nouns in. A word from any one of their domains
  // appearing here means the extraction leaked.
  const BANNED = [
    'tax', 'taxes', 'irs', 'jurisdiction', 'jurisdictions', 'legal', 'redline',
    'invoice', 'deduction', 'filing', 'crm', 'counterparty', 'employer', 'payer',
    'statute', 'attorney', 'litigation', 'w2', 'clause',
  ]
  // `WHERE clause` is SQL vocabulary, not a domain noun.
  const ALLOWED_PHRASES = ['where clause']

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return full.endsWith('.ts') ? [full] : []
    })
  }

  it('mentions none of the three products nouns anywhere in src/record', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'record')
    const files = sourceFiles(root)
    expect(files.length).toBeGreaterThan(3)

    const hits: string[] = []
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        let scanned = line.toLowerCase()
        for (const phrase of ALLOWED_PHRASES) scanned = scanned.split(phrase).join(' ')
        for (const word of BANNED) {
          if (new RegExp(`\\b${word}\\b`).test(scanned)) hits.push(`${file}:${index + 1} [${word}] ${line.trim()}`)
        }
      })
    }
    expect(hits).toEqual([])
  })
})
