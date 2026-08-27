import type { ReactNode, SelectHTMLAttributes } from 'react'
import { Label } from '@tangle-network/sandbox-ui/primitives'
import { ChevronRight, Minus, Plus } from 'lucide-react'

export function Field({
  label,
  htmlFor,
  className = 'space-y-1.5',
  children,
}: {
  label: string
  htmlFor?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className}>
      <Label
        htmlFor={htmlFor}
        className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
      >
        {label}
      </Label>
      {children}
    </div>
  )
}

export function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <div className="flex h-9 items-center justify-between rounded-md border border-input bg-background px-1.5">
      <button
        type="button"
        aria-label="Decrease"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="text-sm font-medium tabular-nums">{value}</span>
      <button
        type="button"
        aria-label="Increase"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function ComposerDisclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-background transition-colors">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-foreground/80 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="border-t border-border px-3 py-3">{children}</div>
    </details>
  )
}

export function NativeSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className="h-9 w-full rounded-md border border-input bg-[var(--md3-surface-container-low)] px-3 text-sm" />
  )
}
