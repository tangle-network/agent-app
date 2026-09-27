/**
 * The guarded work-product status machine — the `/missions` service PATTERN
 * (load → validate against a transition table → CAS-write guarded on what was
 * read → audit event) over {@link WorkProductStorePort}. Deliberately NOT a
 * reuse of the mission service: missions' cursor/plan/budget machinery does
 * not apply here, and the six-status review machine is a different contract.
 *
 * Concurrency contract: a scope's draft is driven by a single serialized turn
 * owner, so real contention is rare. The service is the typed guard layer,
 * not a serializer — every mutation re-reads the record and CAS-writes
 * guarded on the `{status, version}` it read. A guard miss surfaces as
 * `{ succeeded: false, conflict: true }` (retryable: re-read and re-apply),
 * never a silent clobber.
 */
import { type EvidenceEntry, type ExceptionEntry, type QualityCheck, type WorkProductArtifact, type WorkProductAuditEvent, type WorkProductProvenance, type WorkProductRecord, type WorkProductStatus, type WorkProductStorePort } from './types';
/** Discriminated outcome for guarded operations — `conflict` distinguishes a
 *  lost guarded race (retryable) from a logic rejection (illegal edge,
 *  missing row — deterministic, never retried). */
export type WorkProductOutcome<T> = {
    succeeded: true;
    value: T;
} | {
    succeeded: false;
    error: string;
    conflict: boolean;
};
/** Whether a legal edge exists from `from` to `to` in the review machine. */
export declare function canTransitionWorkProduct(from: WorkProductStatus, to: WorkProductStatus): boolean;
/** Statuses a work product can never leave. */
export declare function isWorkProductTerminal(status: WorkProductStatus): boolean;
/** Define the input required to create a new draft work product row */
export interface CreateWorkProductInput {
    /** Explicit row id — omit to use the service's generator. The MODEL never
     *  supplies ids; this is for deterministic server-side creation. */
    id?: string;
    workspaceId: string;
    threadId: string | null;
    scopeKey: string;
    /** Version this draft will become; default 1. The tool layer passes
     *  `last reviewed version + 1` when a scope is re-engaged after approval. */
    version?: number;
    provenance: WorkProductProvenance;
    /** Opaque product-column values handed VERBATIM to the store's insert. */
    extras?: Record<string, unknown>;
}
/** Payload for the draft→ready submit transition */
export interface SubmitWorkProductInput {
    artifact: WorkProductArtifact;
    checks: QualityCheck[];
    provenance: WorkProductProvenance;
    /** Frozen snapshot ref of this version's body for the history entry;
     *  defaults to `artifact.path`. */
    artifactPath?: string;
}
/** Reviewer verdict payload for the ready→approved / ready→changes_requested transition */
export interface WorkProductVerdictInput {
    verdict: 'approve' | 'request_changes';
    reviewedBy: string;
    note?: string;
}
/** Guarded mutation surface over the work-product store */
export interface WorkProductService {
    create(input: CreateWorkProductInput): Promise<WorkProductRecord>;
    get(id: string): Promise<WorkProductRecord | null>;
    /** The scope's open accumulator row (`draft`/`blocked`), or null. */
    openDraft(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>;
    /** The scope's `changes_requested` row awaiting its correction turn, or null. */
    awaitingCorrection(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>;
    /** The scope's `ready` row awaiting review, or null. */
    awaitingReview(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>;
    /** `max(version over the scope's approved/superseded rows) + 1` — the
     *  version a fresh draft for the scope should carry. */
    nextVersion(workspaceId: string, scopeKey: string): Promise<number>;
    /** Re-open a `changes_requested` row as the next draft: version bumps +1
     *  and the correction turn accumulates into the same scope row. */
    reopen(id: string): Promise<WorkProductOutcome<WorkProductRecord>>;
    /** Merge evidence entries by id AND by what they assert (target + source +
     *  claim), so re-stating a fact already recorded replaces it under whatever
     *  id this batch minted rather than appending a near-copy. Legal only while
     *  `draft`/`blocked`. */
    upsertEvidence(id: string, entries: readonly EvidenceEntry[]): Promise<WorkProductOutcome<WorkProductRecord>>;
    /** Merge exception entries by id, then reconcile the blocked flag: any
     *  unresolved blocking entry parks `draft`→`blocked`; resolving the last
     *  one releases `blocked`→`draft`. */
    upsertExceptions(id: string, entries: readonly ExceptionEntry[]): Promise<WorkProductOutcome<WorkProductRecord>>;
    /** Persist a checks array without transitioning — how a failed platform
     *  gate (e.g. evidence_coverage) stays visible on the still-draft row. */
    recordChecks(id: string, checks: readonly QualityCheck[]): Promise<WorkProductOutcome<WorkProductRecord>>;
    /** The terminal agent call: CAS `draft`→`ready` with artifact + checks +
     *  provenance, appending the version-history entry. Refuses while an
     *  unresolved blocking exception exists. */
    submit(id: string, input: SubmitWorkProductInput): Promise<WorkProductOutcome<WorkProductRecord>>;
    /** Reviewer verdict: CAS `ready`→`approved`/`changes_requested` + history
     *  entry. Approval also supersedes the scope's prior approved versions so
     *  exactly one approved version is current per scope. */
    applyVerdict(id: string, input: WorkProductVerdictInput): Promise<WorkProductOutcome<WorkProductRecord>>;
    /** Explicit replacement: CAS to `superseded` (legal from ready /
     *  changes_requested / approved). */
    supersede(id: string): Promise<WorkProductOutcome<WorkProductRecord>>;
}
/** Configuration options for creating a work product service */
export interface WorkProductServiceOptions {
    store: WorkProductStorePort;
    /** Injectable clock (epoch ms). Default `Date.now`. */
    now?: () => number;
    /** Row-id generator. Default `crypto.randomUUID()`. */
    generateId?: () => string;
}
/** Create the guarded work-product service over a store port */
export declare function createWorkProductService(options: WorkProductServiceOptions): WorkProductService;
/** In-memory store surface with audit trail access and unguarded direct writes for tests */
export interface InMemoryWorkProductStore extends WorkProductStorePort {
    /** The full audit trail, append order. */
    events(): WorkProductAuditEvent[];
    /** Unguarded direct write — simulates a concurrent owner in tests. */
    put(record: WorkProductRecord): void;
}
/**
 * In-memory {@link WorkProductStorePort} — the portable backend for tests and
 * reference assemblies. Records are deep-copied on every boundary so callers
 * can never mutate stored state around the guards.
 */
export declare function createInMemoryWorkProductStore(): InMemoryWorkProductStore;
