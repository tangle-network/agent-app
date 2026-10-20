/**
 * `RecordGrid` — the editable record table four verticals each hand-rolled: a
 * cap table, two relationship record pages, a content board, and an entities
 * panel. Every copy re-derived the same mechanism and each one lost a
 * different part of it.
 *
 * What this owns:
 *
 *  - **Typed columns with correctable errors.** A cell is text / number /
 *    currency / date / select / boolean (`./record-grid-model`), so a rejected
 *    edit explains itself next to the control instead of storing a coerced
 *    value.
 *  - **Optimistic write with a real rollback.** The edit lands instantly, the
 *    caller's writer returns a typed outcome, and a failure puts the previous
 *    value back AND says why. A grid that keeps a value the server refused is
 *    the defect this replaces.
 *  - **Provenance per cell.** An optional quote + link + basis, so a
 *    record-backed grid shows where a value came from without the product
 *    building a second surface for it.
 *  - **Review of a proposed change set.** Hand the grid a `proposed` patch
 *    (`./record-grid-model`'s `diffRecordGridProposal`) and it becomes the
 *    red/green row-diff surface a tax/legal review needs: changed cells render
 *    the struck live value against the proposed one, added/removed rows are
 *    marked, and every diffed row carries accept/reject — per row and for the
 *    whole set. What accepting MEANS stays the caller's (a record-store review
 *    write); the grid reports decisions, it does not persist them.
 *  - **Three distinct data states, on `web-react/async`'s own contract.**
 *    `state: AsyncResourceState<Row[]>` and `empty: AsyncEmptySpec` are the
 *    same types every other screen fetches through — loading, error-with-
 *    retry and empty are different renders, a failed fetch never looks like
 *    "no data yet", and the empty state carries the CALLER's next action.
 *    The optimistic overlay is layered on top of whichever `ready`/`empty`
 *    value the caller last supplied, so a row created while the caller's own
 *    status is still `empty` renders immediately rather than waiting for a
 *    refetch.
 *  - **Keyboard-navigable, labelled controls.** Arrow keys move between cells,
 *    Enter edits, Escape cancels, and no destructive control is an unlabelled
 *    icon.
 *
 * Presentation is Tailwind against the shared design tokens, with no icon
 * library and no sandbox-ui — the same contract as the rest of `/web-react`.
 */

