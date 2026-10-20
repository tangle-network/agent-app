import type { ReactNode } from 'react'
import { BrandMark } from './brand-mark'

/** One starting "door" in the chat first-run state — a concrete, labeled action
 *  (start from a template, do it by hand, ask the agent), not a placeholder. */
export interface ChatEmptyDoor {
  label: string
  description?: string
  onSelect: () => void
  /** Optional glyph rendered left of the label. */
  icon?: ReactNode
}

/** Define properties for rendering the chat empty state with customizable text and starting doors */
export interface ChatEmptyStateProps {
  /** Product name shown next to the Tangle mark. Default "Agent". */
  productName?: string
  /** Headline. Default frames delegation, not messaging. */
  headline?: string
  /** Subline under the headline. */
  subline?: string
  /** Up to three concrete starting doors. Omit for a mark-and-prompt-only state. */
  doors?: ChatEmptyDoor[]
}

/**
 * Branded chat first-run state: the Tangle mark, a delegation-framed prompt, and
 * up to three concrete doors. Replaces the blank thread that read as "empty or
 * broken". Concrete + actionable — never a "coming soon" placeholder.
 */
export function ChatEmptyState({
  productName = 'Agent',
  headline = 'Ask the agent to do something',
  subline = 'Describe the outcome you want. The agent works through it step by step, and pauses for your approval before anything irreversible.',
  doors,
}: ChatEmptyStateProps) {
  // Column count follows the doors actually offered: one door centers on a
  // narrow measure, two split evenly, three take the full row — a lone door
  // stretched across three tracks read as a mistake, not a choice.
  const doorCount = Math.min(doors?.length ?? 0, 3)
  const doorsGridClass =
    doorCount === 1
      ? 'mx-auto max-w-sm sm:grid-cols-1'
      : doorCount === 2
        ? 'sm:grid-cols-2'
        : 'sm:grid-cols-3'
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 py-12 text-center sm:py-20">
      <span className="mb-5 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
        <BrandMark size={32} className="shrink-0" />
      </span>
      <p className="text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">{productName}</p>
      <h2 className="mt-1.5 text-balance text-2xl font-semibold leading-tight text-foreground">
        {headline}
      </h2>
      {subline && <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground">{subline}</p>}
      {doors && doors.length > 0 && (
        <div className={`mt-7 grid w-full gap-2.5 ${doorsGridClass}`}>
          {doors.slice(0, 3).map((door, i) => (
            <button
              key={i}
              type="button"
              onClick={door.onSelect}
              className="group flex min-h-[44px] flex-col items-start rounded-xl border border-border bg-card px-4 py-3 text-left transition hover:border-primary/40 hover:bg-accent"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {door.icon}
                {door.label}
              </span>
              {door.description && (
                <span className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{door.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
