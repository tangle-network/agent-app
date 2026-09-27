/**
 * Assistant-story fixtures: a fully-stubbed `AssistantClient` (no network — the
 * panel's hooks fetch models/threads on mount, and the dock's real
 * `useAssistantChat` streams through it), a controlled `AssistantChat` handle
 * for the panel stories (the same fake the panel's own tests build), and the
 * transcript/proposal data those stories render.
 *
 * The shared `src/stories/fixtures/` chat fixtures model web-react's
 * `ChatUiMessage`; the assistant transcript consumes the FLAT wire
 * `ChatMessage[]` shape (user/assistant/tool/status rows the reducer emits), so
 * this area keeps its own fixtures rather than bending the shared ones.
 */
import { type AssistantClient, type AssistantThreadSummary } from '../../assistant';
import { type AssistantState } from '../../assistant/reducer';
import type { AssistantStreamEvent, ChatMessage, PendingProposal, UsageInfo } from '../../assistant/types';
import type { AssistantChat } from '../../assistant/useAssistantChat';
import type { ComposerFile } from '../../web-react';
declare const STORY_USER_ID = "u-story";
/** Past conversations for the history view, newest activity first. */
export declare const threadSummaries: AssistantThreadSummary[];
/** A settled two-turn conversation: tool chips with args + outcomes, a status
 *  line, and enough prose to judge bubble spacing. */
export declare const populatedMessages: ChatMessage[];
/** A settled confirmed action: the proposal flow ended in the quiet status
 *  line ("Created workflow …") rather than an assistant-labeled turn. */
export declare const confirmedMessages: ChatMessage[];
/** A turn mid-stream: preamble text, a running tool chip, and an open (still
 *  empty) bubble the deltas are accumulating into. */
export declare const streamingMessages: ChatMessage[];
export declare const streamingReasoning = "The user wants a scheduled post. A cron trigger plus the Slack send step covers it \u2014 checking the workspace connections before proposing anything mutating.";
/** The turn-level metrics a settled turn leaves behind. */
export declare const settledUsage: UsageInfo;
export declare const workflowYaml = "name: launch-poster-monday\ntrigger:\n  type: schedule\n  cron: \"0 9 * * MON\"\nsteps:\n  - id: render\n    uses: canvas/export\n    with:\n      page: page-1\n      format: png\n      dpi: 144\n  - id: post\n    uses: slack/send-message\n    with:\n      channel: \"#launch\"\n      text: \"This week's poster: {{ steps.render.outputs.url }}\"\n";
/** A workflow-authoring proposal awaiting confirmation, with one unconnected
 *  requirement (the connect affordance renders) and one satisfied. */
export declare const workflowProposal: PendingProposal;
/** A create-key proposal — the scalar-fields card (no body preview). */
export declare const apiKeyProposal: PendingProposal;
/** Twenty messages of ordinary back-and-forth — long enough that the transcript
 *  scrolls, so spacing and typography evaluate under real rhythm. */
export declare const longHistoryMessages: ChatMessage[];
export interface StubClientOptions {
    /** Replace the scripted turn (e.g. an erroring stream). */
    streamEvents?: (req: {
        message: string;
    }) => AssistantStreamEvent[];
}
/** Shared instance for stories that don't customize the transport. The model
 *  catalog is cached per client (WeakMap in `useAssistantModels`), so sharing
 *  one avoids a refetch on every story mount. */
export declare const stubClient: AssistantClient;
/**
 * A minimal `AssistantChat` over a controlled state slice — the same fake the
 * panel's tests build, with `console.log` callbacks instead of spies. The
 * panel reads `state` and binds the handlers; the transport is never involved.
 */
export declare function makeFakeChat(over?: Partial<AssistantState>): AssistantChat;
export { STORY_USER_ID };
/**
 * A story-level stand-in for the host attachment pipeline (web-react's
 * `useComposerAttachments` + an upload route): each picked/dropped file stages
 * as an 'uploading' chip and flips to 'ready' after a beat, so stories exercise
 * the composer's chip lifecycle with no network. `onSend` clears the staged
 * set — wire it to the panel/dock `onComposerSend`.
 */
export declare function useStubAttachments(): {
    attachments: {
        onAttach: (files: FileList) => void;
        pendingFiles: ComposerFile[];
        onRemoveFile: (id: string) => void;
    };
    onSend: () => void;
};
