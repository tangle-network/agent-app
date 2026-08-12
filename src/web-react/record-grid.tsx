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
  type ReactNode,
} from 'react'

import { type AsyncEmptyAction, type AsyncEmptySpec, type AsyncResourceState } from './async'
import { OVERLAY_SHADOW, PopoverSurface, usePopover } from './controls'
import {
  EMPTY_RECORD_GRID_OVERLAY,
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
  type RecordGridCellSource,
  type RecordGridColumn,
  type RecordGridOverlay,
  type RecordGridRow,
  type RecordGridSourceBasis,
  type RecordGridValue,
} from './record-grid-model'

export * from './record-grid-model'

/** One committed cell edit, handed to `onUpdate`. */
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

/** Columns bucketed by their `group`, preserving first-appearance order. Each
 *  bucket becomes one labelled sub-form in the add form — how a nested
 *  schedule stays a set of flat, individually-typed columns. */
function groupColumns(
  columns: readonly RecordGridColumn[],
): Array<{ label: string | null; columns: RecordGridColumn[] }> {
  const groups: Array<{ label: string | null; columns: RecordGridColumn[] }> = []
  for (const column of columns) {
    const label = column.group ?? null
    const existing = groups.find((group) => group.label === label)
    if (existing) existing.columns.push(column)
    else groups.push({ label, columns: [column] })
  }
  return groups
}

const INPUT_CLASS =
  'w-full rounded-md border border-strong bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/40'

const BASIS_TONES: Record<RecordGridSourceBasis, string> = {
  extracted: 'border-primary/60 text-primary',
  entered: 'border-success/60 text-success',
  computed: 'border-border text-muted-foreground',
  asserted: 'border-warning/60 text-warning',
}

