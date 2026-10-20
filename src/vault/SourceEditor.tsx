export function SourceEditor({
  path,
  content,
  saving,
  dirty,
  onChange,
  onSave,
}: {
  path: string
  content: string
  saving: boolean
  dirty: boolean
  onChange: (content: string) => void
  onSave: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <p className="truncate font-mono text-sm text-muted-foreground">{path}</p>
        {/* One save state, as in the rich editor: Save exists only while there is something to save. */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            role="status"
            aria-live="polite"
            className={`rounded-full border px-2.5 py-1 text-sm ${
              dirty
                ? 'border-[var(--surface-warning-border)] bg-[var(--surface-warning-bg)] text-[var(--surface-warning-text)]'
                : 'border-border bg-background text-muted-foreground'
            }`}
          >
            {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
          </span>
          {(dirty || saving) && (
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              title="Save (Ctrl+S)"
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
            >
              Save
            </button>
          )}
        </div>
      </div>
      <textarea
        value={content}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
            event.preventDefault()
            if (dirty && !saving) onSave()
          }
        }}
        spellCheck={false}
        aria-label="Source editor"
        // Full-bleed editor: keep the floor's ring but draw it inside the border
        // box, since an outward ring on a `flex-1` pane child is clipped.
        className="min-h-0 flex-1 resize-none border-0 bg-background p-4 font-mono text-sm leading-6 text-foreground focus-visible:[outline-offset:-2px]"
      />
    </div>
  )
}
