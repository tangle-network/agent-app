import { useEffect, useId } from 'react'
import { usePopover } from './controls'

/** Non-modal dialog focus over the canonical portaled popover surface. */
export function usePopoverDialog(open: boolean, onOpenChange: (open: boolean) => void) {
  const popover = usePopover(open, onOpenChange)
  const id = useId()
  const { triggerRef, panelRef } = popover
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const controls = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    )).filter((element) => !element.closest('[hidden]'))
    const first = panel.querySelector<HTMLElement>('[data-autofocus]') ?? controls()[0]
    first?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== 'Tab') return
      const items = controls()
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (index < 0) return
      if ((event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
        onOpenChange(false)
        triggerRef.current?.focus()
        // Forward Tab continues after the trigger in document order.
        if (event.shiftKey) event.preventDefault()
      }
    }
    panel.addEventListener('keydown', onKeyDown)
    return () => panel.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange, panelRef, triggerRef])
  return {
    ...popover,
    id,
    triggerProps: {
      ...popover.triggerProps,
      'aria-haspopup': 'dialog' as const,
      'aria-controls': open ? id : undefined,
    },
  }
}
