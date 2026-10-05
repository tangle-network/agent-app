import { useEffect, type ReactNode } from 'react'

import { OVERLAY_SHADOW } from './controls'

// The one confirm/edit dialog behind every rename and delete in the shell —
// session history and the workspace listing share it so the two never drift
// into subtly different destructive confirmations.

export function ActionDialogButton({
  children,
  onClick,
  disabled,
  variant = 'primary',
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost' | 'destructive'
}) {
  const tone =
    variant === 'ghost'
      ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
      : variant === 'destructive'
        ? 'bg-destructive text-destructive-foreground hover:opacity-90'
        : 'bg-primary text-primary-foreground hover:opacity-90'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-9 rounded-md px-3 text-sm font-medium transition disabled:opacity-50 ${tone}`}
    >
      {children}
    </button>
  )
}

export function ActionDialog({
  title,
  children,
  footer,
  onClose,
  busy,
  error,
}: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
  busy: boolean
  error: string | null
}) {
  // Hand focus back to whatever opened the dialog when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => opener?.focus()
  }, [])

  // Escape closes unless a mutation is in flight — closing mid-write would hide
  // the error the user needs to see.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => {
          if (!busy) onClose()
        }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full max-w-sm rounded-xl border border-card-edge bg-popover p-5 ${OVERLAY_SHADOW}`}
      >
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="mt-3">{children}</div>
        {error && (
          <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  )
}
