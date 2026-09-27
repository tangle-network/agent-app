/** Read-side checkpoints for native chat NDJSON. This never submits or cancels work. */
export interface TurnObservation {
    schema: 'turn-observation-v1';
    streamId: string | null;
    /** Replay ordinals only. Unsequenced live frames cannot advance this cursor. */
    lastSeq: number;
    outcome: 'completed' | 'failed' | null;
    replayStatus: string | null;
    eventCount: number;
}
export declare function parseTurnObservation(value?: unknown): TurnObservation;
export interface TurnObservationUpdate {
    checkpoint: TurnObservation;
    /** False only for an already-checkpointed replay ordinal. */
    accepted: boolean;
    event: Record<string, unknown>;
}
/** Reduce an observed frame. Ordered replay gaps are errors, not silent lost work. */
export declare function observeTurnEvent(previous: TurnObservation, raw: unknown): TurnObservationUpdate;
export interface ConsumeTurnStreamOptions {
    checkpoint?: TurnObservation;
    /** Commit evidence and its checkpoint durably before acknowledging this frame. */
    commit(update: TurnObservationUpdate): Promise<void>;
    /** Bound untrusted frame memory, not total run duration or total transcript size. */
    maxFrameBytes?: number;
}
/**
 * Consume one viewing connection. EOF without a terminal event stays incomplete.
 * A disconnect/abort propagates; the last committed checkpoint remains resumable.
 * The caller owns network observation windows separately from execution deadlines.
 */
export declare function consumeTurnStream(body: AsyncIterable<Uint8Array>, options: ConsumeTurnStreamOptions): Promise<TurnObservation>;
