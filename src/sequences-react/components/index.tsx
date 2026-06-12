/**
 * Timeline editor component surface. `TimelineEditor` is the root products
 * mount (see `../lazy` for the code-split entry); the leaf pieces are exported
 * for products that compose a custom editor shell from the same parts.
 */

export { TimelineEditor, SEQUENCE_MEDIA_DRAG_TYPE } from './TimelineEditor'
export { PreviewCanvas } from './PreviewCanvas'
export type { PreviewCanvasProps } from './PreviewCanvas'
export { TimelineRuler } from './TimelineRuler'
export type { TimelineRulerProps } from './TimelineRuler'
export { TimelineTrackRow } from './TimelineTrackRow'
export type { TimelineTrackRowProps } from './TimelineTrackRow'
export { TimelineClipChip } from './TimelineClipChip'
export type { TimelineClipChipProps, ClipMoveCommit, ClipTrimCommit } from './TimelineClipChip'
export { TimelinePlayhead } from './TimelinePlayhead'
export type { TimelinePlayheadProps } from './TimelinePlayhead'
export { SnapIndicatorLine } from './SnapIndicatorLine'
export type { SnapIndicatorLineProps } from './SnapIndicatorLine'
export { ZoomControl } from './ZoomControl'
export type { ZoomControlProps } from './ZoomControl'
export { compositeCommand } from './composite-command'
export {
  framesFromPixelDelta,
  moveDragStartFrame,
  trimStartDrag,
  trimEndDrag,
  selectTickStepSeconds,
  letterboxRect,
  captionFontPx,
  clipChipGeometry,
  chooseMoveSnap,
} from './interaction-math'
export type {
  MoveDragInput,
  TrimStartDragInput,
  TrimStartDragResult,
  TrimEndDragInput,
  LetterboxRect,
} from './interaction-math'
