/**
 * A text field with a suggestion list: type to filter, arrow keys to move,
 * Enter to choose. The person may also keep what they typed, so a value the
 * suggestions do not contain (a repository the listing missed, a path in a
 * truncated tree) is still enterable. The list renders through
 * `PopoverSurface`, so a scrolling side panel cannot clip it.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Input } from '@tangle-network/sandbox-ui/primitives'
import { OVERLAY_SHADOW, PopoverSurface, POPOVER_OPTION_FOCUS } from './controls'
import { noAutofill } from './agent-profile-form-kit'

export interface Suggestion {
  value: string
  label: ReactNode
  detail?: ReactNode
}

export interface SuggestInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  /** Called when the person chooses a suggestion, presses Enter, or leaves the field with a changed value. */
  onCommit: (value: string) => void
  suggestions: readonly Suggestion[]
  /** Shown in the list while suggestions load. */
  loading?: boolean
  /** Shown when the list is open but nothing matches. */
  emptyText?: string
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  describedBy?: string
  'aria-label'?: string
}

export function SuggestInput({ id, value, onChange, onCommit, suggestions, loading = false, emptyText, placeholder,
  disabled = false, invalid = false, describedBy, 'aria-label': ariaLabel }: SuggestInputProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const committed = useRef(value)
  const listId = useId()
  const optionId = (index: number) => `${listId}-option-${index}`
  const showList = open && !disabled && (loading || suggestions.length > 0 || Boolean(emptyText && value.trim()))

  useEffect(() => { setActive(-1) }, [suggestions])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  function commit(next: string) {
    setOpen(false)
    setActive(-1)
    if (next !== committed.current) {
      committed.current = next
      onCommit(next)
    }
  }
  function choose(index: number) {
    const suggestion = suggestions[index]
    if (!suggestion) return
    onChange(suggestion.value)
    committed.current = ''
    commit(suggestion.value)
  }

  return <div className="relative min-w-0">
    <Input ref={inputRef} id={id} size="compact" value={value} disabled={disabled} placeholder={placeholder}
      role="combobox" aria-autocomplete="list" aria-expanded={showList} aria-controls={showList ? listId : undefined}
      aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
      aria-invalid={invalid || undefined} aria-describedby={describedBy} aria-label={ariaLabel}
      {...noAutofill}
      onFocus={() => setOpen(true)}
      onChange={event => { onChange(event.target.value); setOpen(true) }}
      onBlur={event => {
        // Choosing a row keeps focus in the field (rows prevent mousedown), so a blur here leaves the control.
        if (panelRef.current?.contains(event.relatedTarget as Node | null)) return
        commit(value.trim())
      }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setOpen(true)
          if (!suggestions.length) return
          const step = event.key === 'ArrowDown' ? 1 : -1
          setActive(current => (current + step + suggestions.length) % suggestions.length)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (showList && active >= 0) choose(active)
          else commit(value.trim())
        } else if (event.key === 'Escape' && showList) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
      }} />
    <PopoverSurface open={showList} id={listId} role="listbox" aria-label={ariaLabel ?? 'Suggestions'} triggerRef={inputRef} panelRef={panelRef}
      matchTriggerWidth side="below" contentKey={suggestions}
      className={`max-h-72 overflow-y-auto rounded-xl border border-card-edge bg-popover p-1 text-foreground ${OVERLAY_SHADOW}`}>
      {loading && <div role="status" className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>}
      {!loading && suggestions.length === 0 && emptyText && <div className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</div>}
      {suggestions.map((suggestion, index) => <div key={suggestion.value} id={optionId(index)} role="option" aria-selected={index === active}
        tabIndex={-1}
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={() => setActive(index)}
        onClick={() => choose(index)}
        className={`flex min-h-9 cursor-pointer flex-col justify-center rounded-md px-3 py-1.5 text-sm ${POPOVER_OPTION_FOCUS} ${index === active ? 'bg-accent' : ''}`}>
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{suggestion.label}</span>
        {suggestion.detail && <span className="min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{suggestion.detail}</span>}
      </div>)}
    </PopoverSurface>
  </div>
}
