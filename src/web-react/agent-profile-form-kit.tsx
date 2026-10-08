/**
 * Layout and text conventions for the profile editor, kept in one place so
 * every section uses one type size, one spacing scale, and one control height.
 *
 * Type: 14px (`text-sm`) for labels, values, help, status, and errors; section
 * titles are 16px semibold. Nothing in the form is smaller.
 * Spacing: 8px from a label to its control, 16px between fields, 16px between
 * sections. Controls: `--control-height` for inputs, selects, pickers, and
 * buttons (`size="compact"`).
 *
 * Two-column field rows respond to the editor's own width through a container
 * query, so the form stays single-column inside a narrow side panel on a wide
 * screen.
 */
import { useId, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@tangle-network/ui/primitives'

export const formText = {
  body: 'text-sm leading-6 text-foreground',
  muted: 'text-sm leading-6 text-muted-foreground',
  error: 'text-sm leading-6 text-destructive',
  label: 'text-sm font-medium leading-6 text-foreground',
  /** Section titles are the one step up: 16px semibold. */
  title: 'text-base font-semibold leading-6 text-foreground',
} as const

/** Two fields side by side once the editor is at least 36rem wide. */
export const formRow = 'grid gap-4 @xl/profile-editor:grid-cols-2'

/** A list row: its text, then its actions beside it when the editor is wide enough, or below it when narrow. */
export const listRow = 'flex flex-col gap-1 @lg/profile-editor:flex-row @lg/profile-editor:items-start @lg/profile-editor:justify-between @lg/profile-editor:gap-3'

/** Row actions are ghost buttons; pulling them left by their padding lines their text up with the row's text when stacked. */
export const rowActions = 'flex shrink-0 flex-wrap gap-1 -ml-3 @lg/profile-editor:ml-0'

function InfoGlyph({ className }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" />
  </svg>
}

/**
 * An info button beside a label. It opens on hover and keyboard focus, and
 * toggles on tap, so the help is reachable on touch screens too.
 */
function InfoHint({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
    <TooltipTrigger asChild>
      <button type="button" aria-label={`About ${label}`} onClick={() => setOpen(current => !current)}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <InfoGlyph className="size-4" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-72 text-sm leading-5">{children}</TooltipContent>
  </Tooltip>
}

export interface FieldProps {
  label: string
  /** The control's id; the label targets it. */
  htmlFor: string
  /** Help that explains what the setting does, shown from an info button. */
  info?: ReactNode
  /** One short sentence the person needs to fill the field in. */
  hint?: ReactNode
  /** A validation error. The control should set `aria-invalid` and reference {@link fieldMessageId}. */
  error?: ReactNode
  /** A non-error status, such as a check that passed. */
  status?: ReactNode
  /** Trailing content in the label row, such as a "Use default" action. */
  aside?: ReactNode
  children: ReactNode
}

/** The id of a field's hint, error, or status line, for the control's `aria-describedby`. */
export function fieldMessageId(htmlFor: string): string {
  return `${htmlFor}-message`
}

export function Field({ label, htmlFor, info, hint, error, status, aside, children }: FieldProps) {
  const message = error ?? status ?? hint
  return <div className="min-w-0 space-y-2">
    <div className="flex min-h-6 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <label htmlFor={htmlFor} className={formText.label}>{label}</label>
        {info && <InfoHint label={label}>{info}</InfoHint>}
      </span>
      {aside}
    </div>
    {children}
    {message && <div id={fieldMessageId(htmlFor)} role={error ? 'alert' : undefined}
      className={error ? formText.error : formText.muted}>{message}</div>}
  </div>
}

export interface SectionProps {
  title: string
  /** One sentence on what the section controls. */
  description?: ReactNode
  /** Short trailing summary, such as "3 skills". */
  summary?: ReactNode
  /** Collapsible sections start closed unless this is set. */
  defaultOpen?: boolean
  collapsible?: boolean
  children: ReactNode
}

function Chevron({ className }: { className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
}

/** A bordered section. Collapsible sections use a native disclosure so they work without script. */
export function Section({ title, description, summary, defaultOpen = false, collapsible = false, children }: SectionProps) {
  const headingId = useId()
  const header = <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
    <span className="min-w-0 space-y-0.5">
      <span id={headingId} className={`block ${formText.title}`}>{title}</span>
      {description && <span className={`block ${formText.muted}`}>{description}</span>}
    </span>
    {(summary || collapsible) && <span className={`flex shrink-0 items-center gap-2 ${formText.muted}`}>
      {summary}
      {collapsible && <Chevron className="size-4 transition-transform group-open:rotate-180" />}
    </span>}
  </span>
  if (!collapsible) {
    return <section aria-labelledby={headingId} className="min-w-0 rounded-xl border border-border bg-card">
      <header className="flex px-4 pt-4">{header}</header>
      <div className="min-w-0 space-y-4 p-4">{children}</div>
    </section>
  }
  return <details open={defaultOpen || undefined} className="group min-w-0 rounded-xl border border-border bg-card">
    <summary aria-labelledby={headingId} className="flex cursor-pointer list-none rounded-xl p-4 marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {header}
    </summary>
    <div className="min-w-0 space-y-4 border-t border-border p-4">{children}</div>
  </details>
}

export type StatusTone = 'neutral' | 'pending' | 'success' | 'warning' | 'error'

const toneClass: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  pending: 'text-muted-foreground',
  success: 'text-[var(--surface-success-text,hsl(var(--success)))]',
  warning: 'text-warning-strong',
  error: 'text-destructive',
}

function StatusGlyph({ tone }: { tone: StatusTone }) {
  if (tone === 'pending') {
    return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
  }
  if (tone === 'success') {
    return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
  }
  if (tone === 'error' || tone === 'warning') {
    return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
  }
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /></svg>
}

/** An inline status with an icon: a check in progress, a passed check, or a failure. */
export function StatusLine({ tone, children, id }: { tone: StatusTone; children: ReactNode; id?: string }) {
  return <p id={id} role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 text-sm leading-6 ${toneClass[tone]}`}>
    <span className="flex h-6 items-center"><StatusGlyph tone={tone} /></span>
    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</span>
  </p>
}

/** A short state label with a dot, for list rows. */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center gap-1.5 text-sm leading-6 ${toneClass[tone]}`}>
    {tone === 'pending'
      ? <StatusGlyph tone="pending" />
      : <span aria-hidden="true" className="size-2 rounded-full bg-current" />}
    {children}
  </span>
}

/** A banner for a form-wide state, such as an error the person must fix before saving. */
export function Notice({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  return <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-3 text-sm leading-6 ${tone === 'error'
    ? 'border-destructive/40 bg-destructive/5 text-foreground'
    : 'border-border bg-muted/50 text-foreground'}`}>{children}</div>
}

/** Attributes that keep password managers and browser autofill off fields that are not credentials. */
export const noAutofill = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  spellCheck: false,
} as const
