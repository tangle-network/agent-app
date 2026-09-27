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
import type { TimelineEditorLabels } from '../contracts';
export interface TimelineEmptyStateProps {
    labels?: TimelineEditorLabels;
    brandedExport?: boolean;
    onStartFromTemplate?(): void;
    onAddClip?(): void;
    onAskAgent?(): void;
}
export declare function TimelineEmptyState(props: TimelineEmptyStateProps): import("react").JSX.Element;
