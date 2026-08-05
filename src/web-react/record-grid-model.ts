/**
 * The pure half of the editable record grid: the typed column vocabulary, the
 * per-cell parse/validate rules, display + editor formatting, and the
 * optimistic overlay a caller's rows are projected through.
 *
 * Zero React, zero DOM — a product can validate a row on a worker before it
 * ever reaches storage, and the component in `./record-grid` renders exactly
 * what these functions decide.
 *
 * Every domain word is a caller parameter: the module knows no column names,
 * no currencies, no option sets. What it owns is the mechanism four verticals
 * each re-derived — typed cells, an error a person can act on, and an
 * optimistic edit that can be taken back.
 */

import type { ProvenanceBasis } from './provenance-model'

/** The value one cell can hold. `null` is "no value on file". */
export type RecordGridValue = string | number | boolean | null

/** Typed outcome for one cell. Callers MUST inspect `succeeded` before reading
 *  `value`; nothing here throws. */
export type RecordGridCellOutcome =
  | { succeeded: true; value: RecordGridValue }
  | { succeeded: false; error: string }

/** Typed outcome for a whole row of inputs (the add form). `cellErrors` is
 *  keyed by column id so each control can render its own message. */
export type RecordGridRowOutcome =
  | { succeeded: true; value: Record<string, RecordGridValue> }
  | { succeeded: false; error: string; cellErrors: Readonly<Record<string, string>> }

/** Build a cell success outcome. */
export function recordGridOk(value: RecordGridValue): RecordGridCellOutcome {
  return { succeeded: true, value }
}

/** Build a cell failure outcome carrying the message shown next to the cell. */
export function recordGridFail(error: string): RecordGridCellOutcome {
  return { succeeded: false, error }
}

/**
 * How a value came to sit in a cell. Rendered as the provenance tone.
 *
 * A type alias of `./provenance-model`'s `ProvenanceBasis`, not a lookalike:
 * two vocabularies for the same concept — a grid cell's origin — shipped one
 * day apart and would have drifted the moment either one added a value. The
 * grid gains `asserted` for free (a cell an agent claimed with nothing behind
 * it), where the caller previously had no way to say that.
 */
export type RecordGridSourceBasis = ProvenanceBasis

/**
 * Where one cell's value came from. Optional on every row — a grid over data
 * with no lineage renders identically without it.
 */
export interface RecordGridCellSource {
  /** The text in the source that supports this value. */
  quote?: string
  /** Human name of the source document, message, or system. */
  label?: string
  /** Click-through to the source. */
  href?: string
  /** Position inside the source: a page, a line, a span — the caller's words. */
  locator?: string
  /** How the value got here. Absent renders as `asserted` — the weakest claim
   *  in the union — because a caller that stated no basis has established
   *  nothing about a document, and an omission must never read as one. */
  basis?: RecordGridSourceBasis
}

/** One option of a `select` column. */
export interface RecordGridSelectOption {
  value: string
  label: string
}

/** A cell is only editable, rendered, and validated when the column it depends
 *  on holds `equals`. This is how a nested sub-form (a vesting schedule behind
 *  a "has vesting" toggle) stays a set of flat, individually-typed columns. */
export interface RecordGridDependency {
  column: string
  equals: RecordGridValue
}

/** Fields every column kind carries. */
export interface RecordGridColumnBase {
  /** Key into a row's `values` bag. */
  id: string
  /** Column heading, and the accessible name of every control in the column. */
  header: string
  /** Short hint rendered under the control in the add form. */
  hint?: string
  /** An empty cell is rejected. */
  required?: boolean
  /** Cells are editable unless this is `false`. */
  editable?: boolean
  /** Cell alignment. Numeric kinds default to `right`. */
  align?: 'left' | 'right'
  /** Groups this column under a labelled sub-form in the add form. */
  group?: string
  /** Only applicable when another column holds a given value. */
  dependsOn?: RecordGridDependency
  /** Extra rule, run after the kind's own checks pass. Return the message to
   *  reject with, or `null` to accept. */
  validate?: (value: RecordGridValue) => string | null
  /** Column summary rendered in the footer row. */
  footerValue?: (rows: readonly RecordGridRow[]) => RecordGridValue
}

