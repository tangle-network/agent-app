/**
 * The reviewable work-product contract — the one durable object every Tangle
 * agent product converges on: an artifact plus its evidence map (source→field
 * lineage), exceptions, quality checks, version history, and run provenance,
 * produced by an agent and signed off by a professional.
 *
 * Import-free and client-safe by construction: the queue projection and the
 * React surfaces re-validate these shapes at JSON boundaries, so every type
 * and codec here must load in a browser bundle. Every domain word — artifact
 * `kind`, evidence `target`, exception `kind`, check `name`, `scopeKey`
 * format — is a STRING PARAMETER validated against product-supplied
 * vocabularies in the tool layer; nothing domain-specific is baked here.
 */
/** Stable pointer at one version of one work product. */
export interface WorkProductRef {
    id: string;
    version: number;
}
export type WorkProductStatus = 'draft' | 'blocked' | 'ready' | 'changes_requested' | 'approved' | 'superseded';
/** Runtime guard for re-validating a status read off a JSON boundary. */
export declare function isWorkProductStatus(value: unknown): value is WorkProductStatus;
/** Define the reviewable artifact body with its kind, sources, and structured field map */
export interface WorkProductArtifact {
    /** PARAMETER: 'return_package' | 'redline' | 'outreach_campaign' — validated
     *  against the product's `artifactKinds` vocabulary at submit. */
    kind: string;
    title: string;
    /** Vault/object-store ref for the rendered document (large bodies). */
    path?: string;
    /** Inline body when small (markdown/JSON). */
    content?: string;
    mediaType?: string;
    /** Diff-first products (legal): the source document the artifact redlines. */
    baseline?: {
        path?: string;
        content?: string;
    };
    /** The structured field map lineage targets anchor to (tax: form-line ids). */
    fields?: Record<string, unknown>;
}
/** A half-open `[start, end)` character range into the source document's text.
 *  Offsets index exactly the string the product's `readSourceText` seam
 *  returns for the same `sourceRef` — which is the string its document-reading
 *  tool pages with an `offset`. The PLATFORM slices `locator.quote` out of it,
 *  so a span citation cannot name text the document does not contain. */
export interface EvidenceSpan {
    start: number;
    end: number;
}
/** How `locator.quote` got there. Server-set on every path — never read from
 *  model args, because the whole value of the distinction is that a reviewer
 *  can trust it:
 *   - `span`  the platform sliced it out of the source bytes (unfalsifiable)
 *   - `model` the model supplied the text and the platform PROVED it occurs */
export type QuoteBasis = 'span' | 'model';
/** Point into a source document: page, free-form range, span, verbatim quote */
export interface EvidenceLocator {
    page?: number;
    /** 'L120-L134' | 'B7' | '¶4' — free-form, non-empty when present. */
    range?: string;
    /** Verbatim supporting quote from the source. Model-supplied and verified,
     *  or platform-sliced from {@link EvidenceLocator.span} — read `quoteBasis`
     *  to tell which. */
    quote?: string;
    /** Character range the quote is sliced from. Correct when the offsets are
     *  computed by a tool; see {@link EvidenceLocator.find} for the form a model
     *  should use, because models do not count characters reliably. */
    span?: EvidenceSpan;
    /** The value or distinctive text to LOCATE in the source. The platform finds
     *  the line containing it and derives both `span` and `quote` from that —
     *  so the model neither retypes the quote nor computes an offset, and a
     *  citation that lands on the wrong line becomes unrepresentable rather than
     *  merely wrong. The preferred citation form for an agent. */
    find?: string;
    /** Which occurrence of `find` to cite when the value appears more than once
     *  (1-based, default 1). */
    findOccurrence?: number;
    /** Server-set provenance for `quote`; a model-supplied value is discarded. */
    quoteBasis?: QuoteBasis;
}
/** One lineage row: a source document location supporting one artifact claim */
export interface EvidenceEntry {
    /** Agent-supplied stable id — the same id re-emitted is an upsert/replace. */
    id: string;
    /** Vault path / attachment id / object-store key of the SOURCE document. */
    sourceRef: string;
    locator: EvidenceLocator;
    /** Artifact field/claim the evidence supports: '1040.line_9' |
     *  'clause:indemnification' | 'icp.employee_count' — product vocabulary. */
    target: string;
    /** The value/assertion at the target. */
    claim: string;
    /** 0..1; absent = unstated (never defaulted). */
    confidence?: number;
}
export type ExceptionSeverity = 'blocking' | 'material' | 'advisory';
/** One flagged problem with the work product, resolvable by agent or reviewer */
export interface ExceptionEntry {
    id: string;
    severity: ExceptionSeverity;
    /** PARAMETER: 'missing_document' | 'inconsistent_source' | … — validated
     *  against the product's `exceptionKinds` vocabulary. */
    kind: string;
    message: string;
    /** Affected artifact targets. */
    targets?: string[];
    resolved: boolean;
    resolvedBy?: 'agent' | 'reviewer';
    resolutionNote?: string;
}
/** Unresolved blocking exceptions are what park a work product in `blocked`. */
export declare function unresolvedBlockingExceptions(exceptions: readonly ExceptionEntry[]): ExceptionEntry[];
/** One named quality verdict on the work product, tagged with who computed it */
export interface QualityCheck {
    id: string;
    /** Product vocabulary: 'totals_reconcile', 'evidence_coverage', … */
    name: string;
    passed: boolean;
    detail?: string;
    /** agent self-report | shell-computed | eval-ensemble verdict. */
    source: 'agent' | 'platform' | 'judge';
}
/** The audit triple binding a work product to the exact configuration and run
 *  that produced it. `profileHash` is agent-eval's `agentProfileHash()` of the
 *  EXACT shipped profile — the same hash that keys scorecard cells, so a
 *  reviewer can see the measured backtest history of the configuration that
 *  produced the document. */
