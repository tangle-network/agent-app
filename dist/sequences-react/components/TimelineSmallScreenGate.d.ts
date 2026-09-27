/**
 * Phone gate. The Konva preview + frame-accurate scrub/trim gestures need room;
 * below the `sm` breakpoint a squeezed timeline is unusable, so we show a short,
 * on-brand "best on a larger screen" panel INSTEAD of a broken editor. The real
 * editor is rendered alongside and revealed at `sm`+ via Tailwind — this gate is
 * `sm:hidden`, so nothing about the editor's logic, lifecycle, or tests changes.
 */
import type { TimelineEditorLabels } from '../contracts';
export interface TimelineSmallScreenGateProps {
    labels?: TimelineEditorLabels;
}
export declare function TimelineSmallScreenGate({ labels }: TimelineSmallScreenGateProps): import("react").JSX.Element;
