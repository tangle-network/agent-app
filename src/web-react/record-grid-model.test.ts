import { describe, expect, it } from 'vitest'

import {
  EMPTY_RECORD_GRID_OVERLAY,
  diffRecordGridProposal,
  formatRecordGridValue,
  isRecordGridCellApplicable,
  parseRecordGridInput,
  projectRecordGridRows,
  pruneRecordGridOverlay,
  readRecordGridCell,
  recordGridEditorText,
  recordGridRowLabel,
  sumRecordGridColumn,
  validateRecordGridCell,
  validateRecordGridRow,
  withRecordGridCreated,
  withRecordGridRemoved,
  withRecordGridServerRow,
  withRecordGridUpdate,
  withoutRecordGridCreated,
  withoutRecordGridRemoved,
  withoutRecordGridUpdate,
  type RecordGridColumn,
  type RecordGridRow,
} from './record-grid-model'

const HOLDER: RecordGridColumn = { id: 'holder', kind: 'text', header: 'Holder', required: true, maxLength: 10 }
const SHARES: RecordGridColumn = { id: 'shares', kind: 'number', header: 'Shares', integer: true, min: 1 }
const PRICE: RecordGridColumn = { id: 'price', kind: 'currency', header: 'Price', currency: 'USD' }
const GRANTED: RecordGridColumn = { id: 'granted', kind: 'date', header: 'Granted', min: '2020-01-01' }
const CLASS: RecordGridColumn = {
  id: 'class',
  kind: 'select',
  header: 'Class',
  options: [
    { value: 'common', label: 'Common' },
    { value: 'preferred', label: 'Preferred' },
  ],
}
const VESTING: RecordGridColumn = { id: 'vesting', kind: 'boolean', header: 'Vesting' }
const CLIFF: RecordGridColumn = {
  id: 'cliffMonths',
  kind: 'number',
  header: 'Cliff months',
  required: true,
  dependsOn: { column: 'vesting', equals: true },
}

function row(id: string, values: Record<string, string | number | boolean | null>): RecordGridRow {
  return { id, values }
}

describe('parseRecordGridInput', () => {
  it('reads a number a person actually types: grouping, currency symbol, accounting negative', () => {
    expect(parseRecordGridInput(SHARES, '1,000,000')).toEqual({ succeeded: true, value: 1000000 })
    expect(parseRecordGridInput(PRICE, '$1,234.50')).toEqual({ succeeded: true, value: 1234.5 })
    expect(parseRecordGridInput(PRICE, '(1,200)')).toEqual({ succeeded: true, value: -1200 })
    expect(parseRecordGridInput(SHARES, '  ')).toEqual({ succeeded: true, value: null })
  })

  it('rejects a partly-numeric string instead of coercing it', () => {
    const outcome = parseRecordGridInput(SHARES, '12abc')
    expect(outcome.succeeded).toBe(false)
    if (outcome.succeeded) throw new Error('expected rejection')
    expect(outcome.error).toContain('Shares')
    expect(outcome.error).toContain('12abc')
  })

  it('rejects a date that is not on the calendar', () => {
    expect(parseRecordGridInput(GRANTED, '2025-02-30').succeeded).toBe(false)
    expect(parseRecordGridInput(GRANTED, '2025-1-5').succeeded).toBe(false)
    expect(parseRecordGridInput(GRANTED, '2025-02-28')).toEqual({ succeeded: true, value: '2025-02-28' })
  })

  it('trims text and normalizes an emptied cell to null', () => {
    expect(parseRecordGridInput(HOLDER, '  Jane  ')).toEqual({ succeeded: true, value: 'Jane' })
    expect(parseRecordGridInput(HOLDER, '')).toEqual({ succeeded: true, value: null })
  })
})

