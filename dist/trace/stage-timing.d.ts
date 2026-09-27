/** Structured, bounded latency records for one request or agent turn. */
export declare const STAGE_TIMING_EVENT = "stage_timing";
export declare const STAGE_TIMING_VERSION = 1;
export type StageTimingOutcome = 'ok' | 'error' | 'timeout' | 'skipped';
export type StageTimingKind = 'leaf' | 'span';
export type StageTimingDetailValue = string | number | boolean | null;
export interface StageTimingContext {
    runId: string;
    workspaceId?: string;
    threadId?: string;
    sandboxId?: string;
    model?: string;
    harness?: string;
    path?: string;
}
export interface StageTimingRecordInput {
    kind?: StageTimingKind;
    outcome?: StageTimingOutcome;
    attempt?: number;
    /** Bounded primitive operational metadata only. Do not pass user input or credentials. */
    detail?: Record<string, StageTimingDetailValue | undefined>;
}
export interface StageTimingRecord extends StageTimingContext {
    evt: typeof STAGE_TIMING_EVENT;
    v: typeof STAGE_TIMING_VERSION;
    stage: string;
    kind: StageTimingKind;
    startedAt: number;
    durationMs: number;
    outcome: StageTimingOutcome;
    attempt?: number;
    detail?: Record<string, StageTimingDetailValue>;
}
export interface StageTimingHandle {
    readonly startedAt: number;
    done(input?: StageTimingRecordInput): void;
    fail(error: unknown, input?: StageTimingRecordInput): void;
}
export interface StageTiming {
    readonly context: Readonly<StageTimingContext>;
    setContext(input: Partial<Omit<StageTimingContext, 'runId'>>): void;
    recordDuration(stage: string, startedAt: number, durationMs: number, input?: StageTimingRecordInput): void;
    start(stage: string, input?: StageTimingRecordInput): StageTimingHandle;
    measure<T>(stage: string, input: StageTimingRecordInput, operation: () => Promise<T>): Promise<T>;
}
export interface CreateStageTimingOptions {
    context?: Partial<StageTimingContext>;
    /** Carrier for a validated record. Throws and rejected promises are contained. */
    emit(record: StageTimingRecord): void | Promise<void>;
    /** Epoch-millisecond clock. Defaults to `Date.now`; clock failures drop the record. */
    now?(): number;
    /** ID seam used only when `context.runId` is absent. */
    createRunId?(): string;
}
/** Build one safe record, or return null when its required fields are invalid. */
export declare function buildStageTimingRecord(context: StageTimingContext, stage: string, startedAt: number, durationMs: number, input?: StageTimingRecordInput): StageTimingRecord | null;
/**
 * Create a stage timer with an injected carrier. Invalid records and carrier
 * failures are dropped because telemetry cannot decide request success.
 */
export declare function createStageTiming(options: CreateStageTimingOptions): StageTiming;
