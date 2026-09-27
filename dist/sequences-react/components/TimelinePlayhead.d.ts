/**
 * Playhead overlay for the track area: a full-height line with a triangular
 * cap. Positioned in timeline pixels (frame * zoom) inside the scrolled
 * content, so it moves with horizontal scroll for free. Pointer-transparent —
 * scrubbing belongs to the ruler.
 */
export interface TimelinePlayheadProps {
    frame: number;
    zoom: number;
}
export declare function TimelinePlayhead({ frame, zoom }: TimelinePlayheadProps): import("react").JSX.Element;