describe('validateRecordGridCell', () => {
  it('names the column when a required cell is empty', () => {
    expect(validateRecordGridCell(HOLDER, null)).toEqual({ succeeded: false, error: 'Holder is required.' })
  })

  it('explains a length breach with the actual length', () => {
    const outcome = validateRecordGridCell(HOLDER, 'Wintermute Capital')
    if (outcome.succeeded) throw new Error('expected rejection')
    expect(outcome.error).toBe('Holder must be at most 10 characters — got 18.')
  })

  it('explains a range and a whole-number breach', () => {
    const low = validateRecordGridCell(SHARES, 0)
    if (low.succeeded) throw new Error('expected rejection')
    expect(low.error).toBe('Shares must be at least 1 — got 0.')

    const fractional = validateRecordGridCell(SHARES, 1.5)
    if (fractional.succeeded) throw new Error('expected rejection')
    expect(fractional.error).toBe('Shares must be a whole number — got 1.5.')
  })

  it('lists the allowed options when a select value is off the list', () => {
    const outcome = validateRecordGridCell(CLASS, 'safe')
    if (outcome.succeeded) throw new Error('expected rejection')
    expect(outcome.error).toBe('Class must be one of: Common, Preferred — got “safe”.')
  })

  it('enforces a date floor', () => {
    const outcome = validateRecordGridCell(GRANTED, '2019-06-01')
    if (outcome.succeeded) throw new Error('expected rejection')
    expect(outcome.error).toBe('Granted must be on or after 2020-01-01 — got 2019-06-01.')
  })

  it('runs the caller rule after the built-in checks pass', () => {
    const column: RecordGridColumn = {
      id: 'ein',
      kind: 'text',
      header: 'EIN',
      validate: (value) => (typeof value === 'string' && /^\d{2}-\d{7}$/.test(value) ? null : 'EIN must look like 12-3456789.'),
    }
    expect(validateRecordGridCell(column, '12-3456789')).toEqual({ succeeded: true, value: '12-3456789' })
    expect(validateRecordGridCell(column, '123')).toEqual({ succeeded: false, error: 'EIN must look like 12-3456789.' })
  })

  it('refuses a value of the wrong type rather than coercing it', () => {
    expect(validateRecordGridCell(SHARES, 'many')).toEqual({ succeeded: false, error: 'Shares must be a number.' })
    expect(validateRecordGridCell(VESTING, 'yes')).toEqual({ succeeded: false, error: 'Vesting must be true or false.' })
  })
})

describe('readRecordGridCell', () => {
  it('parses then validates, so a typed cell reports the first thing that is wrong', () => {
    expect(readRecordGridCell(SHARES, '1,000')).toEqual({ succeeded: true, value: 1000 })
    const outcome = readRecordGridCell(SHARES, '0')
    if (outcome.succeeded) throw new Error('expected rejection')
    expect(outcome.error).toBe('Shares must be at least 1 — got 0.')
  })
})

describe('validateRecordGridRow', () => {
  it('keys every failure by column and summarizes the count', () => {
    const outcome = validateRecordGridRow([HOLDER, SHARES, CLASS], { holder: null, shares: 'x', class: 'common' })
    if (outcome.succeeded) throw new Error('expected rejection')
    expect(Object.keys(outcome.cellErrors).sort()).toEqual(['holder', 'shares'])
    expect(outcome.error).toContain('2 fields need attention')
    expect(outcome.cellErrors.holder).toBe('Holder is required.')
  })

  it('forces an inapplicable column to null instead of carrying a stale sub-form value', () => {
    const outcome = validateRecordGridRow([HOLDER, VESTING, CLIFF], {
      holder: 'Jane',
      vesting: false,
      cliffMonths: 12,
    })
    if (!outcome.succeeded) throw new Error(`expected acceptance: ${outcome.error}`)
    expect(outcome.value).toEqual({ holder: 'Jane', vesting: false, cliffMonths: null })
  })

  it('validates a dependent column once its dependency is satisfied', () => {
    const outcome = validateRecordGridRow([HOLDER, VESTING, CLIFF], { holder: 'Jane', vesting: true, cliffMonths: null })
    if (outcome.succeeded) throw new Error('expected rejection')
    expect(outcome.cellErrors.cliffMonths).toBe('Cliff months is required.')
  })
})

describe('isRecordGridCellApplicable', () => {
  it('reads an absent dependency value as null', () => {
    expect(isRecordGridCellApplicable(CLIFF, {})).toBe(false)
    expect(isRecordGridCellApplicable(CLIFF, { vesting: true })).toBe(true)
    expect(isRecordGridCellApplicable(HOLDER, {})).toBe(true)
  })
})

describe('formatRecordGridValue', () => {
  it('formats each kind for display and leaves an absent value empty', () => {
    expect(formatRecordGridValue(PRICE, 1234.5, 'en-US')).toBe('$1,234.50')
    expect(formatRecordGridValue(SHARES, 1000000, 'en-US')).toBe('1,000,000')
    expect(formatRecordGridValue(GRANTED, '2025-02-28', 'en-US')).toBe('Feb 28, 2025')
    expect(formatRecordGridValue(CLASS, 'preferred')).toBe('Preferred')
    expect(formatRecordGridValue(VESTING, true)).toBe('Yes')
    expect(formatRecordGridValue(HOLDER, null)).toBe('')
  })

  it('keeps the raw value in the editor so an untouched cell round-trips', () => {
    expect(recordGridEditorText(PRICE, 1234.5)).toBe('1234.5')
    expect(recordGridEditorText(GRANTED, '2025-02-28')).toBe('2025-02-28')
    expect(recordGridEditorText(HOLDER, null)).toBe('')
  })
})