/** Free text, optionally length- or pattern-constrained. */
export interface RecordGridTextColumn extends RecordGridColumnBase {
  kind: 'text'
  minLength?: number
  maxLength?: number
  pattern?: RegExp
  /** Message when `pattern` rejects. Without it the pattern source is shown. */
  patternMessage?: string
  /** Render a textarea instead of a single-line input. */
  multiline?: boolean
}

/** A plain number. */
export interface RecordGridNumberColumn extends RecordGridColumnBase {
  kind: 'number'
  min?: number
  max?: number
  integer?: boolean
  /** Passed through to the editor's `step`. */
  step?: number
}

/** A money amount. The currency is a caller parameter — this module bakes no
 *  domain value, so a product with two currencies declares two columns. */
export interface RecordGridCurrencyColumn extends RecordGridColumnBase {
  kind: 'currency'
  /** ISO 4217 code, e.g. `USD`. */
  currency: string
  min?: number
  max?: number
  /** Fraction digits for display. Defaults to the currency's own. */
  fractionDigits?: number
}

/** A calendar date held as `YYYY-MM-DD`; no time, no zone. */
export interface RecordGridDateColumn extends RecordGridColumnBase {
  kind: 'date'
  /** Earliest accepted date, `YYYY-MM-DD`. */
  min?: string
  /** Latest accepted date, `YYYY-MM-DD`. */
  max?: string
}

/** One of a closed set of values. */
export interface RecordGridSelectColumn extends RecordGridColumnBase {
  kind: 'select'
  options: readonly RecordGridSelectOption[]
}

/** A checkbox. */
export interface RecordGridBooleanColumn extends RecordGridColumnBase {
  kind: 'boolean'
  /** Label for `true`. Defaults to `Yes`. */
  trueLabel?: string
  /** Label for `false`. Defaults to `No`. */
  falseLabel?: string
}

/** Every column shape the grid renders. */
export type RecordGridColumn =
  | RecordGridTextColumn
  | RecordGridNumberColumn
  | RecordGridCurrencyColumn
  | RecordGridDateColumn
  | RecordGridSelectColumn
  | RecordGridBooleanColumn

/** One row: an id, a flat value bag keyed by column id, and optional per-cell
 *  provenance. A record-backed product maps its fold output straight onto
 *  this — one entry per cell, its quote and link in `sources`. */
export interface RecordGridRow {
  id: string
  values: Readonly<Record<string, RecordGridValue>>
  /** Per-cell provenance, keyed by column id. */
  sources?: Readonly<Record<string, RecordGridCellSource>>
  /** No cell in this row may be edited or deleted. */
  readOnly?: boolean
  /** Accessible name for the row's own controls. Falls back to the first text
   *  or select column's value, then the row id. */
  label?: string
}

/** True when the column's dependency (if any) is satisfied by the row's other
 *  values. An inapplicable cell is never required, never validated, and never
 *  editable. */
export function isRecordGridCellApplicable(
  column: RecordGridColumn,
  values: Readonly<Record<string, RecordGridValue>>,
): boolean {
  const dependency = column.dependsOn
  if (!dependency) return true
  const held = values[dependency.column] ?? null
  return sameRecordGridValue(held, dependency.equals)
}

/** Value equality across the grid's value union, treating `undefined` as
 *  `null` so an absent key and an explicit null never read as a change. */
export function sameRecordGridValue(a: RecordGridValue | undefined, b: RecordGridValue | undefined): boolean {
  return Object.is(a ?? null, b ?? null)
}

// ── parsing ───────────────────────────────────────────────────────────────

const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A number as a person types it: grouping separators, a leading currency
 * symbol, and accounting parentheses for a negative are all accepted. Anything
 * else is rejected rather than coerced — `12abc` is a typo to correct, not the
 * number 12.
 */
