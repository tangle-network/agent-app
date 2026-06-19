import type { ReactNode, SelectHTMLAttributes } from 'react'
import { Label } from '@tangle-network/sandbox-ui/primitives'
import { ChevronRight } from 'lucide-react'

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
      <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
      {children}
    </div>
  )
}

export function ComposerDisclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-muted/30 transition-colors open:bg-muted/40">
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
    <select {...props} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" />
  )
}