describe('recordGridRowLabel', () => {
  it('prefers the explicit label, then the first text value, then the id', () => {
    expect(recordGridRowLabel([HOLDER], { id: 'r1', values: { holder: 'Jane' }, label: 'Row one' })).toBe('Row one')
    expect(recordGridRowLabel([SHARES, HOLDER], row('r1', { shares: 5, holder: 'Jane' }))).toBe('Jane')
    expect(recordGridRowLabel([SHARES], row('r1', { shares: 5 }))).toBe('r1')
  })
})

describe('sumRecordGridColumn', () => {
  it('totals the cells that hold a number and skips the ones that do not', () => {
    const rows = [row('a', { shares: 100 }), row('b', { shares: null }), row('c', { shares: 250 })]
    expect(sumRecordGridColumn(rows, 'shares')).toBe(350)
  })
})

describe('optimistic overlay', () => {
  const rows = [row('a', { holder: 'Jane', shares: 100 }), row('b', { holder: 'Sam', shares: 200 })]

  it('projects updates, deletes, and creates over the caller rows', () => {
    let overlay = withRecordGridUpdate(EMPTY_RECORD_GRID_OVERLAY, 'a', 'shares', 150)
    overlay = withRecordGridRemoved(overlay, 'b')
    overlay = withRecordGridCreated(overlay, row('draft-1', { holder: 'New', shares: 5 }))
    const projected = projectRecordGridRows(rows, overlay)
    expect(projected.map((entry) => entry.id)).toEqual(['a', 'draft-1'])
    expect(projected[0]?.values.shares).toBe(150)
    expect(projected[0]?.values.holder).toBe('Jane')
  })

  it('rolls each optimistic change back to the caller rows', () => {
    const updated = withRecordGridUpdate(EMPTY_RECORD_GRID_OVERLAY, 'a', 'shares', 150)
    expect(projectRecordGridRows(rows, withoutRecordGridUpdate(updated, 'a', 'shares'))[0]?.values.shares).toBe(100)

    const removed = withRecordGridRemoved(EMPTY_RECORD_GRID_OVERLAY, 'b')
    expect(projectRecordGridRows(rows, withoutRecordGridRemoved(removed, 'b')).map((entry) => entry.id)).toEqual(['a', 'b'])

    const created = withRecordGridCreated(EMPTY_RECORD_GRID_OVERLAY, row('draft-1', { holder: 'New' }))
    expect(projectRecordGridRows(rows, withoutRecordGridCreated(created, 'draft-1')).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('adopts the server row a create returned in place of the draft', () => {
    const created = withRecordGridCreated(EMPTY_RECORD_GRID_OVERLAY, row('draft-1', { holder: 'New', shares: 5 }))
    const settled = withRecordGridServerRow(created, 'draft-1', row('srv-9', { holder: 'New', shares: 5 }))
    expect(projectRecordGridRows(rows, settled).map((entry) => entry.id)).toEqual(['a', 'b', 'srv-9'])
  })

  it('adopts the server row an update returned over the optimistic cells', () => {
    const updated = withRecordGridUpdate(EMPTY_RECORD_GRID_OVERLAY, 'a', 'shares', 150)
    const settled = withRecordGridServerRow(updated, 'a', row('a', { holder: 'Jane R.', shares: 150 }))
    expect(projectRecordGridRows(rows, settled)[0]?.values.holder).toBe('Jane R.')
  })

  it('prunes only what the caller rows have caught up with, and is identity-stable otherwise', () => {
    const overlay = withRecordGridUpdate(EMPTY_RECORD_GRID_OVERLAY, 'a', 'shares', 150)
    expect(pruneRecordGridOverlay(rows, overlay)).toBe(overlay)

    const refreshed = [row('a', { holder: 'Jane', shares: 150 }), rows[1] as RecordGridRow]
    expect(pruneRecordGridOverlay(refreshed, overlay).updates).toEqual({})
  })

  it('drops a settled create and a settled delete once the caller rows agree', () => {
    let overlay = withRecordGridCreated(EMPTY_RECORD_GRID_OVERLAY, row('srv-9', { holder: 'New' }))
    overlay = withRecordGridRemoved(overlay, 'b')
    const refreshed = [rows[0] as RecordGridRow, row('srv-9', { holder: 'New' })]
    const pruned = pruneRecordGridOverlay(refreshed, overlay)
    expect(pruned.created).toEqual([])
    expect(pruned.removed).toEqual([])
    expect(projectRecordGridRows(refreshed, pruned).map((entry) => entry.id)).toEqual(['a', 'srv-9'])
  })

  it('keeps an unsettled edit so a refresh cannot flash the stale value back', () => {
    const overlay = withRecordGridUpdate(EMPTY_RECORD_GRID_OVERLAY, 'a', 'shares', 150)
    const refreshed = [row('a', { holder: 'Jane', shares: 100 }), rows[1] as RecordGridRow]
    expect(projectRecordGridRows(refreshed, pruneRecordGridOverlay(refreshed, overlay))[0]?.values.shares).toBe(150)
  })

  it('renders an edit to a locally-created row, and prune does not throw it away', () => {
    // A draft is not in the caller's `rows`, so both the projection and the
    // prune have to know it is on screen. Otherwise the user's second keystroke
    // vanishes from the grid while the write goes to the server.
    let overlay = withRecordGridCreated(EMPTY_RECORD_GRID_OVERLAY, row('draft-1', { holder: 'New', shares: 5 }))
    overlay = withRecordGridUpdate(overlay, 'draft-1', 'shares', 42)

    const draft = projectRecordGridRows(rows, overlay).find((entry) => entry.id === 'draft-1')
    expect(draft?.values.shares).toBe(42)
    expect(draft?.values.holder).toBe('New')

    const pruned = pruneRecordGridOverlay(rows, overlay)
    expect(pruned.updates['draft-1']).toEqual({ shares: 42 })
    expect(projectRecordGridRows(rows, pruned).find((entry) => entry.id === 'draft-1')?.values.shares).toBe(42)
  })

  it('lets the server row a create returned win over the draft edits it replaces', () => {
    let overlay = withRecordGridCreated(EMPTY_RECORD_GRID_OVERLAY, row('draft-1', { holder: 'New', shares: 5 }))
    overlay = withRecordGridUpdate(overlay, 'draft-1', 'shares', 42)
    const settled = withRecordGridServerRow(overlay, 'draft-1', row('srv-9', { holder: 'New', shares: 40 }))
    expect(settled.updates).toEqual({})
    expect(projectRecordGridRows(rows, settled).find((entry) => entry.id === 'srv-9')?.values.shares).toBe(40)
  })

  it('takes a rolled-back create out with its cell edits', () => {
    let overlay = withRecordGridCreated(EMPTY_RECORD_GRID_OVERLAY, row('draft-1', { holder: 'New', shares: 5 }))
    overlay = withRecordGridUpdate(overlay, 'draft-1', 'shares', 42)
    const rolledBack = withoutRecordGridCreated(overlay, 'draft-1')
    expect(rolledBack.updates).toEqual({})
    expect(projectRecordGridRows(rows, rolledBack).map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('diffRecordGridProposal', () => {
  const rows = [
    row('a', { holder: 'Jane', shares: 100 }),
    row('b', { holder: 'Sam', shares: 200 }),
    row('c', { holder: 'Pat', shares: 300 }),
  ]

  it('diffs only the cells that actually change, in live-row order', () => {
    const diffs = diffRecordGridProposal(rows, {
      updates: {
        b: { shares: 250, holder: 'Sam' }, // holder restates the live value — not a change
        a: { shares: 125 },
      },
    })
    expect(diffs.map((diff) => [diff.rowId, diff.kind])).toEqual([
      ['a', 'changed'],
      ['b', 'changed'],
    ])
    expect(diffs[0]?.cells).toEqual([{ columnId: 'shares', before: 100, after: 125 }])
    expect(diffs[1]?.cells).toEqual([{ columnId: 'shares', before: 200, after: 250 }])
  })

  it('treats an absent key and an explicit null as the same value, never as a change', () => {
    const withMissing = [row('a', { holder: 'Jane' })]
    expect(diffRecordGridProposal(withMissing, { updates: { a: { shares: null } } })).toEqual([])
  })

  it('marks removals and keeps them out of the changed list when both name the row', () => {
    const diffs = diffRecordGridProposal(rows, {
      updates: { c: { shares: 350 } },
      removals: ['c'],
    })
    expect(diffs).toHaveLength(1)
    expect(diffs[0]?.kind).toBe('removed')
    expect(diffs[0]?.row.id).toBe('c')
    expect(diffs[0]?.cells).toEqual([])
  })

  it('appends additions after the row diffs, ignoring an addition that re-uses a live id', () => {
    const diffs = diffRecordGridProposal(rows, {
      updates: { a: { shares: 125 } },
      additions: [row('a', { holder: 'Duplicate' }), row('d', { holder: 'New', shares: 50 })],
    })
    expect(diffs.map((diff) => [diff.rowId, diff.kind])).toEqual([
      ['a', 'changed'],
      ['d', 'added'],
    ])
  })

  it('ignores updates and removals that name no live row', () => {
    expect(
      diffRecordGridProposal(rows, { updates: { ghost: { shares: 1 } }, removals: ['ghost'] }),
    ).toEqual([])
  })

  it('diffs to nothing for an empty proposal, so there is nothing to review', () => {
    expect(diffRecordGridProposal(rows, {})).toEqual([])
    expect(diffRecordGridProposal(rows, { updates: {}, additions: [], removals: [] })).toEqual([])
  })
})