import {
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'

import { Button, EmptyState, Skeleton, Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell } from '@tangle-network/ui/primitives'

import { type AsyncEmptyAction } from './async'
import {
  EMPTY_RECORD_GRID_OVERLAY,
  diffRecordGridProposal,
  formatRecordGridValue,
  isRecordGridCellApplicable,
  projectRecordGridRows,
  pruneRecordGridOverlay,
  readRecordGridCell,
  recordGridEditorText,
  recordGridRowLabel,
  sameRecordGridValue,
  validateRecordGridRow,
  withRecordGridCreated,
  withRecordGridRemoved,
  withRecordGridServerRow,
  withRecordGridUpdate,
  withoutRecordGridCreated,
  withoutRecordGridRemoved,
  withoutRecordGridUpdate,
  type RecordGridCellDiff,
  type RecordGridColumn,
  type RecordGridOverlay,
  type RecordGridRow,
  type RecordGridValue,
} from './record-grid-model'

export * from './record-grid-model'

/** One committed cell edit, handed to `onUpdate`. */
export type { RecordGridCellChange, RecordGridWriteOutcome, RecordGridCreateOutcome, RecordGridProps } from './record-grid-types'
import type { RecordGridWriteOutcome, RecordGridCreateOutcome, RecordGridProps } from './record-grid-types'
import { ReviewActions } from './record-grid-review-actions'
import { CellEditor, AddRecordForm } from './record-grid-editors'
import { SourceMarker } from './record-grid-source-marker'

/** Stable empty base for `idle`/`loading`/`error` — a fresh `[]` every render
 *  would retrigger the overlay-pruning effect for no reason. */
const EMPTY_RECORD_GRID_ROWS: readonly RecordGridRow[] = []

/** Internal map key. NUL cannot occur in a column or row id a product would
 *  write, and this key never reaches the DOM. */
const CELL_KEY_SEPARATOR = '\u0000'

function cellKey(rowId: string, columnId: string): string {
  return `${rowId}${CELL_KEY_SEPARATOR}${columnId}`
}

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

function clamp(value: number, max: number): number {
  if (value < 0) return 0
  if (value > max) return max
  return value
}

function alignmentClass(column: RecordGridColumn): string {
  const align = column.align ?? (column.kind === 'number' || column.kind === 'currency' ? 'right' : 'left')
  return align === 'right' ? 'text-right' : 'text-left'
}

/**
 * The shared editable record table. A row is a flat value bag keyed by column
 * id, so a record store's fold output maps straight on: one cell per entry,
 * its quote and link in `sources`.
 */
export function RecordGrid({
  columns,
  caption,
  state,
  empty,
  onCreate,
  onUpdate,
  onDelete,
  proposed,
  onAcceptRow,
  onRejectRow,
  onAcceptAll,
  onRejectAll,
  newRowDefaults,
  addLabel = 'Add row',
  locale,
  toolbar,
  loadingRowCount = 3,
  className,
}: RecordGridProps) {
  const fieldPrefix = useId()
  const [overlay, setOverlay] = useState<RecordGridOverlay>(EMPTY_RECORD_GRID_OVERLAY)
  const [editing, setEditingState] = useState<{ rowId: string; columnId: string; text: string } | null>(null)
  const [cellErrors, setCellErrors] = useState<Readonly<Record<string, string>>>({})
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({})
  const [pendingRows, setPendingRows] = useState<Readonly<Record<string, true>>>({})
  const [focus, setFocus] = useState<{ rowId: string; columnId: string } | null>(null)
  const [openSource, setOpenSource] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<Record<string, RecordGridValue>>({ ...(newRowDefaults ?? {}) })
  const [draftErrors, setDraftErrors] = useState<Readonly<Record<string, string>>>({})
  const [draftError, setDraftError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const cellRefs = useRef(new Map<string, HTMLElement | null>())
  const settling = useRef(false)
  const draftCounter = useRef(0)
  // Mirrors `editing` synchronously: a blur that arrives after the editor
  // already closed must not re-commit the value it was holding.
  const editingRef = useRef<{ rowId: string; columnId: string; text: string } | null>(null)

  const setEditing = useCallback((next: { rowId: string; columnId: string; text: string } | null) => {
    editingRef.current = next
    setEditingState(next)
  }, [])

  // `ready` and `empty` are the only variants carrying rows to project; the
  // other three short-circuit below before `visibleRows` is ever read, so an
  // empty base here is inert rather than wrong.
  const callerRows = state.status === 'ready' || state.status === 'empty' ? state.value : EMPTY_RECORD_GRID_ROWS

  // Overlay entries the caller's own rows have caught up with are dropped, so
  // a later refresh of the same cell is never masked by a settled edit.
  useEffect(() => {
    setOverlay((current) => pruneRecordGridOverlay(callerRows, current))
  }, [callerRows])

  const visibleRows = useMemo(() => projectRecordGridRows(callerRows, overlay), [callerRows, overlay])

  // The diff is computed against the rows ON SCREEN, so a struck "before"
  // value is always the value the reader sees the proposal replace.
  const diffs = useMemo(
    () => (proposed === undefined ? null : diffRecordGridProposal(visibleRows, proposed)),
    [proposed, visibleRows],
  )
  const reviewing = diffs !== null && diffs.length > 0
  const diffByRow = useMemo(() => new Map((diffs ?? []).map((diff) => [diff.rowId, diff])), [diffs])
  const diffCellByKey = useMemo(() => {
    const map = new Map<string, RecordGridCellDiff>()
    for (const diff of diffs ?? []) {
      for (const cell of diff.cells) map.set(cellKey(diff.rowId, cell.columnId), cell)
    }
    return map
  }, [diffs])
  const addedRows = useMemo(
    () => (diffs ?? []).filter((diff) => diff.kind === 'added').map((diff) => diff.row),
    [diffs],
  )

  const activeFocus = useMemo(() => {
    if (focus === null) return null
    if (!visibleRows.some((row) => row.id === focus.rowId)) return null
    if (!columns.some((column) => column.id === focus.columnId)) return null
    return focus
  }, [columns, focus, visibleRows])

  const setCellError = useCallback((key: string, message: string | null) => {
    setCellErrors((current) => {
      if (message === null) {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      }
      if (current[key] === message) return current
      return { ...current, [key]: message }
    })
  }, [])

  const setRowError = useCallback((rowId: string, message: string | null) => {
    setRowErrors((current) => {
      if (message === null) {
        if (!(rowId in current)) return current
        const next = { ...current }
        delete next[rowId]
        return next
      }
      return { ...current, [rowId]: message }
    })
  }, [])

  const setRowPending = useCallback((rowId: string, pending: boolean) => {
    setPendingRows((current) => {
      if (pending) return rowId in current ? current : { ...current, [rowId]: true }
      if (!(rowId in current)) return current
      const next = { ...current }
      delete next[rowId]
      return next
    })
  }, [])

  const focusCell = useCallback((rowId: string, columnId: string) => {
    setFocus({ rowId, columnId })
    cellRefs.current.get(cellKey(rowId, columnId))?.focus()
  }, [])

  const beginEdit = useCallback(
    (row: RecordGridRow, column: RecordGridColumn) => {
      // An editor always opens on the STORED value, so the message from a
      // previous rejected attempt must not survive into it.
      setCellError(cellKey(row.id, column.id), null)
      setEditing({
        rowId: row.id,
        columnId: column.id,
        text: recordGridEditorText(column, row.values[column.id] ?? null),
      })
    },
    [setCellError, setEditing],
  )

  /** Apply one cell value optimistically, write it, and on failure put the
   *  previous value back with the reason attached to the row. */
  const applyCellWrite = useCallback(
    async (row: RecordGridRow, column: RecordGridColumn, value: RecordGridValue) => {
      if (!onUpdate) return
      const values = { ...row.values, [column.id]: value }
      setOverlay((current) => withRecordGridUpdate(current, row.id, column.id, value))
      setRowError(row.id, null)
      setRowPending(row.id, true)

      let outcome: RecordGridWriteOutcome
      try {
        outcome = await onUpdate({ row, columnId: column.id, value, values })
      } catch (cause) {
        outcome = { succeeded: false, error: cause instanceof Error ? cause.message : String(cause) }
      }

      setRowPending(row.id, false)
      if (outcome.succeeded) {
        const canonical = outcome.value
        if (canonical) setOverlay((current) => withRecordGridServerRow(current, row.id, canonical))
        return
      }
      setOverlay((current) => withoutRecordGridUpdate(current, row.id, column.id))
      const rejected = formatRecordGridValue(column, value, locale)
      setRowError(
        row.id,
        rejected === ''
          ? `Could not save ${column.header}: ${outcome.error}`
          : `Could not save ${column.header} as ${rejected}: ${outcome.error}`,
      )
    },
    [locale, onUpdate, setRowError, setRowPending],
  )

  const commitEdit = useCallback(
    async (row: RecordGridRow, column: RecordGridColumn, text: string) => {
      const open = editingRef.current
      if (open === null || open.rowId !== row.id || open.columnId !== column.id) return
      if (settling.current) return
      settling.current = true
      try {
        const key = cellKey(row.id, column.id)
        const parsed = readRecordGridCell(column, text)
        if (!parsed.succeeded) {
          // The editor stays open holding the rejected text: the point of a
          // typed cell is that a person can correct it in place.
          setCellError(key, parsed.error)
          setEditing({ rowId: row.id, columnId: column.id, text })
          return
        }
        setCellError(key, null)
        setEditing(null)
        if (sameRecordGridValue(row.values[column.id], parsed.value)) return
        await applyCellWrite(row, column, parsed.value)
      } finally {
        settling.current = false
      }
    },
    [applyCellWrite, setCellError, setEditing],
  )

  const cancelEdit = useCallback(
    (row: RecordGridRow, column: RecordGridColumn) => {
      setCellError(cellKey(row.id, column.id), null)
      setEditing(null)
      focusCell(row.id, column.id)
    },
    [focusCell, setCellError, setEditing],
  )

  const performDelete = useCallback(
    async (row: RecordGridRow) => {
      if (!onDelete) return
      setConfirmDelete(null)
      setRowError(row.id, null)
      setOverlay((current) => withRecordGridRemoved(current, row.id))

      let outcome: RecordGridWriteOutcome
      try {
        outcome = await onDelete(row)
      } catch (cause) {
        outcome = { succeeded: false, error: cause instanceof Error ? cause.message : String(cause) }
      }
      if (outcome.succeeded) return
      setOverlay((current) => withoutRecordGridRemoved(current, row.id))
      setRowError(row.id, `Could not delete ${recordGridRowLabel(columns, row)}: ${outcome.error}`)
    },
    [columns, onDelete, setRowError],
  )

  const resetDraft = useCallback(() => {
    setDraft({ ...(newRowDefaults ?? {}) })
    setDraftErrors({})
    setDraftError(null)
  }, [newRowDefaults])

  const openAdd = useCallback(() => {
    resetDraft()
    setAdding(true)
  }, [resetDraft])

  const submitDraft = useCallback(async () => {
    if (!onCreate) return
    const validated = validateRecordGridRow(columns, draft)
    if (!validated.succeeded) {
      setDraftErrors(validated.cellErrors)
      setDraftError(validated.error)
      return
    }
    setDraftErrors({})
    setDraftError(null)

    draftCounter.current += 1
    const draftId = `${fieldPrefix}-draft-${draftCounter.current}`
    setOverlay((current) => withRecordGridCreated(current, { id: draftId, values: validated.value }))
    setCreating(true)

    let outcome: RecordGridCreateOutcome
    try {
      outcome = await onCreate(validated.value)
    } catch (cause) {
      outcome = { succeeded: false, error: cause instanceof Error ? cause.message : String(cause) }
    }

    setCreating(false)
    if (outcome.succeeded) {
      setOverlay((current) => withRecordGridServerRow(current, draftId, outcome.value))
      setAdding(false)
      resetDraft()
      return
    }
    // The optimistic row goes away and the form keeps what was typed: a
    // rejected create is correctable, never silently lost.
    setOverlay((current) => withoutRecordGridCreated(current, draftId))
    setDraftError(outcome.error)
  }, [columns, draft, fieldPrefix, onCreate, resetDraft])

  const handleGridKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableElement>) => {
      if (editing !== null) return
      const target = event.target as HTMLElement
      const rowId = target.dataset?.recordGridRow
      const columnId = target.dataset?.recordGridColumn
      if (rowId === undefined || columnId === undefined) return
      const rowIndex = visibleRows.findIndex((row) => row.id === rowId)
      const columnIndex = columns.findIndex((column) => column.id === columnId)
      if (rowIndex < 0 || columnIndex < 0) return

      if (event.key === 'Enter') {
        const row = visibleRows[rowIndex]
        const column = columns[columnIndex]
        if (!row || !column) return
        if (reviewing || !onUpdate || column.editable === false || row.readOnly === true) return
        if (column.kind === 'boolean') return
        if (!isRecordGridCellApplicable(column, row.values)) return
        event.preventDefault()
        beginEdit(row, column)
        return
      }
      if (!NAVIGATION_KEYS.has(event.key)) return
      event.preventDefault()

      let nextRow = rowIndex
      let nextColumn = columnIndex
      if (event.key === 'ArrowUp') nextRow = clamp(rowIndex - 1, visibleRows.length - 1)
      if (event.key === 'ArrowDown') nextRow = clamp(rowIndex + 1, visibleRows.length - 1)
      if (event.key === 'ArrowLeft') nextColumn = clamp(columnIndex - 1, columns.length - 1)
      if (event.key === 'ArrowRight') nextColumn = clamp(columnIndex + 1, columns.length - 1)
      if (event.key === 'Home') nextColumn = 0
      if (event.key === 'End') nextColumn = columns.length - 1

      const destinationRow = visibleRows[nextRow]
      const destinationColumn = columns[nextColumn]
      if (!destinationRow || !destinationColumn) return
      focusCell(destinationRow.id, destinationColumn.id)
    },
    [beginEdit, columns, editing, focusCell, onUpdate, reviewing, visibleRows],
  )

  // `idle` and `loading` render the same busy block — from the reader's
  // side, "not started" and "in flight" are the same wait
  // (`web-react/async`'s own rule for the same two variants).
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className={`space-y-3 ${className ?? ''}`}>
        {toolbar}
        <div
          role="status"
          aria-busy="true"
          aria-live="polite"
          className="space-y-2 rounded-xl border border-card-edge bg-card p-4"
        >
          <span className="sr-only">Loading {caption}</span>
          {Array.from({ length: Math.max(1, loadingRowCount) }, (_, index) => (
            <Skeleton key={index} className="h-8" aria-hidden />
          ))}
        </div>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={`space-y-3 ${className ?? ''}`}>
        {toolbar}
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-4">
          <p className="text-sm font-medium text-destructive">{state.message}</p>
          <button
            type="button"
            onClick={state.retry}
            className="mt-3 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/10"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  const addForm =
    adding && onCreate && !reviewing ? (
      <AddRecordForm
        columns={columns}
        draft={draft}
        setDraft={setDraft}
        errors={draftErrors}
        formError={draftError}
        busy={creating}
        label={addLabel}
        fieldPrefix={fieldPrefix}
        onSubmit={() => void submitDraft()}
        onCancel={() => {
          setAdding(false)
          resetDraft()
        }}
      />
    ) : null

  // A review whose only diff is additions has no live rows — the empty state
  // would hide the very rows up for review, so the table renders instead.
  if (visibleRows.length === 0 && !reviewing) {
    return (
      <div className={`space-y-3 ${className ?? ''}`}>
        {toolbar}
        {addForm ?? (
          <EmptyState title={empty.title} description={empty.description} className="rounded-xl border border-dashed border-border"
            action={<div className="flex flex-wrap items-center justify-center gap-2">
              {empty.action && (isValidElement(empty.action) ? empty.action : <Button type="button" variant="outline" size="sm" onClick={(empty.action as AsyncEmptyAction).onClick}>{(empty.action as AsyncEmptyAction).label}</Button>)}
              {onCreate && <Button type="button" variant="outline" size="sm" onClick={openAdd}>{addLabel}</Button>}
            </div>} />
        )}
      </div>
    )
  }

  const hasFooter = columns.some((column) => column.footerValue !== undefined)
  const showActionsColumn = reviewing || onDelete !== undefined
  const columnSpan = columns.length + (showActionsColumn ? 1 : 0)

  const changedCount = (diffs ?? []).filter((diff) => diff.kind === 'changed').length
  const addedCount = addedRows.length
  const removedCount = (diffs ?? []).filter((diff) => diff.kind === 'removed').length
  const changedCellCount = (diffs ?? []).reduce((total, diff) => total + diff.cells.length, 0)
  const reviewSummary = [
    changedCount > 0 ? `${changedCount} changed (${changedCellCount} ${changedCellCount === 1 ? 'cell' : 'cells'})` : null,
    addedCount > 0 ? `${addedCount} added` : null,
    removedCount > 0 ? `${removedCount} removed` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')

  const reviewBar = reviewing ? (
    <div
      data-record-grid-review=""
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-edge bg-card px-4 py-2.5"
    >
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Proposed changes
        </p>
        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{reviewSummary}</p>
      </div>
      {(onAcceptAll || onRejectAll) && (
        <div className="flex items-center gap-2">
          {onRejectAll && (
            <button
              type="button"
              aria-label={`Reject all proposed changes to ${caption}`}
              onClick={onRejectAll}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent"
            >
              Reject all
            </button>
          )}
          {onAcceptAll && (
            <button
              type="button"
              aria-label={`Accept all proposed changes to ${caption}`}
              onClick={onAcceptAll}
              className="rounded-md bg-success/10 px-3 py-1.5 text-xs font-medium text-success transition hover:bg-success/20"
            >
              Accept all
            </button>
          )}
        </div>
      )}
    </div>
  ) : null

  return (
    <div className={`space-y-3 ${className ?? ''}`}>
      {toolbar}
      {reviewBar}
      <div className="overflow-x-auto rounded-xl border border-card-edge bg-card">
        <Table wrapper={false}
          role="grid"
          aria-label={caption}
          className="border-collapse text-left"
          onKeyDown={handleGridKeyDown}
        >
          <TableHeader>
            <TableRow role="row" className="text-xs uppercase tracking-[0.05em] text-muted-foreground">
              {columns.map((column) => (
                <TableHead
                  key={column.id}
                  role="columnheader"
                  scope="col"
                  className={`h-auto px-3 py-2 ${alignmentClass(column)}`}
                >
                  {column.header}
                </TableHead>
              ))}
              {showActionsColumn && (
                <TableHead role="columnheader" scope="col" className="h-auto w-px px-3 py-2">
                  <span className="sr-only">{reviewing ? 'Review' : 'Row actions'}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((row) => {
              const rowLabel = recordGridRowLabel(columns, row)
              const pending = row.id in pendingRows
              const rowError = rowErrors[row.id]
              const rowDiff = reviewing ? diffByRow.get(row.id) : undefined
              const removedRow = rowDiff?.kind === 'removed'
              return (
                <Fragment key={row.id}>
                  <TableRow
                    role="row"
                    aria-busy={pending}
                    data-record-grid-diff={rowDiff?.kind}
                    className={`${pending ? 'opacity-60' : ''} ${removedRow ? 'bg-destructive/[0.06]' : ''}`}
                  >
                    {columns.map((column) => {
                      const key = cellKey(row.id, column.id)
                      const applicable = isRecordGridCellApplicable(column, row.values)
                      const editable =
                        !reviewing &&
                        onUpdate !== undefined &&
                        column.editable !== false &&
                        row.readOnly !== true &&
                        applicable
                      const value = row.values[column.id] ?? null
                      const isEditing = editing?.rowId === row.id && editing.columnId === column.id
                      const cellError = cellErrors[key]
                      const active =
                        activeFocus === null
                          ? row.id === visibleRows[0]?.id && column.id === columns[0]?.id
                          : activeFocus.rowId === row.id && activeFocus.columnId === column.id
                      const source = row.sources?.[column.id]
                      const errorId = `${fieldPrefix}-cell-error-${row.id}-${column.id}`
                      const cellDiff = rowDiff?.kind === 'changed' ? diffCellByKey.get(key) : undefined

                      if (isEditing && editable) {
                        return (
                          <TableCell key={column.id} role="gridcell" className={`px-3 py-1.5 ${alignmentClass(column)}`}>
                            <CellEditor
                              column={column}
                              rowLabel={rowLabel}
                              text={editing.text}
                              invalid={cellError !== undefined}
                              describedBy={cellError === undefined ? undefined : errorId}
                              onText={(text) => setEditing({ rowId: row.id, columnId: column.id, text })}
                              onCommit={(text) => void commitEdit(row, column, text)}
                              onCancel={() => cancelEdit(row, column)}
                            />
                            {cellError !== undefined && (
                              <p id={errorId} role="alert" className="mt-1 text-xs leading-snug text-destructive">
                                {cellError}
                              </p>
                            )}
                          </TableCell>
                        )
                      }

                      if (column.kind === 'boolean' && editable) {
                        return (
                          <TableCell key={column.id} role="gridcell" className={`px-3 py-2 ${alignmentClass(column)}`}>
                            <input
                              type="checkbox"
                              checked={value === true}
                              aria-label={`${column.header}, ${rowLabel}`}
                              data-record-grid-row={row.id}
                              data-record-grid-column={column.id}
                              tabIndex={active ? 0 : -1}
                              ref={(node) => {
                                cellRefs.current.set(key, node)
                              }}
                              onFocus={() => setFocus({ rowId: row.id, columnId: column.id })}
                              onChange={(event) => void applyCellWrite(row, column, event.target.checked)}
                              className="h-4 w-4 rounded border-border accent-primary"
                            />
                          </TableCell>
                        )
                      }

                      const display = applicable ? formatRecordGridValue(column, value, locale) : ''
                      return (
                        <TableCell
                          key={column.id}
                          role="gridcell"
                          aria-readonly={editable ? undefined : true}
                          data-record-grid-row={row.id}
                          data-record-grid-column={column.id}
                          tabIndex={active ? 0 : -1}
                          ref={(node) => {
                            cellRefs.current.set(key, node)
                          }}
                          onFocus={() => setFocus({ rowId: row.id, columnId: column.id })}
                          onClick={() => {
                            if (editable) beginEdit(row, column)
                          }}
                          className={`px-3 py-2 outline-none focus:ring-2 focus:ring-inset focus:ring-primary/50 ${alignmentClass(
                            column,
                          )} ${editable ? 'cursor-text' : ''}`}
                        >
                          <span className="inline-flex max-w-full items-center gap-1.5">
                            {column.id === columns[0]?.id && removedRow && (
                              <span className="inline-flex shrink-0 rounded border border-destructive/60 px-1 py-px text-[11px] font-semibold uppercase tracking-[0.05em] text-destructive">
                                Remove
                              </span>
                            )}
                            {cellDiff ? (
                              <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5">
                                <span className="tabular-nums text-destructive line-through decoration-destructive/60">
                                  {formatRecordGridValue(column, cellDiff.before, locale) || '—'}
                                </span>
                                <span aria-hidden="true" className="text-muted-foreground">
                                  →
                                </span>
                                <span className="tabular-nums font-medium text-success">
                                  {formatRecordGridValue(column, cellDiff.after, locale) || '—'}
                                </span>
                              </span>
                            ) : (
                              <span
                                className={
                                  removedRow
                                    ? 'truncate text-destructive line-through decoration-destructive/60'
                                    : display === ''
                                      ? 'text-muted-foreground'
                                      : 'truncate text-foreground'
                                }
                              >
                                {display === '' ? (applicable ? '—' : 'n/a') : display}
                              </span>
                            )}
                            {source && (
                              <SourceMarker
                                panelId={`${fieldPrefix}-source-${row.id}-${column.id}`}
                                columnHeader={column.header}
                                rowLabel={rowLabel}
                                source={source}
                                open={openSource === key}
                                onToggle={() => setOpenSource((current) => (current === key ? null : key))}
                              />
                            )}
                          </span>
                        </TableCell>
                      )
                    })}
                    {showActionsColumn && (
                      <TableCell role="gridcell" className="px-3 py-2 text-right">
                        {reviewing ? (
                          rowDiff && (
                            <ReviewActions
                              rowId={row.id}
                              kind={rowDiff.kind}
                              rowLabel={rowLabel}
                              onAccept={onAcceptRow}
                              onReject={onRejectRow}
                            />
                          )
                        ) : row.readOnly === true ? null : confirmDelete === row.id ? (
                          <span className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              aria-label={`Confirm delete ${rowLabel}`}
                              onClick={() => void performDelete(row)}
                              className="rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/20"
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              aria-label={`Keep ${rowLabel}`}
                              onClick={() => setConfirmDelete(null)}
                              className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-accent"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            aria-label={`Delete ${rowLabel}`}
                            onClick={() => setConfirmDelete(row.id)}
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              className="h-3.5 w-3.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden
                            >
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                  {rowError !== undefined && (
                    <TableRow role="row" >
                      <TableCell role="gridcell" colSpan={columnSpan} className="px-3 pb-2">
                        <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                          {rowError}
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
            {reviewing &&
              addedRows.map((row) => {
                const rowLabel = recordGridRowLabel(columns, row)
                return (
                  <TableRow
                    key={row.id}
                    role="row"
                    data-record-grid-diff="added"
                    className="bg-success/[0.06]"
                  >
                    {columns.map((column, columnIndex) => {
                      const applicable = isRecordGridCellApplicable(column, row.values)
                      const value = row.values[column.id] ?? null
                      const display = applicable ? formatRecordGridValue(column, value, locale) : ''
                      return (
                        <TableCell key={column.id} role="gridcell" className={`px-3 py-2 ${alignmentClass(column)}`}>
                          <span className="inline-flex max-w-full items-center gap-1.5">
                            {columnIndex === 0 && (
                              <span className="inline-flex shrink-0 rounded border border-success/60 px-1 py-px text-[11px] font-semibold uppercase tracking-[0.05em] text-success">
                                New
                              </span>
                            )}
                            <span
                              className={`tabular-nums ${display === '' ? 'text-muted-foreground' : 'truncate text-foreground'}`}
                            >
                              {display === '' ? (applicable ? '—' : 'n/a') : display}
                            </span>
                          </span>
                        </TableCell>
                      )
                    })}
                    <TableCell role="gridcell" className="px-3 py-2 text-right">
                      <ReviewActions
                        rowId={row.id}
                        kind="added"
                        rowLabel={rowLabel}
                        onAccept={onAcceptRow}
                        onReject={onRejectRow}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
          </TableBody>
          {hasFooter && (
            <TableFooter>
              <TableRow role="row" className="border-t-2 border-border">
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    role="gridcell"
                    className={`px-3 py-2 text-sm font-semibold text-foreground ${alignmentClass(column)}`}
                  >
                    {column.footerValue ? formatRecordGridValue(column, column.footerValue(visibleRows), locale) : ''}
                  </TableCell>
                ))}
                {showActionsColumn && <TableCell role="gridcell" />}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>

      {onCreate &&
        !reviewing &&
        (addForm ?? (
          <button
            type="button"
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {addLabel}
          </button>
        ))}
    </div>
  )
}
