/**
 * A deliberately domain-free consumer of the record module: abstract paths, an
 * abstract folded shape, and a policy that exercises both validator forms (a
 * real `zod` schema through the structural `safeParse` contract, and a plain
 * function). If any word in here reads like tax, legal or CRM vocabulary, the
 * module under test has leaked a domain assumption.
 */

import { z } from 'zod'
import {
  recordFail,
  recordOk,
  type RecordFoldRules,
  type RecordOutcome,
  type RecordPeriodScope,
  type RecordWritePolicy,
} from '../../src/record'

/** What the fixture folds into. */
export interface FoldedShape {
  header: { label: string | null; count: number | null }
  items: Array<{ key: string; amount: number | null; note: string | null }>
  /** Paths a negative assertion retracted and nothing repopulated. */
  emptied: string[]
  /** Derived in `finalize` — never stored. */
  total: number | null
}

export const HEADER_LABEL = 'header.label'
export const HEADER_COUNT = 'header.count'
export const ITEM_AMOUNT = 'items.amount'
export const ITEM_NOTE = 'items.note'
export const ITEM_COLLECTION = 'items'

/** `header.label` carries forward; everything else is period-exact. */
export function fixturePeriodScope(path: string): RecordPeriodScope {
  return path === HEADER_LABEL ? 'carry-forward' : 'exact'
}

const positiveAmount = z.number().finite().nonnegative()

/** A plain-function validator, the non-`safeParse` form. */
function nonEmptyString(value: unknown): RecordOutcome<unknown> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return recordFail('invalid-value', 'expected a non-empty string')
  }
  return recordOk(value.trim())
}

export const fixturePolicy: RecordWritePolicy = {
  schemas: {
    [HEADER_LABEL]: nonEmptyString,
    [HEADER_COUNT]: z.number().int().nonnegative(),
    [ITEM_AMOUNT]: positiveAmount,
    [ITEM_NOTE]: nonEmptyString,
  },
  affirmablePaths: [ITEM_COLLECTION],
  reviewStateOnWrite: {
    direct: 'accepted',
    extracted: 'proposed',
    imported: 'proposed',
  },
  requireSourceRef: ['extracted'],
  canonicalizeItemKey: (path, raw) => {
    if (path === HEADER_LABEL || path === HEADER_COUNT) {
      return raw === '' ? recordOk('') : recordFail('invalid-input', `'${path}' takes no itemKey`)
    }
    if (raw === '') return recordFail('invalid-input', `'${path}' requires an itemKey`)
    return recordOk(raw.trim().toUpperCase())
  },
  canonicalizeDimension: (_path, raw) => recordOk(raw.trim().toLowerCase()),
  minPeriod: 0,
  maxPeriod: 9999,
}

/** Grouping rules over the abstract shape. */
export const fixtureRules: RecordFoldRules<FoldedShape> = {
  init: () => ({ header: { label: null, count: null }, items: [], emptied: [], total: null }),
  periodScope: fixturePeriodScope,
  apply(draft, entry) {
    if (entry.path === HEADER_LABEL) {
      if (typeof entry.value !== 'string') return recordFail('fold-failed', 'expected a string')
      draft.header.label = entry.value
      return recordOk(undefined)
    }
    if (entry.path === HEADER_COUNT) {
      if (typeof entry.value !== 'number') return recordFail('fold-failed', 'expected a number')
      draft.header.count = entry.value
      return recordOk(undefined)
    }
    if (entry.path === ITEM_AMOUNT || entry.path === ITEM_NOTE) {
      const item = draft.items.find((candidate) => candidate.key === entry.itemKey)
        ?? pushItem(draft, entry.itemKey)
      if (entry.path === ITEM_AMOUNT) {
        if (typeof entry.value !== 'number') return recordFail('fold-failed', 'expected a number')
        item.amount = entry.value
      } else {
        if (typeof entry.value !== 'string') return recordFail('fold-failed', 'expected a string')
        item.note = entry.value
      }
      draft.emptied = draft.emptied.filter((path) => path !== ITEM_COLLECTION)
      return recordOk(undefined)
    }
    return recordFail('fold-failed', `no rule for path '${entry.path}'`)
  },
  retract(draft, entry) {
    if (entry.path !== ITEM_COLLECTION) return recordFail('fold-failed', `'${entry.path}' is not retractable`)
    draft.items = []
    if (!draft.emptied.includes(ITEM_COLLECTION)) draft.emptied.push(ITEM_COLLECTION)
    return recordOk(undefined)
  },
  finalize(draft) {
    const amounts = draft.items.map((item) => item.amount).filter((amount): amount is number => amount !== null)
    draft.total = amounts.length === 0 ? null : amounts.reduce((sum, amount) => sum + amount, 0)
    return recordOk(undefined)
  },
}

function pushItem(draft: FoldedShape, key: string) {
  const item = { key, amount: null, note: null }
  draft.items.push(item)
  return item
}
