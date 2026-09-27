/**
 * The sequences MCP tool registry — what the in-sandbox agent sees over the
 * live agent→timeline channel. Each entry carries an LLM-facing description,
 * a JSON Schema for the arguments, and the typed dispatch that converts
 * seconds→frames exactly once, validates the resulting operations, applies
 * them through the store, and records ONE decision row per mutating call.
 *
 * Tool arguments speak SECONDS (the unit an LLM reasons in); everything past
 * this edge is integer frames at the sequence fps. Results come back in
 * snake_case with both seconds and `m:ss.ff` timecodes so the model can quote
 * positions back to the user without doing frame math.
 *
 * Every mutation funnels through the ./validate + ./apply kernel: the WHOLE
 * operation batch validates against pre-state before the first write. Errors
 * thrown anywhere in a tool run (argument shape, validation, store) carry the
 * precise reason — the handler surfaces them verbatim as `isError` tool
 * results the model can act on.
 */
import type { SequenceStore } from './store';
/** Everything one tool invocation needs. Constructed per request by the
 *  handler — the store is already scoped + authorized by the product. The
 *  playhead is server-set (never a tool argument) so auto-placed captions
 *  anchor to what the user is actually looking at. */
export interface SequenceMcpToolEnv {
    store: SequenceStore;
    playheadFrame: number;
}
/** Define a tool with metadata and a run method for processing input within a specific environment */
export interface SequenceMcpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    run(args: Record<string, unknown>, env: SequenceMcpToolEnv): Promise<unknown>;
}
/** Define supported export formats for sequence outputs including video, subtitle, and metadata types */
export declare const SEQUENCE_EXPORT_FORMATS: readonly ["mp4", "otio", "xml", "edl", "vtt", "srt", "contact_sheet"];
/** Define immutable sequence track kinds for video, audio, caption, reference, and agent */
export declare const SEQUENCE_TRACK_KINDS: readonly ["video", "audio", "caption", "reference", "agent"];
/** Define the allowed media kinds for sequences including video, image, and audio */
export declare const SEQUENCE_MEDIA_KINDS: readonly ["video", "image", "audio"];
/** Largest accepted `add_captions` batch — bounds one decision row / one
 *  validation pass to a size the store can absorb in a single request. */
export declare const MAX_CAPTION_BATCH = 500;
/** Resolve an array of immutable sequence MCP tool definitions for timeline and frame operations */
export declare const SEQUENCE_MCP_TOOLS: readonly SequenceMcpToolDefinition[];
/** Resolve the SequenceMcpToolDefinition matching the given name or return undefined */
export declare function findSequenceMcpTool(name: string): SequenceMcpToolDefinition | undefined;
