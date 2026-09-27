/**
 * Labeled placeholder lanes drawn behind the empty state so the surface reads
 * as a timeline before any track exists: a "Video" lane and a "Captions" lane
 * with the same sticky header column the real `TimelineTrackRow` uses, sized to
 * the timeline width so the ruler's timecodes line up over real lanes. Purely
 * decorative — no clips, no gestures.
 */
export interface TimelineGhostLanesProps {
    /** Timeline pixel width (durationFrames * zoom), so ghost lanes match the ruler. */
    laneWidth: number;
    videoLabel: string;
    captionLabel: string;
}
export declare function TimelineGhostLanes({ laneWidth, videoLabel, captionLabel }: TimelineGhostLanesProps): import("react").JSX.Element;
