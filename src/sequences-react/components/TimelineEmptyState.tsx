/**
 * Resting / zero-track state for the timeline. Two jobs:
 *
 *  1. Keep TIME legible at rest — the ruler and labeled ghost lanes (Video /
 *     Captions) render even with no clips, so the surface still reads as a
 *     timeline ("a ruler WITH numbers") the moment it opens.
 *  2. Give the first move a name — up to three doors (start from a template,
 *     add a clip, ask the agent), branded with the Tangle knot, over the ghost
 *     lanes. Each door renders only when the host wires its handler.
 *
 * The doors and copy are fully overridable through `TimelineEditorLabels`.
 */

import type { TimelineEditorLabels } from '../contracts'
import { DEFAULT_TIMELINE_LABELS } from '../contracts'
import { BrandMark } from './BrandMark'
import { FilmGlyph, CaptionPlusGlyph, AgentGlyph } from './glyphs'

export interface TimelineEmptyStateProps {
  labels?: TimelineEditorLabels
  brandedExport?: boolean
  onStartFromTemplate?(): void
  onAddClip?(): void
  onAskAgent?(): void
}

const DOOR_BUTTON =
  'flex min-h-[44px] items-center gap-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] px-3.5 py-2 text-xs font-medium text-[var(--text-secondary)] transition hover:border-[var(--brand-primary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function TimelineEmptyState(props: TimelineEmptyStateProps) {
  const labels = { ...DEFAULT_TIMELINE_LABELS, ...props.labels }
  const doors: Array<{ key: string; label: string; primary: boolean; icon: (p: { className?: string }) => React.ReactNode; onClick: () => void }> = []
  if (props.onStartFromTemplate) {
    doors.push({ key: 'template', label: labels.emptyTemplateDoor, primary: true, icon: FilmGlyph, onClick: props.onStartFromTemplate })
  }
  if (props.onAddClip) {
    doors.push({ key: 'clip', label: labels.emptyClipDoor, primary: false, icon: CaptionPlusGlyph, onClick: props.onAddClip })
  }
  if (props.onAskAgent) {
    doors.push({ key: 'agent', label: labels.emptyAgentDoor, primary: false, icon: AgentGlyph, onClick: props.onAskAgent })
  }

  return (
    <div
      data-timeline-empty
      className="sticky left-0 flex min-h-[6rem] flex-col items-center justify-center gap-3 px-6 py-9 text-center"
      style={{ width: '100%' }}
    >
      <BrandMark size={28} className="shrink-0 opacity-90" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{labels.emptyTitle}</p>
        <p className="max-w-sm text-xs text-[var(--text-muted)]">{labels.emptyBody}</p>
      </div>
      {doors.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {doors.map(({ key, label, primary, icon: Icon, onClick }) => (
            <button
              key={key}
              type="button"
              onClick={onClick}
              className={
                primary
                  ? 'flex min-h-[44px] items-center gap-2 rounded-md bg-[var(--brand-primary)] px-3.5 py-2 text-xs font-semibold text-[hsl(var(--primary-foreground))] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                  : DOOR_BUTTON
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