function parseNumericText(raw: string): { empty: true } | { value: number } | { invalid: true } {
  const trimmed = raw.trim()
  if (trimmed === '') return { empty: true }
  const parenthesized = /^\(.+\)$/.test(trimmed)
  const body = (parenthesized ? trimmed.slice(1, -1).trim() : trimmed)
    .replace(/[\s,]/g, '')
    .replace(/^([+-]?)\p{Sc}/u, '$1')
  if (!NUMERIC.test(body)) return { invalid: true }
  const parsed = Number(body)
  if (!Number.isFinite(parsed)) return { invalid: true }
  return { value: parenthesized ? -parsed : parsed }
}

/** True when `text` is a real calendar date in `YYYY-MM-DD`. */
function isCalendarDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false
  const [year, month, day] = text.split('-').map((part) => Number(part))
  if (month === undefined || day === undefined || year === undefined) return false
  if (month < 1 || month > 12 || day < 1) return false
  const stamp = Date.UTC(year, month - 1, day)
  const date = new Date(stamp)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * Turn what an editor control produced into a typed value. Syntax only —
 * range, length, and membership are {@link validateRecordGridCell}'s job.
 */
export function parseRecordGridInput(column: RecordGridColumn, raw: string): RecordGridCellOutcome {
  switch (column.kind) {
    case 'text': {
      const trimmed = raw.trim()
      return recordGridOk(trimmed === '' ? null : trimmed)
    }
    case 'select': {
      const trimmed = raw.trim()
      return recordGridOk(trimmed === '' ? null : trimmed)
    }
    case 'boolean': {
      const trimmed = raw.trim().toLowerCase()
      if (trimmed === '') return recordGridOk(null)
      if (trimmed === 'true') return recordGridOk(true)
      if (trimmed === 'false') return recordGridOk(false)
      return recordGridFail(`${column.header} must be true or false — got “${raw}”.`)
    }
    case 'date': {
      const trimmed = raw.trim()
      if (trimmed === '') return recordGridOk(null)
      if (!isCalendarDate(trimmed)) {
        return recordGridFail(`${column.header} must be a date in YYYY-MM-DD form — got “${raw}”.`)
      }
      return recordGridOk(trimmed)
    }
    case 'number':
    case 'currency': {
      const parsed = parseNumericText(raw)
      if ('empty' in parsed) return recordGridOk(null)
      if ('invalid' in parsed) return recordGridFail(`${column.header} must be a number — got “${raw}”.`)
      return recordGridOk(parsed.value)
    }
  }
}

// ── validation ────────────────────────────────────────────────────────────

function describeOptions(column: RecordGridSelectColumn): string {
  return column.options.map((option) => option.label).join(', ')
}

/**
 * Check one already-typed value against its column. Returns the value the grid
 * should store (empty text normalizes to `null`) or the message a person can
 * act on.
 */
export function validateRecordGridCell(column: RecordGridColumn, value: RecordGridValue): RecordGridCellOutcome {
  const normalized = value === '' ? null : value
  if (normalized === null) {
    if (column.required) return recordGridFail(`${column.header} is required.`)
    const custom = column.validate?.(null)
    return custom === undefined || custom === null ? recordGridOk(null) : recordGridFail(custom)
  }

  switch (column.kind) {
    case 'text': {
      if (typeof normalized !== 'string') return recordGridFail(`${column.header} must be text.`)
      if (column.minLength !== undefined && normalized.length < column.minLength) {
        return recordGridFail(`${column.header} must be at least ${column.minLength} characters — got ${normalized.length}.`)
      }
      if (column.maxLength !== undefined && normalized.length > column.maxLength) {
        return recordGridFail(`${column.header} must be at most ${column.maxLength} characters — got ${normalized.length}.`)
      }
      if (column.pattern && !column.pattern.test(normalized)) {
        return recordGridFail(column.patternMessage ?? `${column.header} does not match ${column.pattern.source}.`)
      }
      break
    }
    case 'number':
    case 'currency': {
      if (typeof normalized !== 'number' || !Number.isFinite(normalized)) {
        return recordGridFail(`${column.header} must be a number.`)
      }
      if (column.kind === 'number' && column.integer === true && !Number.isInteger(normalized)) {
        return recordGridFail(`${column.header} must be a whole number — got ${normalized}.`)
      }
      if (column.min !== undefined && normalized < column.min) {
        return recordGridFail(`${column.header} must be at least ${column.min} — got ${normalized}.`)
      }
      if (column.max !== undefined && normalized > column.max) {
        return recordGridFail(`${column.header} must be at most ${column.max} — got ${normalized}.`)
      }
      break
    }
    case 'date': {
      if (typeof normalized !== 'string' || !isCalendarDate(normalized)) {
        return recordGridFail(`${column.header} must be a date in YYYY-MM-DD form.`)
      }
      if (column.min !== undefined && normalized < column.min) {
        return recordGridFail(`${column.header} must be on or after ${column.min} — got ${normalized}.`)
      }
      if (column.max !== undefined && normalized > column.max) {
        return recordGridFail(`${column.header} must be on or before ${column.max} — got ${normalized}.`)
      }
      break
    }
    case 'select': {
      if (typeof normalized !== 'string') return recordGridFail(`${column.header} must be one of: ${describeOptions(column)}.`)
      if (!column.options.some((option) => option.value === normalized)) {
        return recordGridFail(`${column.header} must be one of: ${describeOptions(column)} — got “${normalized}”.`)
      }
      break
    }
    case 'boolean': {
      if (typeof normalized !== 'boolean') return recordGridFail(`${column.header} must be true or false.`)
      break
    }
  }

  const custom = column.validate?.(normalized)
  if (custom !== undefined && custom !== null) return recordGridFail(custom)
  return recordGridOk(normalized)
}