export interface WorkProductProvenance {
    profileHash: string;
    /** Chat turnId or mission-step run id. */
    runId: string;
    /** Back-filled from the usage receipt / serving-model header at turn
     *  completion — only the completed turn knows what actually served. */
    servingModels: string[];
    sessionId?: string;
    missionRef?: {
        missionId: string;
        stepId: string;
    };
    costUsd?: number;
    producedAt: number;
}
/** The product-resolved backtest summary for one profile hash (from its own
 *  eval artifacts via agent-eval's `loadScorecard`) — the shell defines only
 *  this TYPE and the `ProvenanceStamp` slot that renders it. */
export interface ProfileBacktestSummary {
    profileHash: string;
    /** Backtest cases behind the composite. */
    cases: number;
    composite: number;
    /** The eval-campaign trust gate's verdict on whether the composite is
     *  allowed to be believed; 'fail' renders as "quality: unverified". */
    trust: 'pass' | 'fail';
    trustReasons: string[];
}
/** Frozen milestone row for one version of the work product */
export interface WorkProductVersionEntry {
    version: number;
    status: WorkProductStatus;
    provenance: WorkProductProvenance;
    /** Frozen snapshot ref of this version's body (object-store key) — the
     *  DiffView input for vN-1 vs vN. */
    artifactPath?: string;
    reviewedBy?: string;
    reviewNote?: string;
    at: number;
}
/** Define the durable work product row accumulating artifact, lineage, exceptions, checks, and history */
export interface WorkProductRecord {
    /** Minted server-side; the model NEVER supplies ids — it addresses work by
     *  `scopeKey`. */
    id: string;
    workspaceId: string;
    /** The chat thread that drives it (chat stays first). */
    threadId: string | null;
    /** Product engagement key: 'return:acme:2025' | 'contract:acme-msa' |
     *  'campaign:cpa-pilots'. */
    scopeKey: string;
    status: WorkProductStatus;
    version: number;
    /** `null` while the draft accumulates (evidence streams in before the
     *  artifact arrives); non-null from the submit transition onward. Typed
     *  honestly rather than forcing a placeholder artifact on every draft. */
    artifact: WorkProductArtifact | null;
    evidence: EvidenceEntry[];
    exceptions: ExceptionEntry[];
    checks: QualityCheck[];
    provenance: WorkProductProvenance;
    history: WorkProductVersionEntry[];
    createdAt: number;
    updatedAt: number;
}
/** Fields a guarded write compares against the values the caller read. An
 *  absent field is unguarded. A SQL implementation compares like-for-like
 *  scalar columns; the in-memory store does the same. */
