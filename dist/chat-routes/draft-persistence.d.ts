/**
 * Incremental ("draft") persistence of the assistant row WHILE a turn streams.
 *
 * Why this exists — the scale argument, not a convenience:
 *
 * A live turn is readable from two places. The hot path is the session
 * gateway's in-memory/Redis event buffer, which exists so a viewer survives a
 * network blip: it is keyed one sorted set per session, refreshed on every
 * push, and expires on a TTL. Its memory cost is `arrival_rate x TTL x
 * bytes_per_session` — strictly LINEAR in the TTL. Stretching that TTL to
 * cover "a viewer who opens the tab later" is a category error: it buys memory
 * proportional to the increase and still serves nothing to a viewer who
 * arrives past the new horizon.
 *
 * So the hot buffer must stay SHORT (live delivery + reconnect only), and
 * durable storage must serve history. That only works if durable storage
 * actually HAS the in-flight turn — which, before this module, it did not: the
 * assistant row was written once, after the stream drained. A viewer arriving
 * mid-turn past the hot window read an empty transcript.
 *
 * This module closes that gap: the assistant row is inserted early and patched
 * on a coalesced cadence, so the durable transcript is at most one interval
 * (default 2 s) behind the live stream and the hot buffer never has to be the
 * history tier.
 *
 * Mechanism only. It owns no vocabulary: the caller supplies the snapshot
 * function, the store, and the deterministic row id.
 *
 * Four properties the cadence guarantees:
 * - **Time-floored.** At most one write per `intervalMs`, never one per token.
 * - **Dirty-gated.** Only content-bearing events arm a write; heartbeats,
 *   status pings, and lifecycle envelopes never do.
 * - **Single-flight.** A write already in flight suppresses the next trigger
 *   instead of queueing; the final write is authoritative regardless of how
 *   many drafts landed.
 * - **Best-effort.** A store failure is logged and swallowed — a durability
 *   optimization must never kill a healthy stream (the same rule
 *   `withDurableChatProjection` already states).
 */
import { type ChatMessagePart } from '../chat-store/parts';
import type { ChatTurnUsage } from './turn-routes';
/** Message row shape the writer reads back when re-entering a turn. */
export interface DraftStoredMessage extends Pick<AssistantRowValues, keyof ChatTurnUsage> {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    parts?: ChatMessagePart[] | null;
    model?: string | null;
    requestedModel?: string | null;
    servedModel?: string | null;
    servedProvider?: string | null;
    servedSource?: string | null;
}
/** Values written to the assistant row — the intersection of the append and
 *  patch shapes, so one snapshot serves both. */
export interface AssistantRowValues {
    content: string;
    parts?: ChatMessagePart[];
    model?: string | null;
    requestedModel?: string | null;
    servedModel?: string | null;
    servedProvider?: string | null;
    servedSource?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    costUsd?: number | null;
}
/** The store capability incremental persistence needs on top of
 *  `appendMessage`. A store without `updateMessage` cannot patch a row, so it
 *  cannot draft at all — the caller keeps today's single-write behavior. */
export interface AssistantDraftStore {
    listMessages(threadId: string): Promise<DraftStoredMessage[]>;
    appendMessage(input: AssistantRowValues & {
        id?: string;
        threadId: string;
        role: 'user' | 'assistant';
    }): Promise<unknown>;
    updateMessage?(id: string, patch: AssistantRowValues): Promise<unknown>;
    deleteMessage?(id: string): Promise<unknown>;
}
/** Live snapshot of the assistant body, taken from the producer's own
 *  accumulators. `parts` is the DRAFT projection (`draftParts()`), never the
 *  finalized one — see `draftAssistantParts`. */
export interface AssistantDraftSnapshot {
    content: string;
    parts?: Array<Record<string, unknown>>;
    usage?: ChatTurnUsage;
    model?: string;
}
/** Product-tunable cadence. Defaults are stated on each field; a product with
 *  a chattier or heavier workload moves them without forking the writer. */