/** Parse editor text and validate it in one step — what a committing cell
 *  editor calls. */
export function readRecordGridCell(column: RecordGridColumn, raw: string): RecordGridCellOutcome {
  const parsed = parseRecordGridInput(column, raw)
  if (!parsed.succeeded) return parsed
  return validateRecordGridCell(column, parsed.value)
}

/**
 * Validate a whole value bag against the columns. Inapplicable cells (an
 * unsatisfied `dependsOn`) are forced to `null` rather than carried, so a
 * sub-form the user turned off cannot smuggle stale values into a write.
 */
export function validateRecordGridRow(
  columns: readonly RecordGridColumn[],
  values: Readonly<Record<string, RecordGridValue>>,
): RecordGridRowOutcome {
  const accepted: Record<string, RecordGridValue> = {}
  const cellErrors: Record<string, string> = {}
  let firstError: string | null = null

  for (const column of columns) {
    if (!isRecordGridCellApplicable(column, values)) {
      accepted[column.id] = null
      continue
    }
    const outcome = validateRecordGridCell(column, values[column.id] ?? null)
    if (outcome.succeeded) {
      accepted[column.id] = outcome.value
      continue
    }
    cellErrors[column.id] = outcome.error
    if (firstError === null) firstError = outcome.error
  }

  if (firstError !== null) {
    const count = Object.keys(cellErrors).length
    const error = count === 1 ? firstError : `${count} fields need attention. ${firstError}`
    return { succeeded: false, error, cellErrors }
  }
  return { succeeded: true, value: accepted }
}

// ── formatting ────────────────────────────────────────────────────────────

/** Display text for a cell. `null` renders as the empty string; the component
 *  decides what a missing value looks like. */
export function formatRecordGridValue(
  column: RecordGridColumn,
  value: RecordGridValue,
  locale?: string,
): string {
  if (value === null || value === '') return ''
  switch (column.kind) {
    case 'currency': {
      if (typeof value !== 'number') return String(value)
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: column.currency,
        ...(column.fractionDigits === undefined
          ? {}
          : { minimumFractionDigits: column.fractionDigits, maximumFractionDigits: column.fractionDigits }),
      }).format(value)
    }
    case 'number': {
      if (typeof value !== 'number') return String(value)
      return new Intl.NumberFormat(locale).format(value)
    }
    case 'date': {
      if (typeof value !== 'string' || !isCalendarDate(value)) return String(value)
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(`${value}T00:00:00Z`),
      )
    }
    case 'select': {
      const option = column.options.find((candidate) => candidate.value === value)
      return option ? option.label : String(value)
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return String(value)
      return value ? (column.trueLabel ?? 'Yes') : (column.falseLabel ?? 'No')
    }
    case 'text':
      return String(value)
  }
}

