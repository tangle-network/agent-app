import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { OVERLAY_SHADOW, PopoverSurface } from './controls'
import { usePopoverDialog } from './popover-dialog'

export interface AgentSettingsPopoverProps {
  /** Accessible name of the trigger and its non-modal dialog. */
  label?: string
  /** Current profile or model, kept visible without opening the panel. */
  summary?: ReactNode
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
  className?: string
  panelClassName?: string
}

/** One settings surface for entry, docked and embedded composers. No selection policy. */
export function AgentSettingsPopover({
  label = 'Agent settings', summary, children, open: controlledOpen,
  onOpenChange, disabled = false, className, panelClassName,
}: AgentSettingsPopoverProps) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = !disabled && (controlledOpen ?? localOpen)
  const changeOpen = useCallback((next: boolean) => {
    setLocalOpen(next)
    onOpenChange?.(next)
  }, [onOpenChange])
  useEffect(() => { if (disabled) changeOpen(false) }, [disabled, changeOpen])
  const { containerRef, triggerRef, panelRef, triggerProps, id } = usePopoverDialog(open, changeOpen)
  return (
    <div ref={containerRef} className={`inline-flex min-w-0 max-w-full ${className ?? ''}`}>
      <button
        type="button" {...triggerProps} disabled={disabled}
        aria-label={label} title={label} data-agent-settings-trigger=""
        onClick={() => changeOpen(!open)} data-state={open ? 'open' : 'closed'}
        className="inline-flex min-h-9 max-w-[15rem] items-center gap-1.5 rounded-full border border-border bg-transparent px-2.5 text-sm font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
          <rect x="4" y="7" width="16" height="14" rx="3" /><path d="M12 7V3M9 3h6M1 12v4m22-4v4m-15-3h.01M16 13h.01M9 17h6" />
        </svg>
        <span className="min-w-0 truncate">{summary ?? label}</span>
        <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <PopoverSurface
        open={open} id={id} role="dialog" aria-label={label}
        triggerRef={triggerRef} panelRef={panelRef}
        className={`w-80 max-w-[calc(100vw-2rem)] space-y-4 overflow-y-auto rounded-xl border border-card-edge bg-popover p-4 text-foreground ${OVERLAY_SHADOW} ${panelClassName ?? ''}`}
      >
        {children}
      </PopoverSurface>
    </div>
  )
}
