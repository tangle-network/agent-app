/** Typed cell editors and the inline record creation form. */
import { useMemo, type KeyboardEvent } from 'react'
import { isRecordGridCellApplicable, readRecordGridCell, type RecordGridColumn, type RecordGridValue } from './record-grid-model'

const INPUT_CLASS =
  'w-full rounded-md border border-strong bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/40'

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
export function CellEditor({ column, rowLabel, text, invalid, describedBy, onText, onCommit, onCancel }: CellEditorProps) {
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
export function AddRecordForm({
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
