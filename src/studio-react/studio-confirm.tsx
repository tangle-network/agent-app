import { useEffect, useId, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_SHADOW } from '../web-react/controls'

export interface StudioConfirmDialogProps {
  open: boolean
  count: number
  onConfirm: () => void
  onCancel: () => void
}

export function StudioConfirmDialog({
  open,
  count,
  onConfirm,
  onCancel,
}: StudioConfirmDialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      const previous = previousFocusRef.current
      if (previous && document.contains(previous)) previous.focus()
      previousFocusRef.current = null
    }
  }, [open])

  if (!open || typeof document === 'undefined') return null

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!focusable || focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (event.shiftKey && active === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  return createPortal(
    <div
      className="studio-layer-confirm studio-backdrop fixed inset-0 grid place-items-center p-6"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
        className={`w-[min(360px,100%)] rounded-[14px] border border-border bg-card px-[18px] pb-4 pt-[18px] ${OVERLAY_SHADOW}`}
      >
        <h2 id={titleId} className="text-[15.5px] font-semibold tracking-[-0.01em]">
          Delete {count} item{count > 1 ? 's' : ''}?
        </h2>
        <p id={descriptionId} className="mt-[7px] text-[13px] text-muted-foreground">This cannot be undone.</p>
        <div className="flex justify-end gap-2 pt-[18px]">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-[30px] rounded-full border border-border px-3.5 text-[13px] hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-[30px] rounded-full bg-destructive px-3.5 text-[13px] font-medium text-destructive-foreground hover:brightness-110"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
