/**
 * Phone gate. The Konva preview + frame-accurate scrub/trim gestures need room;
 * below the `sm` breakpoint a squeezed timeline is unusable, so we show a short,
 * on-brand "best on a larger screen" panel INSTEAD of a broken editor. The real
 * editor is rendered alongside and revealed at `sm`+ via Tailwind — this gate is
 * `sm:hidden`, so nothing about the editor's logic, lifecycle, or tests changes.
 */

import type { TimelineEditorLabels } from '../contracts'
import { DEFAULT_TIMELINE_LABELS } from '../contracts'
import { BrandMark } from './BrandMark'

export interface TimelineSmallScreenGateProps {
  labels?: TimelineEditorLabels
}

export function TimelineSmallScreenGate({ labels }: TimelineSmallScreenGateProps) {
  const copy = { ...DEFAULT_TIMELINE_LABELS, ...labels }
  return (
    <div
      data-timeline-small-screen
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-[var(--bg-input)] px-8 py-12 text-center text-[var(--text-primary)] sm:hidden"
    >
      <BrandMark size={32} className="shrink-0 opacity-90" />
      <p className="text-base font-semibold">{copy.smallScreenTitle}</p>
      <p className="max-w-xs text-sm text-[var(--text-muted)]">{copy.smallScreenBody}</p>
    </div>
  )
}
