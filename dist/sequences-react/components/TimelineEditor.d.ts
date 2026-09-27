/**
 * The timeline editor surface: program monitor, transport row, and the
 * scrollable track area, composed over the engine (command stack, zoom math,
 * snapping, playback clock) and media (frame provider, waveforms) layers.
 *
 * State ownership:
 * - The COMMAND STACK owns the timeline. Every edit is a `TimelineCommand`
 *   executed optimistically, then persisted via `onApplyOperations`; a
 *   rejected persist rolls the command back locally WITHOUT emitting its
 *   inverse (the server never saw it). A user-initiated undo/redo DOES emit
 *   (the server applied the original), so the editor mirrors the executed
 *   commands to know which operations an undo corresponds to — the engine
 *   stack exposes no command identity from `undo()`.
 * - Clip-creating commands mint optimistic `local-…` ids. When
 *   `onApplyOperations` resolves with `SequenceApplyResult[]`, the editor
 *   records local→server aliases that every command resolves through at
 *   execute/undo/emission time, so undoing a committed place/split/caption
 *   works after a server refresh. Hosts resolving void skip reconciliation;
 *   undo of creates then fails loud (error bar) once a refresh replaced the
 *   local ids.
 *
 * Captions require an unlocked caption track: the editor creates clips, never
 * tracks. Products seed a caption track at sequence creation (or let the
 * agent's create_track tool add one); the caption button errors otherwise.
 * - The PLAYBACK CLOCK owns the playhead. Volatile view state (selection,
 *   zoom, snap toggle) lives in React state; the contract's
 *   `EditorTimelineState` view fields are initials, not a live channel.
 *
 * Compositing/stacking rule: `sortOrder` is paint order — later tracks paint
 * over earlier ones in the preview; rows render top→bottom in the same order.
 *
 * Asset drops: lanes accept `application/x-sequence-media` payloads
 * (JSON `{ url, kind, label?, durationSeconds?, generationId?, assetId? }`),
 * which is how a host's `renderAssetShelf` content places media — video/image
 * onto video tracks, audio onto audio tracks.
 *
 * Keyboard: space play/pause · delete/backspace removes the selection (one
 * undo step) · mod+z undo · shift+mod+z / mod+y redo · escape cancels an
 * in-flight drag (handled by the chips).
 */
import type { TimelineEditorProps } from '../contracts';
export declare const SEQUENCE_MEDIA_DRAG_TYPE = "application/x-sequence-media";
export declare function TimelineEditor(props: TimelineEditorProps): import("react").JSX.Element;
export default TimelineEditor;
