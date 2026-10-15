import { useRef, type ReactNode } from 'react'
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle } from '@tangle-network/ui/primitives'

// The shell owns mutation state; the shared primitives own controls and focus.
export function ActionDialogButton({ children, onClick, disabled, variant = 'primary' }: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost' | 'destructive'
}) {
  return <Button type="button" onClick={onClick} disabled={disabled} variant={variant === 'primary' ? 'default' : variant}>{children}</Button>
}

export function ActionDialog({ title, children, footer, onClose, busy, error }: {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
  busy: boolean
  error: string | null
}) {
  // These dialogs mount without a DialogTrigger: retain the shell's opener.
  const opener = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent hideCloseButton aria-describedby={undefined} className="max-w-sm gap-0 p-5"
      onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
      onInteractOutside={event => { if (busy) event.preventDefault() }}
      onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus() }}>
      <DialogTitle className="text-sm">{title}</DialogTitle>
      <div className="mt-3">{children}</div>
      {error && <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
      <DialogFooter className="mt-5">{footer}</DialogFooter>
    </DialogContent>
  </Dialog>
}
