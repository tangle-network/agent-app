/** Host data and mutation contracts for the editable record table. */
import type { ReactNode } from 'react'
import type { AsyncEmptySpec, AsyncResourceState } from './async'
import type { RecordGridColumn, RecordGridProposal, RecordGridRow, RecordGridValue } from './record-grid-model'

export interface RecordGridCellChange {
  /** The row as it was BEFORE the edit — what rollback restores. */
  row: RecordGridRow
  columnId: string
  value: RecordGridValue
  /** The full value bag after the edit: what a whole-row write would send. */
  values: Readonly<Record<string, RecordGridValue>>
}

/** Outcome of an update or a delete. `value` optionally carries the server's
 *  canonical row, which replaces the optimistic one. */
export type RecordGridWriteOutcome =
  | { succeeded: true; value?: RecordGridRow }
  | { succeeded: false; error: string }

/** Outcome of a create. The row is REQUIRED on success: a create that does not
 *  name the row it wrote leaves the grid unable to address it. */
export type RecordGridCreateOutcome =
  | { succeeded: true; value: RecordGridRow }
  | { succeeded: false; error: string }

/** Properties for the editable, provenance-aware record grid. */
export interface RecordGridProps {
  /** Column definitions, in render order. */
  columns: readonly RecordGridColumn[]
  /** Fetch state over the caller's rows — `web-react/async`'s
   *  `AsyncResourceState`, the same three-state contract every other screen
   *  in the shell fetches through. `ready`/`empty`'s value is the base rows;
   *  optimistic edits are layered over it and dropped as a later value
   *  catches up. `error` always carries `retry` — there is no way to render a
   *  failed fetch with no recovery action, by construction. */
  state: AsyncResourceState<readonly RecordGridRow[]>
  /** Accessible name for the grid. Required — an unnamed grid is unusable with
   *  a screen reader. */
  caption: string
  /** What the empty state says, and what it offers next — `web-react/async`'s
   *  `AsyncEmptySpec`, so an empty grid reads in the same words as an empty
   *  list or panel elsewhere in the product. */
  empty: AsyncEmptySpec
  /** Persist one created row. Absent → no add affordance. */
  onCreate?: (values: Readonly<Record<string, RecordGridValue>>) => Promise<RecordGridCreateOutcome>
  /** Persist one cell edit. Absent → every cell renders read-only. */
  onUpdate?: (change: RecordGridCellChange) => Promise<RecordGridWriteOutcome>
  /** Delete one row. Absent → no delete affordance. */
  onDelete?: (row: RecordGridRow) => Promise<RecordGridWriteOutcome>
  /** A proposed change set to review against the live rows (see
   *  `diffRecordGridProposal`). While a non-empty diff is on the table the grid
   *  is a REVIEW surface, not an editor: cell editing, row add, and row delete
   *  are inert; changed cells render the struck live value against the
   *  proposed one; added/removed rows are marked; each diffed row carries
   *  accept/reject controls. A proposal that diffs to nothing renders the grid
   *  unchanged — there is nothing to review. */
  proposed?: RecordGridProposal
  /** Accept one diffed row — write its proposed values, adopt the addition, or
   *  confirm the removal. The caller owns what accepting MEANS (a record-store
   *  review write); the grid reports the decision and the caller moves the row
   *  out of `proposed`. */
  onAcceptRow?: (rowId: string) => void
  /** Reject one diffed row — the live row stands. */
  onRejectRow?: (rowId: string) => void
  /** Accept every remaining diffed row at once. */
  onAcceptAll?: () => void
  /** Reject every remaining diffed row at once. */
  onRejectAll?: () => void
  /** Starting values for the add form. */
  newRowDefaults?: Readonly<Record<string, RecordGridValue>>
  /** Label of the add control and of the add form. Defaults to `Add row`. */
  addLabel?: string
  /** BCP-47 locale for number, currency, and date display. */
  locale?: string
  /** Rendered above the grid — filters, counts, a product action row. */
  toolbar?: ReactNode
  /** Skeleton rows in the loading state. Defaults to 3. */
  loadingRowCount?: number
  className?: string
}
