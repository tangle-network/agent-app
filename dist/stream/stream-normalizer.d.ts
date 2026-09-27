import { type ChatInteractionStatus } from '../interactions/contract';
/** Represent a JSON-compatible object with string keys and values of any type */
export type JsonRecord = Record<string, unknown>;
/** Define an event object carrying a type and optional JSON data payload */
export interface StreamEvent {
    type: string;
    data?: JsonRecord;
}
/** Resolve an unknown value to a JsonRecord if it is a non-array object or return undefined */
export declare function asRecord(value: unknown): JsonRecord | undefined;
/** Resolve a non-empty string from a value or return undefined */
export declare function asString(value: unknown): string | undefined;
/** Resolve a unique tool identifier from various possible properties or generate a fallback ID */
export declare function resolveToolId(part: JsonRecord): string;
/** Resolve the tool name from a JSON record using tool, name, or a default value */
export declare function resolveToolName(part: JsonRecord): string;
/** Resolve time properties from various keys into a normalized record with numeric start and end fields */
export declare function normalizeTime(value: unknown): JsonRecord | undefined;
/** Normalize tool-related events into a standardized message.part.updated format */
export declare function normalizeToolEvent(event: StreamEvent): StreamEvent;
/** Normalize a persisted part object by standardizing its structure and fields */
export declare function normalizePersistedPart(rawPart: JsonRecord): JsonRecord | null;
/** Stream/transcript part key for a promoted (path-bearing) attachment,
 *  keyed on its storage path — re-emitting the same path folds into the same
 *  segment instead of duplicating it. */
export declare function attachmentPartKey(path: string): string;
/** Resolve a unique key string for a part based on its type and identifying properties */
export declare function getPartKey(part: JsonRecord): string;
/** Merge incoming JSON with existing persisted data, applying delta for text types when provided */
export declare function mergePersistedPart(existing: JsonRecord | undefined, incoming: JsonRecord, delta?: string): JsonRecord;
/** Resolve errors when a tool fails to report a terminal result before the assistant turn ends */
export declare const MISSING_TOOL_TERMINAL_ERROR = "Tool did not report a terminal result before the assistant turn completed.";
/** Provide the reason identifier for a missing tool in the terminal environment */
export declare const MISSING_TOOL_TERMINAL_REASON = "missing-tool-terminal";
/** Closes a tool part left `running` when a stream ended abnormally: settles
 *  it as a terminal `error` and stamps `state.metadata.terminalized` so the
 *  synthetic settlement is distinguishable from a real tool failure. Parts
 *  that already settled (and non-tool parts) pass through untouched. */
export declare function terminalizeDanglingToolPart(part: JsonRecord): JsonRecord;
/** Resolve dangling tool parts into terminal forms within the given JSON records array */
export declare function terminalizeDanglingToolParts(parts: JsonRecord[]): JsonRecord[];
/** Settles still-pending interaction parts at persist time. The broker
 *  guarantees a resolved question either answered (run unblocked, no cancel
 *  event) or cancelled/timed out (cancel event already updated the part), so
 *  the success path finalizes remaining pendings as `answered` and the
 *  failure/terminalize paths as `expired`. */
export declare function finalizePendingInteractionParts(parts: JsonRecord[], outcome: Extract<ChatInteractionStatus, 'answered' | 'expired'>): JsonRecord[];
/** Collapses text-part artifacts of unstable upstream segment identity: the
 *  same text arriving under two keys (id-less delta stream, then an
 *  id-bearing snapshot) folds into two segments, and interleaved empty
 *  segments survive as blank parts. Consecutive identical text parts merge
 *  into one; empty text parts drop when any non-empty text part exists. */
export declare function collapseRedundantTextParts(parts: JsonRecord[]): JsonRecord[];
/** Resolve and clean up assistant parts by terminalizing and collapsing redundant segments */
export declare function finalizeAssistantParts(partOrder: string[], partMap: Map<string, JsonRecord>, finalText: string): JsonRecord[];
/** The MID-STREAM twin of {@link finalizeAssistantParts}: the same assembled,
 *  collapsed projection MINUS the dangling-tool terminalizer.
 *
 *  Incremental persistence snapshots the assistant body while the turn is
 *  still running, and mid-stream a tool part sitting at `state.status:
 *  'running'` is the NORMAL in-flight state — not the abnormal end
 *  {@link terminalizeDanglingToolPart} exists to settle. Running a live
 *  snapshot through `finalizeAssistantParts` would persist every in-flight
 *  tool call as a failure (`state.status:'error'`, `metadata.terminalized`),
 *  so a reader of the durable row would see phantom tool errors that the final
 *  write then silently un-does. Terminalization stays a completion-time
 *  decision: the final write is the only writer allowed to settle a tool part.
 *
 *  Pending `interaction` parts are likewise left `pending` here (the caller
 *  skips {@link finalizePendingInteractionParts}) — an ask is genuinely
 *  unanswered until the turn settles. */
export declare function draftAssistantParts(partOrder: string[], partMap: Map<string, JsonRecord>, finalText: string): JsonRecord[];
/** Finalizes, then folds each synthetic tool settlement back into `partMap`
 *  and returns just those updates — the shape a streaming loop needs to emit
 *  closing `message.part.updated` frames for tools the stream never settled. */
export declare function terminalizeDanglingAssistantToolUpdates(partOrder: string[], partMap: Map<string, JsonRecord>, finalText: string): JsonRecord[];
/** Encode a StreamEvent object into a Uint8Array using the provided TextEncoder */
export declare function encodeEvent(encoder: TextEncoder, event: StreamEvent): Uint8Array;
