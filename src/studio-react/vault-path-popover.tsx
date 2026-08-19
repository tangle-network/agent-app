import { useEffect, useId, useRef, useState, type FormEvent, type JSX, type RefObject } from 'react'
import { defaultVaultPathFor, normalizeVaultPath, type Generation } from '../studio'
import { OVERLAY_SHADOW, PopoverSurface } from '../web-react/controls'

export interface VaultPathPopoverProps {
  open: boolean
  triggerRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLDivElement | null>
  generations: readonly Generation[]
  onSubmit: (path: string) => void | Promise<void>
  onCancel: () => void
  pending?: boolean
}

export function VaultPathPopover({
  open,
  triggerRef,
  panelRef,
  generations,
  onSubmit,
  onCancel,
  pending = false,
}: VaultPathPopoverProps): JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open])

  if (!open) return null

  async function submit(event: FormEvent) {
    event.preventDefault()
    const normalized = normalizeVaultPath(inputRef.current?.value ?? '')
    if (!normalized) {
      setError('Enter a folder path inside the vault.')
      return
    }
    setError(null)
    try {
      await onSubmit(normalized)
    } catch {
      setError('Could not save to vault. Try again.')
    }
  }

  const count = generations.length
  const defaultPath = defaultVaultPathFor(generations)
  return (
    <PopoverSurface
      open={open}
      triggerRef={triggerRef}
      panelRef={panelRef}
      className={`flex w-[262px] flex-col overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground ${OVERLAY_SHADOW}`}
    >
      <form onSubmit={submit}>
        <label htmlFor={inputId} className="block px-0.5 pb-[7px] pt-0.5 text-[12px] text-muted-foreground">
          Save {count} item{count > 1 ? 's' : ''} to
        </label>
        <input
          key={defaultPath}
          ref={inputRef}
          id={inputId}
          defaultValue={defaultPath}
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-full rounded-lg border border-input bg-muted px-2.5 text-[13px] outline-none focus:border-primary focus:ring-[3px] focus:ring-ring/30"
        />
        {error && <p className="pt-1.5 text-[12px] text-destructive">{error}</p>}
        <p className="pt-2 text-[11.5px] text-muted-foreground">Media stays in Studio until you save it into the vault.</p>
        <div className="flex justify-end gap-2 pt-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-[30px] rounded-full border border-border px-3.5 text-[13px] hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-[30px] rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </form>
    </PopoverSurface>
  )
}