const BASIS_TITLES: Record<RecordGridSourceBasis, string> = {
  extracted: 'Extracted from a source document',
  entered: 'Confirmed by a person',
  computed: 'Computed from other values',
  asserted: 'Agent, unverified — no source recorded',
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
        if (!onUpdate || column.editable === false || row.readOnly === true) return
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
    [beginEdit, columns, editing, focusCell, onUpdate, visibleRows],
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
            <div key={index} className="h-8 animate-pulse rounded-md bg-secondary" aria-hidden />
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
    adding && onCreate ? (
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

  if (visibleRows.length === 0) {
    return (
      <div className={`space-y-3 ${className ?? ''}`}>
        {toolbar}
        {addForm ?? (
          <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <p className="text-sm font-medium text-foreground">{empty.title}</p>
            {empty.description && (
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{empty.description}</p>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {empty.action &&
                (isValidElement(empty.action) ? (
                  empty.action
                ) : (
                  <button
                    type="button"
                    onClick={(empty.action as AsyncEmptyAction).onClick}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"
                  >
                    {(empty.action as AsyncEmptyAction).label}
                  </button>
                ))}
              {onCreate && (
                <button
                  type="button"
                  onClick={openAdd}
                  className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent"
                >
                  {addLabel}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  const hasFooter = columns.some((column) => column.footerValue !== undefined)
  const columnSpan = columns.length + (onDelete ? 1 : 0)

  return (
    <div className={`space-y-3 ${className ?? ''}`}>
      {toolbar}
      <div className="overflow-x-auto rounded-xl border border-card-edge bg-card">
        <table
          role="grid"
          aria-label={caption}
          className="w-full border-collapse text-left text-sm"
          onKeyDown={handleGridKeyDown}
        >
          <thead>
            <tr role="row" className="border-b border-border text-xs uppercase tracking-[0.05em] text-muted-foreground">
              {columns.map((column) => (
                <th
                  key={column.id}
                  role="columnheader"
                  scope="col"
                  className={`px-3 py-2 font-medium ${alignmentClass(column)}`}
                >
                  {column.header}
                </th>
              ))}
              {onDelete && (
                <th role="columnheader" scope="col" className="w-px px-3 py-2 font-medium">
                  <span className="sr-only">Row actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const rowLabel = recordGridRowLabel(columns, row)
              const pending = row.id in pendingRows
              const rowError = rowErrors[row.id]
              return (
                <Fragment key={row.id}>
                  <tr role="row" aria-busy={pending} className={`border-b border-border ${pending ? 'opacity-60' : ''}`}>
                    {columns.map((column) => {
                      const key = cellKey(row.id, column.id)
                      const applicable = isRecordGridCellApplicable(column, row.values)
                      const editable =
                        onUpdate !== undefined && column.editable !== false && row.readOnly !== true && applicable
                      const value = row.values[column.id] ?? null
                      const isEditing = editing?.rowId === row.id && editing.columnId === column.id
                      const cellError = cellErrors[key]
                      const active =
                        activeFocus === null
                          ? row.id === visibleRows[0]?.id && column.id === columns[0]?.id
                          : activeFocus.rowId === row.id && activeFocus.columnId === column.id
                      const source = row.sources?.[column.id]
                      const errorId = `${fieldPrefix}-cell-error-${row.id}-${column.id}`

                      if (isEditing && editable) {
                        return (
                          <td key={column.id} role="gridcell" className={`px-3 py-1.5 ${alignmentClass(column)}`}>
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
                          </td>
                        )
                      }

                      if (column.kind === 'boolean' && editable) {
                        return (
                          <td key={column.id} role="gridcell" className={`px-3 py-2 ${alignmentClass(column)}`}>
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
                          </td>
                        )
                      }

                      const display = applicable ? formatRecordGridValue(column, value, locale) : ''
                      return (
                        <td
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
                            <span className={display === '' ? 'text-muted-foreground' : 'truncate text-foreground'}>
                              {display === '' ? (applicable ? '—' : 'n/a') : display}
                            </span>
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
                        </td>
                      )
                    })}
                    {onDelete && (
                      <td role="gridcell" className="px-3 py-2 text-right">
                        {row.readOnly === true ? null : confirmDelete === row.id ? (
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
                      </td>
                    )}
                  </tr>
                  {rowError !== undefined && (
                    <tr role="row" className="border-b border-border">
                      <td role="gridcell" colSpan={columnSpan} className="px-3 pb-2">
                        <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                          {rowError}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
          {hasFooter && (
            <tfoot>
              <tr role="row" className="border-t-2 border-border">
                {columns.map((column) => (
                  <td
                    key={column.id}
                    role="gridcell"
                    className={`px-3 py-2 text-sm font-semibold text-foreground ${alignmentClass(column)}`}
                  >
                    {column.footerValue ? formatRecordGridValue(column, column.footerValue(visibleRows), locale) : ''}
                  </td>
                ))}
                {onDelete && <td role="gridcell" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {onCreate &&
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

interface CellEditorProps {
  column: RecordGridColumn
  rowLabel: string
  text: string
  invalid: boolean
  describedBy?: string
  onText: (text: string) => void
  onCommit: (text: string) => void
  onCancel: () => void
}

/** The in-cell control for one edit. Enter commits, Escape cancels, blur
 *  commits — the editor never disappears without deciding. */
function CellEditor({ column, rowLabel, text, invalid, describedBy, onText, onCommit, onCancel }: CellEditorProps) {
  const shared = {
    'aria-label': `${column.header}, ${rowLabel}`,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': describedBy,
    autoFocus: true,
    className: INPUT_CLASS,
  }

  if (column.kind === 'select') {
    return (
      <select
        {...shared}
        value={text}
        onChange={(event) => {
          onText(event.target.value)
          onCommit(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        onBlur={() => onCommit(text)}
      >
        <option value="">—</option>
        {column.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }

  const keyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const multiline = column.kind === 'text' && column.multiline === true
    if (event.key === 'Enter' && !multiline) {
      event.preventDefault()
      onCommit(text)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }

  if (column.kind === 'text' && column.multiline === true) {
    return (
      <textarea
        {...shared}
        rows={3}
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={keyDown}
        onBlur={() => onCommit(text)}
      />
    )
  }

  return (
    <input
      {...shared}
      type={column.kind === 'date' ? 'date' : 'text'}
      inputMode={column.kind === 'number' || column.kind === 'currency' ? 'decimal' : undefined}
      value={text}
      onChange={(event) => onText(event.target.value)}
      onKeyDown={keyDown}
      onBlur={() => onCommit(text)}
    />
  )
}

interface SourceMarkerProps {
  panelId: string
  columnHeader: string
  rowLabel: string
  source: RecordGridCellSource
  open: boolean
  onToggle: () => void
}

/**
 * The per-cell provenance affordance: a marker that opens the quote, the
 * source's name, and a link to it.
 *
 * Renders its panel through `PopoverSurface` (not an in-place `absolute`
 * span): the grid is a scrollable table by construction — `overflow-x-auto`/
 * `overflow-y-auto` on the scroll region is the whole reason `RecordGrid`
 * stays usable with many columns/rows — and that scroll container clips every
 * positioned descendant whose containing block sits inside it exactly the way
 * the composer's control rail clipped the model/thinking menus (see AGENTS.md
 * "UI chrome ownership (picker canon)"). `open` stays parent-owned (only one
 * marker across the grid may be open at a time); `usePopover` never calls
 * `setOpen(true)` itself — its listeners only run while `open` is already
 * true — so translating its `setOpen(false)` into the existing `onToggle`
 * flip is safe.
 */
function SourceMarker({ panelId, columnHeader, rowLabel, source, open, onToggle }: SourceMarkerProps) {
  // An omitted basis is the DEFAULT path every first integration takes, so it
  // must resolve to the weakest claim, not the strongest. `extracted` (and
  // `source` before the rename) told the reader the figure was read out of a
  // document the caller never named — a factual claim about a document that may
  // not exist. `asserted` is the union's own "nothing outside the model behind
  // it", which is exactly what a caller who stated no basis has established.
  const basis: RecordGridSourceBasis = source.basis ?? 'asserted'
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) onToggle()
    },
    [onToggle],
  )
  const { containerRef, triggerRef, panelRef, triggerProps } = usePopover(open, setOpen)
  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        {...triggerProps}
        aria-label={`Source for ${columnHeader}, ${rowLabel}`}
        aria-controls={open ? panelId : undefined}
        title={BASIS_TITLES[basis]}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${BASIS_TONES[basis]}`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-2.5 w-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M9 8h6M9 12h6M9 16h3" />
        </svg>
      </button>
      <PopoverSurface
        open={open}
        id={panelId}
        role="note"
        triggerRef={triggerRef}
        panelRef={panelRef}
        className={`w-64 rounded-lg border border-card-edge bg-popover p-3 text-left ${OVERLAY_SHADOW}`}
      >
        {source.quote && (
          <span className="block border-l-2 border-primary/50 pl-2 text-xs italic leading-snug text-foreground">
            “{source.quote}”
          </span>
        )}
        <span className="mt-2 block text-xs text-muted-foreground">
          {source.label ?? 'Source'}
          {source.locator ? ` · ${source.locator}` : ''}
          {` · ${BASIS_TITLES[basis]}`}
        </span>
        {source.href && (
          <a
            href={source.href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="mt-1.5 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            Open source
          </a>
        )}
      </PopoverSurface>
    </span>
  )
}

interface AddRecordFormProps {
  columns: readonly RecordGridColumn[]
  draft: Record<string, RecordGridValue>
  setDraft: (next: Record<string, RecordGridValue>) => void
  errors: Readonly<Record<string, string>>
  formError: string | null
  busy: boolean
  label: string
  fieldPrefix: string
  onSubmit: () => void
  onCancel: () => void
}

/** The inline add form. Every control is labelled, every rejection names its
 *  field, and a column whose `dependsOn` is unsatisfied is not rendered — the
 *  nested sub-form case. */
function AddRecordForm({
  columns,
  draft,
  setDraft,
  errors,
  formError,
  busy,
  label,
  fieldPrefix,
  onSubmit,
  onCancel,
}: AddRecordFormProps) {
  const groups = useMemo(() => groupColumns(columns), [columns])

  return (
    <form
      noValidate
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      className="space-y-4 rounded-xl border border-card-edge bg-card p-4"
    >
      <h3 className="text-sm font-semibold text-foreground">{label}</h3>
      {formError !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {formError}
        </p>
      )}
      {groups.map((group) => {
        const fields = group.columns.filter((column) => isRecordGridCellApplicable(column, draft))
        if (fields.length === 0) return null
        return (
          <fieldset
            key={group.label ?? '_'}
            className={group.label === null ? 'min-w-0' : 'min-w-0 rounded-lg border border-card-edge p-3'}
          >
            {group.label !== null && (
              <legend className="px-1 text-xs font-medium text-muted-foreground">{group.label}</legend>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((column) => {
                const fieldId = `${fieldPrefix}-${column.id}`
                const errorId = `${fieldId}-error`
                const message = errors[column.id]
                return (
                  <div
                    key={column.id}
                    className={column.kind === 'text' && column.multiline === true ? 'sm:col-span-2' : ''}
                  >
                    <label htmlFor={fieldId} className="mb-1 block text-xs font-medium text-muted-foreground">
                      {column.header}
                      {column.required === true && <span className="ml-0.5 text-destructive">*</span>}
                    </label>
                    <DraftField
                      column={column}
                      id={fieldId}
                      value={draft[column.id] ?? null}
                      invalid={message !== undefined}
                      describedBy={message === undefined ? undefined : errorId}
                      onValue={(next) => setDraft({ ...draft, [column.id]: next })}
                    />
                    {column.hint && <p className="mt-1 text-xs text-muted-foreground">{column.hint}</p>}
                    {message !== undefined && (
                      <p id={errorId} role="alert" className="mt-1 text-xs text-destructive">
                        {message}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </fieldset>
        )
      })}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

interface DraftFieldProps {
  column: RecordGridColumn
  id: string
  value: RecordGridValue
  invalid: boolean
  describedBy?: string
  onValue: (value: RecordGridValue) => void
}

/** One labelled control in the add form. A half-typed number is held verbatim
 *  rather than coerced mid-keystroke; submit is where it is refused with a
 *  reason. */
function DraftField({ column, id, value, invalid, describedBy, onValue }: DraftFieldProps) {
  const shared = {
    id,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': describedBy,
  }

  if (column.kind === 'boolean') {
    return (
      <input
        {...shared}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onValue(event.target.checked)}
        className="h-4 w-4 rounded border-border accent-primary"
      />
    )
  }

  if (column.kind === 'select') {
    return (
      <select
        {...shared}
        className={INPUT_CLASS}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onValue(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">—</option>
        {column.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }

  if (column.kind === 'text' && column.multiline === true) {
    return (
      <textarea
        {...shared}
        className={INPUT_CLASS}
        rows={3}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onValue(event.target.value === '' ? null : event.target.value)}
      />
    )
  }

  if (column.kind === 'number' || column.kind === 'currency') {
    return (
      <input
        {...shared}
        className={INPUT_CLASS}
        type="text"
        inputMode="decimal"
        value={value === null ? '' : String(value)}
        onChange={(event) => {
          const raw = event.target.value
          if (raw.trim() === '') {
            onValue(null)
            return
          }
          const parsed = readRecordGridCell(column, raw)
          onValue(parsed.succeeded ? parsed.value : raw)
        }}
      />
    )
  }

  return (
    <input
      {...shared}
      className={INPUT_CLASS}
      type={column.kind === 'date' ? 'date' : 'text'}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => onValue(event.target.value === '' ? null : event.target.value)}
    />
  )
}
