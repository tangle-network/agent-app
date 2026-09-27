import type { JsonRecord } from './stream-normalizer';
/** Define the structure of a chat message stored for a specific conversation turn */
export interface PersistedChatMessageForTurn {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    parts: Array<Record<string, unknown>> | null;
}
/** Represent a chat turn with resolved user message insertion and prior message context */
export interface ResolvedChatTurn {
    turnIndex: number;
    shouldInsertUserMessage: boolean;
    priorMessages: PersistedChatMessageForTurn[];
    userParts: JsonRecord[];
    /** The id of the user row this turn REUSES (retry dedup), when one was
     *  found. Absent on the insert path, where no row exists yet.
     *
     *  The reused row is deliberately EXCLUDED from `priorMessages` (it is this
     *  turn's own user message, not prior context), so this field is the only
     *  way a caller can name it. */
    reusedUserMessageId?: string;
}
/** Normalize and validate a client turn ID string ensuring it meets format and length requirements */
export declare function normalizeClientTurnId(value: unknown): string | undefined;
/** Build an array of text parts with optional turn ID for user input */
export declare function buildUserTextParts(text: string, turnId: string | undefined): JsonRecord[];
/** Resolve whether a message contains any part with the specified turn ID */
export declare function messageHasTurnId(message: PersistedChatMessageForTurn, turnId: string): boolean;
/** Resolve a chat turn by determining message reuse and constructing user message parts */
export declare function resolveChatTurn(input: {
    existingMessages: PersistedChatMessageForTurn[];
    userContent: string;
    turnId?: string;
    /** True when the thread has a turn still RUNNING in the turn-event buffer
     *  (`turnStore.listRunning(threadId)`).
     *
     *  Without incremental persistence the trailing row of a thread mid-turn is
     *  always the user row, so the content fallback below could assume it. With
     *  incremental persistence the assistant row lands seconds into the turn, so
     *  a retry of that same turn finds an ASSISTANT row trailing and would
     *  insert a duplicate user row.
     *
     *  This flag is the discriminator that keeps both cases right, and it needs
     *  no new state: an assistant row trailing a turn that is still running is
     *  that turn's in-flight draft (walk past it — this is a retry), whereas an
     *  assistant row trailing a SETTLED turn is a completed answer (stop — the
     *  user genuinely repeated a message and deserves a new turn). */
    hasRunningTurn?: boolean;
}): ResolvedChatTurn;