export interface DraftPersistenceTuning {
    /** Minimum wall-clock gap between draft writes, in ms. Default 2000.
     *
     *  Justification for 2 s, from a measured tool-heavy production run (517
     *  stream events over ~90 s wall = ~5.7 events/s): a 2 s floor with the
     *  dirty gate turns 517 candidate writes into <= 45, while leaving the
     *  durable row at most 2 s stale — an order of magnitude below the time it
     *  takes a viewer to open a tab and render, so a late viewer never perceives
     *  the lag. Fleet arithmetic at 10k concurrent 60 s runs: <= 30 updates per
     *  run x 167 run-starts/s = ~334 row-updates/s spread over per-tenant
     *  shards. Lower it and write amplification grows with no perceptible
     *  freshness gain; raise it past ~5 s and a late viewer starts seeing a
     *  visibly truncated answer. */
    intervalMs?: number;
    /** Serialized-parts size (bytes) past which the interval backs off, so a
     *  turn accumulating a megabyte-scale `parts` blob does not rewrite it every
     *  interval. Default 262144 (256 KiB) -> interval x 2.5; ten times that ->
     *  interval x 5. The final write is never throttled. */
    backoffBytes?: number;
    /** Per-tool-part output cap applied to DRAFTS ONLY (bytes). A tool returning
     *  a large blob would otherwise be rewritten in full on every draft. The
     *  final write always carries the untruncated value. Default 32768 (32 KiB);
     *  0 disables truncation. */
    maxDraftToolOutputBytes?: number;
}
/** Define the inputs required to construct an assistant draft writer */
export interface AssistantDraftWriterOptions extends DraftPersistenceTuning {
    store: AssistantDraftStore;
    threadId: string;
    /** DETERMINISTIC row id for this turn's assistant message — the whole
     *  idempotency mechanism. Derived from the turn's existing identity
     *  (`deriveExecutionId` in the interactive lane, the turn id in the detached
     *  lane), so a re-entered turn addresses the SAME row: the writer looks the
     *  id up before its first insert and patches what it finds. */
    messageId: string;
    /** Read the producer's live accumulators. Returns null before the producer
     *  is resolved (the assembly defers box resolution into the first pull). */
    snapshot(): AssistantDraftSnapshot | null;
    /** Pre-persist text transform (`/redact`'s `redactPII`). Applied to the
     *  draft's scalar content AND every draft text part — parity with the final
     *  write, or incremental persistence would re-open the at-rest PII leak that
     *  transform closed, just seconds earlier and on every turn. */
    transformText?(text: string): string | Promise<string>;
    log?: (message: string, meta?: Record<string, unknown>) => void;
}
/** Coalescing writer that keeps one durable assistant row in step with a
 *  streaming turn. Created per turn; not reusable. */
export interface AssistantDraftWriter {
    /** Arm/trigger a draft write from one engine event. Synchronous by design —
     *  the write itself is fire-and-forget so the stream is never blocked on
     *  store latency. */
    notify(event: {
        type?: unknown;
    }): void;
    /** Stop drafting and settle any in-flight write. Called before the final
     *  write so a late draft can never clobber the authoritative row. */
    close(): Promise<void>;
    /** Write the AUTHORITATIVE completion values onto this turn's row —
     *  insert-or-patch under the same deterministic id, un-throttled and
     *  un-truncated. Errors propagate: the final write is the one that must not
     *  fail silently. Implies {@link close}. */
    finalize(values: AssistantRowValues): Promise<void>;
    /** The durable row this turn is writing, once one exists. */
    rowId(): string | undefined;
    /** Retract the row for a turn that produced nothing (mirrors the final
     *  write's empty-turn skip, which leaves no row at all today). Also retracts
     *  a row a PREVIOUS attempt left behind, so a re-entered turn that ends
     *  empty converges on "no row" rather than a stale partial. */
    discard(): Promise<void>;
    /** Diagnostics: how many draft writes actually reached the store. */
    writeCount(): number;
}
/** True when this event should arm a draft write. */
export declare function isDraftContentEvent(event: {
    type?: unknown;
}): boolean;
/** Build the coalescing draft writer for one turn. */
export declare function createAssistantDraftWriter(options: AssistantDraftWriterOptions): AssistantDraftWriter;
/** True when a store can support incremental persistence at all. Without
 *  `updateMessage` a draft row could never be patched, so the caller keeps
 *  today's exact single-write behavior. */
export declare function storeSupportsDraftPersistence(store: AssistantDraftStore): boolean;
/** The row id an `appendMessage` actually returned, or `null` when the store
 *  returned nothing usable. `ChatTurnMessageStore.appendMessage` is typed
 *  `Promise<unknown>` so a product adapter is free to resolve `void`; every
 *  caller that wants to NAME the row it just wrote has to read defensively.
 *
 *  Deliberately no fallback to a caller-assigned id — see `writeOnce`, which
 *  adds its own. A caller that let the store mint the id has nothing to fall
 *  back TO, and guessing one would report a row that may not exist. */
export declare function rowIdOf(inserted: unknown): string | null;
/** The default deterministic assistant-row id for a turn. Readable on purpose
 *  (an operator grepping a transcript row id finds the run), and stable across
 *  re-entries because every input already is. */
export declare function assistantRowIdForTurn(turnKey: string): string;
