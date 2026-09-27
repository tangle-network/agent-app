/**
 * Durable mission state — the guarded status machine for a multi-step agent run.
 *
 * A mission is a persisted plan (ordered steps), a cursor (count of completed
 * steps), a cost ledger + budget, and a status machine. This module owns the
 * legal transitions and the guarded mutation surface; it does NOT execute steps
 * (the engine in `./engine` does) and it does NOT own persistence — products
 * implement {@link MissionStorePort} over their own tables. Every state change
 * appends a {@link MissionAuditEvent} so the run timeline is a single durable
 * audit trail.
 *
 * Concurrency contract: a mission MUST be driven by a single serialized owner
 * (a Durable Object, a Cloudflare Workflow, a queue consumer — one per
 * mission). The service is the typed guard layer, not a serializer: every
 * mutation re-reads the record and asks the store for a compare-and-set write
 * guarded on the values it read. When the guard misses, the row changed under
 * us and the caller gets `{ succeeded: false, conflict: true }` — never a
 * silent clobber, never a stale overwrite.
 */
export type MissionStatus = 'scheduled' | 'running' | 'paused' | 'waiting_approval' | 'blocked' | 'succeeded' | 'failed' | 'aborted' | 'cancelled';
/** Define possible statuses for a mission step during its execution lifecycle */
export type MissionStepStatus = 'pending' | 'running' | 'waiting_approval' | 'done' | 'failed';
/** Define the structure and state details of a mission step within a workflow system */
export interface MissionStep {
    id: string;
    /** What the step should accomplish — an intent, never an implementation. */
    intent: string;
    /** Product-defined kind label. Labels intent for gating/UX; it never selects
     *  a different execution path. */
    kind: string;
    status: MissionStepStatus;
    /** Count of genuine `* -> running` edges (retries inflate this; idempotent
     *  re-asserts do not). */
    attempts: number;
    /** One-line live status surfaced on the step row ("7/15 refs"). */
    sublabel?: string;
    /** Small pointer at the produced artifact (vault path, asset id) — never the
     *  full payload. */
    resultRef?: string;
}
/** Define the structure for tracking mission token usage, cost, duration, and LLM call counts */
export interface MissionCostLedger {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    wallMs: number;
    llmCalls: number;
}
/** The durable mission row, shape-normalized. Timestamps are epoch ms. */
export interface MissionRecord {
    id: string;
    workspaceId: string;
    status: MissionStatus;
    /** Product-defined origin label ('chat', 'manual', 'cron', …). */
    trigger: string;
    summary: string | null;
    plan: MissionStep[];
    /** Count of durably-completed steps; the next step to run is `plan[cursor]`. */
    cursor: number;
    cost: MissionCostLedger | null;
    budgetUsd: number | null;
    spentUsd: number;
    pauseReason: string | null;
    /** The single owning engine's instance id, write-once (see `setEngineRef`). */
    engineRef: string | null;
    scheduledAt: number | null;
    startedAt: number;
    completedAt: number | null;
    metadata: Record<string, unknown> | null;
}
/**
 * Discriminated outcome for guarded operations. Callers MUST inspect
 * `succeeded` before reading `value` — illegal transitions and missing rows
 * surface here, never as a throw-and-swallow or a silent no-op. `conflict`
 * distinguishes a lost guarded race (retryable — re-read and re-apply) from a
 * logic rejection (illegal edge, missing step — deterministic, never retried).
 */
export type MissionOutcome<T> = {
    succeeded: true;
    value: T;
} | {
    succeeded: false;
    error: string;
    conflict: boolean;
};
/** Fields a guarded write compares against the values the caller read. A SQL
 *  implementation compares JSON columns as serialized text
 *  (`coalesce(col, 'null') = JSON.stringify(expected)`), matching how the
 *  in-memory store compares. An absent field is unguarded. */
export interface MissionUpdateGuard {
    status?: MissionStatus;
    cursor?: number;
    plan?: MissionStep[];
    cost?: MissionCostLedger | null;
    metadata?: Record<string, unknown> | null;
    /** Guard that no engine has bound yet (the write-once bind). */
    engineRefIsNull?: true;
}
/** Fields a guarded write sets when the guard holds. `null` values are real
 *  writes (clear the column), not skips. */
