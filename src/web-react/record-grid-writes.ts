import { formatRecordGridValue, recordGridRowLabel, validateRecordGridRow, withRecordGridCreated,
  withRecordGridRemoved, withRecordGridServerRow, withRecordGridUpdate, withoutRecordGridCreated,
  withoutRecordGridRemoved, withoutRecordGridUpdate, type RecordGridColumn, type RecordGridOverlay,
  type RecordGridRow, type RecordGridValue } from './record-grid-model'
import type { RecordGridWriteOutcome, RecordGridCreateOutcome, RecordGridProps } from './record-grid-types'
export async function writeRecordGridCell(row: RecordGridRow, column: RecordGridColumn,
  value: RecordGridValue, { onUpdate, setOverlay, setRowError, setRowPending,
  locale }: { onUpdate: RecordGridProps['onUpdate'];
  setOverlay: (value: RecordGridOverlay | ((current: RecordGridOverlay) => RecordGridOverlay)) => void;
  setRowError: (rowId: string, error: string | null) => void; setRowPending: (rowId: string,
  pending: boolean) => void; locale: RecordGridProps['locale'] }) {
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
    }

export async function deleteRecordGridRow(row: RecordGridRow, { onDelete, setConfirmDelete,
  setRowError, setOverlay, columns }: { onDelete: RecordGridProps['onDelete'];
  setConfirmDelete: (id: string | null) => void; setRowError: (rowId: string,
  error: string | null) => void;
  setOverlay: (value: RecordGridOverlay | ((current: RecordGridOverlay) => RecordGridOverlay)) => void; columns: RecordGridProps['columns'] }) {
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
    }

export async function createRecordGridRow({ onCreate, columns, draft, setDraftErrors,
  setDraftError, draftCounter, fieldPrefix, setOverlay, setCreating, setAdding,
  resetDraft }: { onCreate: RecordGridProps['onCreate']; columns: RecordGridProps['columns'];
  draft: Record<string, RecordGridValue>; setDraftErrors: (errors: Readonly<Record<string,
  string>>) => void; setDraftError: (error: string | null) => void;
  draftCounter: { current: number }; fieldPrefix: string;
  setOverlay: (value: RecordGridOverlay | ((current: RecordGridOverlay) => RecordGridOverlay)) => void;
  setCreating: (value: boolean) => void; setAdding: (value: boolean) => void; resetDraft: () => void }) {
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
  }
