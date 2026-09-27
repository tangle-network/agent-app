/** Renderer-neutral attribution. Not a transcript merger or an execution state machine. */
export interface ConversationGroupItem {
    id?: string | number;
    kind?: string;
    role?: string;
    /** A different assistant/persona must never inherit the previous speaker's label. */
    speakerId?: string;
    /** Distinct threads must not be grouped if their rows share a viewport. */
    conversationId?: string;
}
export type GroupedConversationItem<T> = T & {
    isContinuation?: boolean;
    groupId?: string;
};
/**
 * Annotate assistant rows until an actual user message, speaker or conversation change.
 * Tool/progress notices do not interrupt the group. The first visible assistant is
 * always labeled, including when a renderer has paged earlier history away.
 * Pass display order; stored content, IDs, timestamps and input objects are untouched.
 */
export declare function groupConversationMessages<T extends ConversationGroupItem>(items?: readonly T[]): GroupedConversationItem<T>[];