/** The text an editor control starts with — the raw value, never the formatted
 *  one, so committing an untouched cell is a no-op. */
export function recordGridEditorText(column: RecordGridColumn, value: RecordGridValue): string {
  if (value === null) return ''
  if (column.kind === 'boolean') return value === true ? 'true' : 'false'
  return String(value)
}

/** Accessible name for a row's own controls. */
export function recordGridRowLabel(columns: readonly RecordGridColumn[], row: RecordGridRow): string {
  if (row.label !== undefined && row.label !== '') return row.label
  for (const column of columns) {
    if (column.kind !== 'text' && column.kind !== 'select') continue
    const value = row.values[column.id]
    if (typeof value === 'string' && value !== '') return formatRecordGridValue(column, value)
  }
  return row.id
}

/** Sum a numeric column over the rows that hold a number. Rows with no value
 *  are absent from the sum, not zero — a total over three of five filled cells
 *  is the total of what is on file. */
export function sumRecordGridColumn(rows: readonly RecordGridRow[], columnId: string): number {
  let total = 0
  for (const row of rows) {
    const value = row.values[columnId]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

// ── optimistic overlay ────────────────────────────────────────────────────

/**
 * Edits the grid has applied locally but the caller's `rows` prop has not yet
 * caught up with. Every field is what rollback removes: drop the entry and the
 * caller's own data shows through again.
 */
export interface RecordGridOverlay {
  /** rowId → columnId → optimistic value. */
  updates: Readonly<Record<string, Readonly<Record<string, RecordGridValue>>>>
  /** Rows created locally, in insertion order. */
  created: readonly RecordGridRow[]
  /** Row ids removed locally. */
  removed: readonly string[]
}

/** An overlay holding nothing. */
export const EMPTY_RECORD_GRID_OVERLAY: RecordGridOverlay = { updates: {}, created: [], removed: [] }

/** The rows to render: caller rows minus local deletes, with local cell edits
 *  applied, then locally-created rows. */
export function projectRecordGridRows(
  rows: readonly RecordGridRow[],
  overlay: RecordGridOverlay,
): RecordGridRow[] {
  const removed = new Set(overlay.removed)
  const projected: RecordGridRow[] = []
  for (const row of rows) {
    if (removed.has(row.id)) continue
    const patch = overlay.updates[row.id]
    projected.push(patch === undefined ? row : { ...row, values: { ...row.values, ...patch } })
  }
  for (const row of overlay.created) {
    if (removed.has(row.id)) continue
    // Same treatment as a caller row: a draft the user edited before the
    // server adopted it must render what they typed, not the value the create
    // went out with.
    const patch = overlay.updates[row.id]
    projected.push(patch === undefined ? row : { ...row, values: { ...row.values, ...patch } })
  }
  return projected
}

/** Record one optimistic cell edit. */
export function withRecordGridUpdate(
  overlay: RecordGridOverlay,
  rowId: string,
  columnId: string,
  value: RecordGridValue,
): RecordGridOverlay {
  const rowPatch = { ...(overlay.updates[rowId] ?? {}), [columnId]: value }
  return { ...overlay, updates: { ...overlay.updates, [rowId]: rowPatch } }
}

/** Take back one optimistic cell edit — the rollback path. */
export function withoutRecordGridUpdate(
  overlay: RecordGridOverlay,
  rowId: string,
  columnId: string,
): RecordGridOverlay {
  const rowPatch = overlay.updates[rowId]
  if (rowPatch === undefined || !(columnId in rowPatch)) return overlay
  const nextPatch: Record<string, RecordGridValue> = {}
  for (const [key, value] of Object.entries(rowPatch)) {
    if (key !== columnId) nextPatch[key] = value
  }
  const updates: Record<string, Readonly<Record<string, RecordGridValue>>> = { ...overlay.updates }
  if (Object.keys(nextPatch).length === 0) delete updates[rowId]
  else updates[rowId] = nextPatch
  return { ...overlay, updates }
}

/** Adopt a row the writer returned as canonical: for a locally-created row it
 *  replaces the draft; for an existing row it replaces the optimistic cells.
 *  Either way the draft's pending cell edits go with it — the canonical row IS
 *  the answer, and leaving an edit layered over it is how a grid keeps showing
 *  a value the server normalized away. */
export function withRecordGridServerRow(
  overlay: RecordGridOverlay,
  draftId: string,
  row: RecordGridRow,
): RecordGridOverlay {
  const createdIndex = overlay.created.findIndex((candidate) => candidate.id === draftId)
  if (createdIndex >= 0) {
    const created = [...overlay.created]
    created[createdIndex] = row
    return { ...overlay, created, updates: withoutRowUpdates(overlay.updates, draftId, row.id) }
  }
  return { ...overlay, updates: { ...overlay.updates, [row.id]: { ...row.values } } }
}

/** Drop every pending cell edit recorded against these row ids. */
function withoutRowUpdates(
  updates: RecordGridOverlay['updates'],
  ...rowIds: readonly string[]
): RecordGridOverlay['updates'] {
  const drop = new Set(rowIds)
  const next: Record<string, Readonly<Record<string, RecordGridValue>>> = {}
  let changed = false
  for (const [rowId, patch] of Object.entries(updates)) {
    if (drop.has(rowId)) changed = true
    else next[rowId] = patch
  }
  return changed ? next : updates
}

/** Record an optimistic create. */
export function withRecordGridCreated(overlay: RecordGridOverlay, row: RecordGridRow): RecordGridOverlay {
  return { ...overlay, created: [...overlay.created, row] }
}

/** Take back an optimistic create — the rollback path. Cell edits made against
 *  the draft go with it; the row they applied to no longer exists anywhere. */
export function withoutRecordGridCreated(overlay: RecordGridOverlay, rowId: string): RecordGridOverlay {
  const created = overlay.created.filter((row) => row.id !== rowId)
  if (created.length === overlay.created.length) return overlay
  return { ...overlay, created, updates: withoutRowUpdates(overlay.updates, rowId) }
}

/** Record an optimistic delete. */
export function withRecordGridRemoved(overlay: RecordGridOverlay, rowId: string): RecordGridOverlay {
  if (overlay.removed.includes(rowId)) return overlay
  return { ...overlay, removed: [...overlay.removed, rowId] }
}

/** Take back an optimistic delete — the rollback path. */
export function withoutRecordGridRemoved(overlay: RecordGridOverlay, rowId: string): RecordGridOverlay {
  if (!overlay.removed.includes(rowId)) return overlay
  return { ...overlay, removed: overlay.removed.filter((candidate) => candidate !== rowId) }
}

/**
 * Drop the overlay entries the caller's own rows have caught up with: a cell
 * whose value now matches, a created row now present, a removed row now gone.
 * Without this an overlay would mask every later refresh of the same cell.
 *
 * Returns the SAME overlay object when nothing settled, so a caller can prune
 * on every render without looping.
 */
export function pruneRecordGridOverlay(
  rows: readonly RecordGridRow[],
  overlay: RecordGridOverlay,
): RecordGridOverlay {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const createdIds = new Set(overlay.created.map((row) => row.id))
  let changed = false

  const updates: Record<string, Readonly<Record<string, RecordGridValue>>> = {}
  for (const [rowId, patch] of Object.entries(overlay.updates)) {
    const row = byId.get(rowId)
    if (row === undefined) {
      // A draft the caller's rows have not adopted yet is still on screen, so
      // its edits still have a row to apply to. Anything else left the
      // caller's data entirely and the edit has nothing to apply to.
      if (createdIds.has(rowId)) {
        updates[rowId] = patch
        continue
      }
      changed = true
      continue
    }
    const kept: Record<string, RecordGridValue> = {}
    for (const [columnId, value] of Object.entries(patch)) {
      if (sameRecordGridValue(row.values[columnId], value)) changed = true
      else kept[columnId] = value
    }
    if (Object.keys(kept).length > 0) updates[rowId] = kept
  }

  const created = overlay.created.filter((row) => {
    const settled = byId.has(row.id)
    if (settled) changed = true
    return !settled
  })

  const removed = overlay.removed.filter((rowId) => {
    const settled = !byId.has(rowId)
    if (settled) changed = true
    return !settled
  })

  if (!changed) return overlay
  return { updates, created, removed }
}
