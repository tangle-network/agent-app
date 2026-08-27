/**
 * In-canvas empty state — the first move on a blank design. Shown by
 * WorkspaceView as a centered overlay while the active page has no user
 * content, so a fresh canvas reads as "ready to start" rather than "broken or
 * empty". Three doors cover the two ways people begin and the agent path:
 *   - Start with a template — drop a starter element via the same command stack.
 *   - Add an element — insert a text block by hand.
 *   - Ask the agent — surfaced only when the host wires `onAskAgent` (an agent
 *     panel exists); otherwise the door is omitted rather than rendered dead.
 *
 * Token-styled only (CSS-var tokens + Tailwind semantic names) and stamped with
 * the Tangle mark so the blank state is on-brand. Pointer-events stay scoped to
 * the card: clicking the surrounding canvas still starts a marquee.
 */

import type { ReactElement } from 'react'
import { BrandKnot } from './BrandKnot'
import { PlusGlyph, ShapesGlyph } from './glyphs'

interface SparkleProps {
  className?: string
}

function SparkleGlyph({ className }: SparkleProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  )
}

export interface CanvasEmptyStateProps {
  /** Drop a starter template element through the command stack. */
  onStartTemplate(): void
  /** Insert a single editable element by hand. */
  onAddElement(): void
  /** Focus the agent panel / open the agent. Omitted → the door is hidden. */
  onAskAgent?(): void
  /** Heading copy. Overridable; defaults to the cold-open prompt. */
  title?: string
  /** Supporting line under the heading. Overridable. */
  subtitle?: string
  className?: string
}

interface Door {
  key: string
  label: string
  hint: string
  Icon: (p: { className?: string }) => ReactElement
  onClick(): void
}

/**
 * The three-door empty state. Each door is a real action wired to the editor's
 * command stack (or the agent), never a placeholder.
 */
export function CanvasEmptyState({
  onStartTemplate,
  onAddElement,
  onAskAgent,
  title = 'Start your design',
  subtitle = 'Drop in a template, add an element by hand, or let the agent draft it for you.',
  className,
}: CanvasEmptyStateProps) {
  const doors: Door[] = [
    {
      key: 'template',
      label: 'Start with a template',
      hint: 'A headline, shape, or block to build on',
      Icon: ShapesGlyph,
      onClick: onStartTemplate,
    },
    {
      key: 'element',
      label: 'Add an element',
      hint: 'Place text on the page and edit it',
      Icon: PlusGlyph,
      onClick: onAddElement,
    },
  ]
  if (onAskAgent) {
    doors.push({
      key: 'agent',
      label: 'Ask the agent',
      hint: 'Describe what you want made',
      Icon: SparkleGlyph,
      onClick: onAskAgent,
    })
  }

  return (
    // Overlay is non-interactive so empty-space clicks reach the canvas; the
    // centered card re-enables pointer events for its own controls.
    <div
      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4 ${className ?? ''}`}
      role="group"
      aria-label="Start your design"
    >
      <div className="pointer-events-auto flex w-full max-w-lg flex-col items-center gap-5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-input)]/95 px-6 py-7 text-center shadow-xl backdrop-blur sm:px-8">
        <span className="flex items-center gap-2 text-[var(--text-muted)]">
          <BrandKnot size={22} className="shrink-0" />
          <span className="text-[11px] font-medium uppercase tracking-[0.14em]">Tangle Design</span>
        </span>

        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
          <p className="text-sm leading-5 text-[var(--text-secondary)]">{subtitle}</p>
        </div>

        <div className="grid w-full gap-2 sm:grid-cols-3">
          {doors.map(({ key, label, hint, Icon, onClick }) => (
            <button
              key={key}
              type="button"
              onClick={onClick}
              className="group flex min-h-[44px] flex-col items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[hsl(var(--card))] px-3 py-4 text-center transition-colors hover:border-[var(--brand-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-input)]"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--brand-primary)]/10 text-[var(--brand-primary)] transition-colors group-hover:bg-[var(--brand-primary)]/15">
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-[13px] font-medium text-[var(--text-primary)]">{label}</span>
              <span className="text-[11px] leading-4 text-[var(--text-muted)]">{hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
