import type { RecordGridRowDiff } from './record-grid-model'

interface ReviewActionsProps {
  rowId: string
  kind: RecordGridRowDiff['kind']
  rowLabel: string
  onAccept?: (rowId: string) => void
  onReject?: (rowId: string) => void
}

/** Per-row accept/reject in review mode. The verbs name what accepting DOES:
 *  a changed row is written, an added row is adopted, a removed row is
 *  deleted. */
export function ReviewActions({ rowId, kind, rowLabel, onAccept, onReject }: ReviewActionsProps) {
  const noun = kind === 'changed' ? `proposed change to ${rowLabel}` : kind === 'added' ? `new row ${rowLabel}` : `removal of ${rowLabel}`
  return (
    <span className="inline-flex items-center gap-1.5">
      {onReject && (
        <button
          type="button"
          aria-label={`Reject ${noun}`}
          onClick={() => onReject(rowId)}
          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-accent"
        >
          Reject
        </button>
      )}
      {onAccept && (
        <button
          type="button"
          aria-label={`Accept ${noun}`}
          onClick={() => onAccept(rowId)}
          className="rounded-md bg-success/10 px-2 py-1 text-xs font-medium text-success transition hover:bg-success/20"
        >
          Accept
        </button>
      )}
    </span>
  )
}