export interface MissionUpdatePatch {
    status?: MissionStatus;
    pauseReason?: string | null;
    summary?: string;
    completedAt?: number | null;
    plan?: MissionStep[];
    cursor?: number;
    cost?: MissionCostLedger;
    spentUsd?: number;
    metadata?: Record<string, unknown>;
    engineRef?: string;
}
/** One audit-trail row. Appended after every committed state change, so an
 *  event always denotes a real transition (no phantom rows on rejected or
 *  no-op calls). */
export interface MissionAuditEvent {
    missionId: string;
    workspaceId: string;
    level: 'info' | 'warn' | 'error';
    /** Machine-readable transition name ('mission.created', 'mission.step.done',
     *  'mission.cursor', 'mission.cost', 'mission.paused', …). */
    step: string;
    message: string;
    metadata: Record<string, unknown>;
    at: number;
}
/**
 * Persistence seam — the product implements this over its own tables. The
 * invariant the implementation MUST keep: `update` applies `patch` ONLY when
 * every guard field still equals the stored value, and returns `null` when the
 * guard misses. That null is how a concurrent write surfaces as a typed
 * failure instead of a clobber.
 */
export interface MissionStorePort {
    load(id: string): Promise<MissionRecord | null>;
    /** `extras` are the opaque product-column values from
     *  `CreateMissionInput.extras` — write them in the SAME statement as the
     *  record (single-write creation) or ignore them if the table has no extra
     *  columns. */
    insert(record: MissionRecord, extras?: Record<string, unknown>): Promise<MissionRecord>;
    update(id: string, guard: MissionUpdateGuard, patch: MissionUpdatePatch): Promise<MissionRecord | null>;
    appendEvent(event: MissionAuditEvent): Promise<void>;
}
/** Statuses a mission can never leave — the run is done. */
export declare function isMissionTerminal(status: MissionStatus): boolean;
/** The cooperative kill switch: a stop request rides metadata so it survives
 *  any status and is honored by the engine before the next side effect. */
