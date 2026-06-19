import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

/**
 * Right-side overlay sheet built on Radix Dialog — gives focus-trap, scroll-lock,
 * and Escape-to-close for free. Slide/fade come from the studio-sheet-* classes in
 * app.css (driven by Radix data-state), not tailwindcss-animate.
 */
export function StudioSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="studio-sheet-overlay fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="studio-sheet-content fixed inset-y-0 right-0 z-50 flex w-[min(92vw,30rem)] flex-col border-l border-border bg-card shadow-[var(--shadow-dropdown)] focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