export interface WorkProductUpdateGuard {
    status?: WorkProductStatus;
    version?: number;
}
/** Fields a guarded write sets when the guard holds. */
export interface WorkProductPatch {
    status?: WorkProductStatus;
    version?: number;
    artifact?: WorkProductArtifact;
    evidence?: EvidenceEntry[];
    exceptions?: ExceptionEntry[];
    checks?: QualityCheck[];
    provenance?: WorkProductProvenance;
    history?: WorkProductVersionEntry[];
    updatedAt?: number;
}
/** One audit-trail row, appended after every committed state change. */
export interface WorkProductAuditEvent {
    workProductId: string;
    workspaceId: string;
    /** Machine-readable transition name ('wp.created' | 'wp.evidence' |
     *  'wp.ready' | 'wp.verdict' | …). */
    step: string;
    message: string;
    metadata: Record<string, unknown>;
    at: number;
}
/**
 * Persistence seam — the product implements this over its own tables. The
 * invariant the implementation MUST keep: `update` applies `patch` ONLY when
 * every guard field still equals the stored value, and returns `null` when
 * the guard misses — a typed conflict, never a clobber.
 */
export interface WorkProductStorePort {
    load(id: string): Promise<WorkProductRecord | null>;
    /** The scope's single OPEN accumulator row — status `draft` or `blocked` —
     *  or null when the scope has only reviewed/terminal rows (or none). The
     *  `changes_requested` row is found via {@link listByWorkspace}; reopening
     *  it is the service's job. */
    findDraft(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>;
    listByWorkspace(workspaceId: string, opts?: {
        status?: WorkProductStatus[];
    }): Promise<WorkProductRecord[]>;
    /** `extras` are opaque product-column values written in the SAME statement
     *  as the record (single-write creation), or ignored when the table has no
     *  extra columns. */
    insert(record: WorkProductRecord, extras?: Record<string, unknown>): Promise<WorkProductRecord>;
    /** CAS: apply `patch` ONLY when guard fields equal stored values; null on a
     *  miss — typed conflict, never a clobber. */
    update(id: string, guard: WorkProductUpdateGuard, patch: WorkProductPatch): Promise<WorkProductRecord | null>;
    appendEvent(event: WorkProductAuditEvent): Promise<void>;
}
/** Validation result whose failure names the exact field, so a tool layer can
 *  hand the model a correctable error it can act on. */
export type WorkProductParseResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    field: string;
    error: string;
};
/** Validate one raw evidence entry field-by-field. `path` prefixes the failure
 *  field name (e.g. `entries[3]`) so batched calls name the exact offender. */
export declare function parseEvidenceInput(raw: unknown, path?: string): WorkProductParseResult<EvidenceEntry>;
/** Validate one raw exception entry field-by-field. Kind MEMBERSHIP in the
 *  product vocabulary is the tool layer's check (it owns the config). */
export declare function parseExceptionInput(raw: unknown, path?: string): WorkProductParseResult<ExceptionEntry>;
/** Validate a raw artifact. Kind MEMBERSHIP in `artifactKinds` is the tool
 *  layer's check. An artifact must carry a body: at least one of `path`,
 *  `content`, or `fields`. */
export declare function parseArtifactInput(raw: unknown, path?: string): WorkProductParseResult<WorkProductArtifact>;
/** Agent self-reported check input for `submit_work_product` (persisted with
 *  `source: 'agent'`; `platform`/`judge` sources are never model-suppliable). */
export interface AgentCheckInput {
    id: string;
    name: string;
    passed: boolean;
    detail?: string;
}
/** Validate one agent self-check ensuring identifiers, verdict flag, and optional detail are well formed */
export declare function parseAgentCheckInput(raw: unknown, path?: string): WorkProductParseResult<AgentCheckInput>;
/**
 * The persisted `type:'work_product'` transcript anchor — the chat card that
 * keeps chat the driver surface for review. The PLATFORM writes it on the
 * ready transition (and updates it on a verdict); no prompt ever teaches an
 * agent to author one. `/chat-store` aliases this as `ChatWorkProductPart` in
 * its stored-part union, exactly like the `interaction`/`plan` members.
 */
export interface WorkProductPersistedPart {
    type: 'work_product';
    ref: WorkProductRef;
    kind: string;
    title: string;
    status: WorkProductStatus;
}
/** Project the transcript anchor part from a record. Requires the submitted
 *  artifact (the anchor is written on the ready transition, after which
 *  `artifact` is always non-null); falls back to the scopeKey label for
 *  defensive callers on an accumulating draft. */
export declare function workProductToPersistedPart(record: WorkProductRecord): WorkProductPersistedPart;
/** Re-validate a stored/wire part into the typed anchor; null for junk. */
export declare function persistedPartToWorkProduct(part: Record<string, unknown>): WorkProductPersistedPart | null;