export declare function isMissionStopRequested(mission: MissionRecord): boolean;
/** Define input parameters for creating a mission including optional deterministic id and unique plan steps */
export interface CreateMissionInput {
    /** Explicit row id. Omit to use the service's id generator. Pass a
     *  DETERMINISTIC id (derived from the originating turn) when the caller may
     *  re-create the same mission under at-least-once delivery — the duplicate
     *  insert then trips the store's uniqueness instead of spawning a second run. */
    id?: string;
    workspaceId: string;
    /** Becomes the mission summary. */
    title: string;
    /** Plan step ids MUST be unique: the owning workflow keys its durable step
     *  cache by step id, so a collision would silently replay the wrong result.
     *  A duplicate is rejected here (fail loud). */
    plan: MissionStep[];
    budgetUsd?: number | null;
    /** Epoch ms. Present → the mission starts `scheduled` instead of `running`. */
    scheduledAt?: number | null;
    trigger: string;
    /** Caller-defined context stamped onto the record (thread ids, source turn,
     *  model). Read back via `mission.metadata`; the engine only reads
     *  `stopRequested` from it. */
    metadata?: Record<string, unknown> | null;
    /**
     * Opaque product-column values handed VERBATIM to `MissionStorePort.insert`
     * (e.g. a `workflowId` FK on the product's mission table), so creation is a
     * single write — no post-insert stamp. The service never reads, validates,
     * or persists them itself; they exist only on the insert call.
     */
    extras?: Record<string, unknown>;
}
/** Define a patch to update the status and optional metadata of a step in a process */
export interface SetStepStatusPatch {
    sublabel?: string;
    resultRef?: string;
    error?: string;
    /**
     * Spend committed ATOMICALLY with the step transition. Folding the cost into
     * the SAME guarded write makes step completion the per-step idempotency key:
     * a same-status replay (the step is already `done`) short-circuits as a no-op
     * BEFORE the write, so the charge lands exactly once even when an engine
     * RESUME re-dispatches a step whose cost previously committed. `deltaUsd` is
     * the marginal spend; `ledgerDelta` carries the token/wall/llm breakdown.
     */
    cost?: {
        deltaUsd: number;
        ledgerDelta?: Partial<MissionCostLedger>;
    };
}
/** Define input parameters to complete a mission with status and optional summary */
export interface CompleteMissionInput {
    ok: boolean;
    summary?: string;
}
/** Define methods to create, retrieve, and update missions with controlled engine binding and metadata merging */
export interface MissionService {
    createMission(input: CreateMissionInput): Promise<MissionRecord>;
    getMission(id: string): Promise<MissionRecord | null>;
    /** Bind the executing engine's instance id, write-once from the single
     *  owner: re-asserting the same ref is a no-op; binding a DIFFERENT ref over
     *  an existing one is rejected so a second owner can never steal the run. */
    setEngineRef(id: string, engineRef: string): Promise<MissionOutcome<MissionRecord>>;
    /** Shallow-merge keys into metadata. Guarded on the metadata read, so racing
     *  merges surface as conflicts instead of silently dropping keys. */
    mergeMetadata(id: string, patch: Record<string, unknown>): Promise<MissionOutcome<MissionRecord>>;
    /** Mutate one plan step's status (+ optional sublabel/resultRef) and append a
     *  transition event. Rejects unknown steps and illegal step edges. Does NOT
     *  move the cursor — call `advanceCursor` for that. */
    setStepStatus(id: string, stepId: string, status: MissionStepStatus, patch?: SetStepStatusPatch): Promise<MissionOutcome<MissionRecord>>;
    /** Move the done-count cursor forward by one. Rejects advancing past the end
     *  of the plan so the caller learns the mission has no further work. */
    advanceCursor(id: string): Promise<MissionOutcome<MissionRecord>>;
    /** Increment spentUsd and merge a partial ledger into the cumulative ledger.
     *  `deltaUsd` is the marginal spend; `ledgerDelta` carries the token/wall/
     *  llm-call breakdown for the same unit of work. */
    addCost(id: string, deltaUsd: number, ledgerDelta?: Partial<MissionCostLedger>): Promise<MissionOutcome<MissionRecord>>;
    pause(id: string, reason: string): Promise<MissionOutcome<MissionRecord>>;
    resume(id: string): Promise<MissionOutcome<MissionRecord>>;
    abort(id: string): Promise<MissionOutcome<MissionRecord>>;
    /** Flip one step and the whole mission to waiting_approval together. The
     *  mission transition is validated FIRST so an illegal source is rejected
     *  without mutating the step — no half-applied state. */
    markWaitingApproval(id: string, stepId: string): Promise<MissionOutcome<MissionRecord>>;
    complete(id: string, input: CompleteMissionInput): Promise<MissionOutcome<MissionRecord>>;
}
/** Define options for configuring mission service behavior including storage, time, and ID generation */
export interface MissionServiceOptions {
    store: MissionStorePort;
    /** Injectable clock (epoch ms). Default `Date.now`. */
    now?: () => number;
    /**
     * Row-id generator when `CreateMissionInput.id` is omitted. Default
     * `crypto.randomUUID()` — a 36-char dashed UUID. Inject your own when your
     * mission table already has an id shape (e.g. 32-hex matching D1 row
     * defaults): the service stamps the generated id verbatim onto the inserted
     * record, so a mismatch with the rest of your schema surfaces only at the
     * product layer. Keep id shape parity here, not in the store.
     */
    generateId?: () => string;
}
/** Create a mission service that manages mission records and audit events with customizable options */
export declare function createMissionService(options: MissionServiceOptions): MissionService;
/** Define an in-memory mission store that tracks events and allows direct record writes */
export interface InMemoryMissionStore extends MissionStorePort {
    /** The full audit trail, append order. */
    events(): MissionAuditEvent[];
    /** Unguarded direct write — simulates a concurrent owner or a crash-shaped
     *  state in tests. Production writers go through the guarded `update`. */
    put(record: MissionRecord): void;
}
/**
 * In-memory {@link MissionStorePort} — the portable backend for tests and
 * sandbox/eval shells. Guard comparison uses JSON serialization of the read
 * value, the same contract a SQL implementation honors by comparing stored
 * JSON text. Records are deep-copied on every boundary so callers can never
 * mutate stored state around the guards.
 */
export declare function createInMemoryMissionStore(): InMemoryMissionStore;
