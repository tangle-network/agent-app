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

// ── identity / status ────────────────────────────────────────────────────────

/** Stable pointer at one version of one work product. */
export interface WorkProductRef {
  id: string
  version: number
}

export type WorkProductStatus =
  | 'draft' //              agent is emitting incrementally (queue: working)
  | 'blocked' //            unresolved blocking exception (queue: blocked / missing-info)
  | 'ready' //              submit_work_product accepted (queue: ready-for-review)
  | 'changes_requested' //  reviewer verdict; the correction re-enters chat as a turn
  | 'approved' //           reviewer sign-off on THIS version
  | 'superseded' //         a newer version replaced this one

const WORK_PRODUCT_STATUSES: readonly WorkProductStatus[] = [
  'draft',
  'blocked',
  'ready',
  'changes_requested',
  'approved',
  'superseded',
]

/** Runtime guard for re-validating a status read off a JSON boundary. */
export function isWorkProductStatus(value: unknown): value is WorkProductStatus {
  return typeof value === 'string' && (WORK_PRODUCT_STATUSES as readonly string[]).includes(value)
}

// ── artifact ─────────────────────────────────────────────────────────────────

/** Define the reviewable artifact body with its kind, sources, and structured field map */
export interface WorkProductArtifact {
  /** PARAMETER: 'return_package' | 'redline' | 'outreach_campaign' — validated
   *  against the product's `artifactKinds` vocabulary at submit. */
  kind: string
  title: string
  /** Vault/object-store ref for the rendered document (large bodies). */
  path?: string
  /** Inline body when small (markdown/JSON). */
  content?: string
  mediaType?: string
  /** Diff-first products (legal): the source document the artifact redlines. */
  baseline?: { path?: string; content?: string }
  /** The structured field map lineage targets anchor to (tax: form-line ids). */
  fields?: Record<string, unknown>
}

// ── evidence / lineage: source doc + locator → field/claim ───────────────────

/** A half-open `[start, end)` character range into the source document's text.
 *  Offsets index exactly the string the product's `readSourceText` seam
 *  returns for the same `sourceRef` — which is the string its document-reading
 *  tool pages with an `offset`. The PLATFORM slices `locator.quote` out of it,
 *  so a span citation cannot name text the document does not contain. */
export interface EvidenceSpan {
  start: number
  end: number
}

/** How `locator.quote` got there. Server-set on every path — never read from
 *  model args, because the whole value of the distinction is that a reviewer
 *  can trust it:
 *   - `span`  the platform sliced it out of the source bytes (unfalsifiable)
 *   - `model` the model supplied the text and the platform PROVED it occurs */
export type QuoteBasis = 'span' | 'model'

/** Point into a source document: page, free-form range, span, verbatim quote */
export interface EvidenceLocator {
  page?: number
  /** 'L120-L134' | 'B7' | '¶4' — free-form, non-empty when present. */
  range?: string
  /** Verbatim supporting quote from the source. Model-supplied and verified,
   *  or platform-sliced from {@link EvidenceLocator.span} — read `quoteBasis`
   *  to tell which. */
  quote?: string
  /** Character range the quote is sliced from. The preferred citation form:
   *  two integers cannot be a fabricated quote. */
  span?: EvidenceSpan
  /** Server-set provenance for `quote`; a model-supplied value is discarded. */
  quoteBasis?: QuoteBasis
}

/** One lineage row: a source document location supporting one artifact claim */
export interface EvidenceEntry {
  /** Agent-supplied stable id — the same id re-emitted is an upsert/replace. */
  id: string
  /** Vault path / attachment id / object-store key of the SOURCE document. */
  sourceRef: string
  locator: EvidenceLocator
  /** Artifact field/claim the evidence supports: '1040.line_9' |
   *  'clause:indemnification' | 'icp.employee_count' — product vocabulary. */
  target: string
  /** The value/assertion at the target. */
  claim: string
  /** 0..1; absent = unstated (never defaulted). */
  confidence?: number
}

// ── exceptions ───────────────────────────────────────────────────────────────

export type ExceptionSeverity = 'blocking' | 'material' | 'advisory'

/** One flagged problem with the work product, resolvable by agent or reviewer */
export interface ExceptionEntry {
  id: string
  severity: ExceptionSeverity
  /** PARAMETER: 'missing_document' | 'inconsistent_source' | … — validated
   *  against the product's `exceptionKinds` vocabulary. */
  kind: string
  message: string
  /** Affected artifact targets. */
  targets?: string[]
  resolved: boolean
  resolvedBy?: 'agent' | 'reviewer'
  resolutionNote?: string
}

/** Unresolved blocking exceptions are what park a work product in `blocked`. */
export function unresolvedBlockingExceptions(exceptions: readonly ExceptionEntry[]): ExceptionEntry[] {
  return exceptions.filter((entry) => entry.severity === 'blocking' && !entry.resolved)
}

// ── quality checks ───────────────────────────────────────────────────────────

/** One named quality verdict on the work product, tagged with who computed it */
export interface QualityCheck {
  id: string
  /** Product vocabulary: 'totals_reconcile', 'evidence_coverage', … */
  name: string
  passed: boolean
  detail?: string
  /** agent self-report | shell-computed | eval-ensemble verdict. */
  source: 'agent' | 'platform' | 'judge'
}

// ── provenance (the backtest spine) ──────────────────────────────────────────

/** The audit triple binding a work product to the exact configuration and run
 *  that produced it. `profileHash` is agent-eval's `agentProfileHash()` of the
 *  EXACT shipped profile — the same hash that keys scorecard cells, so a
 *  reviewer can see the measured backtest history of the configuration that
 *  produced the document. */
export interface WorkProductProvenance {
  profileHash: string
  /** Chat turnId or mission-step run id. */
  runId: string
  /** Back-filled from the usage receipt / serving-model header at turn
   *  completion — only the completed turn knows what actually served. */
  servingModels: string[]
  sessionId?: string
  missionRef?: { missionId: string; stepId: string }
  costUsd?: number
  producedAt: number
}

/** The product-resolved backtest summary for one profile hash (from its own
 *  eval artifacts via agent-eval's `loadScorecard`) — the shell defines only
 *  this TYPE and the `ProvenanceStamp` slot that renders it. */
export interface ProfileBacktestSummary {
  profileHash: string
  /** Backtest cases behind the composite. */
  cases: number
  composite: number
  /** The eval-campaign trust gate's verdict on whether the composite is
   *  allowed to be believed; 'fail' renders as "quality: unverified". */
  trust: 'pass' | 'fail'
  trustReasons: string[]
}

// ── version history ──────────────────────────────────────────────────────────

/** Frozen milestone row for one version of the work product */
export interface WorkProductVersionEntry {
  version: number
  status: WorkProductStatus
  provenance: WorkProductProvenance
  /** Frozen snapshot ref of this version's body (object-store key) — the
   *  DiffView input for vN-1 vs vN. */
  artifactPath?: string
  reviewedBy?: string
  reviewNote?: string
  at: number
}

// ── the durable row ──────────────────────────────────────────────────────────

/** Define the durable work product row accumulating artifact, lineage, exceptions, checks, and history */
export interface WorkProductRecord {
  /** Minted server-side; the model NEVER supplies ids — it addresses work by
   *  `scopeKey`. */
  id: string
  workspaceId: string
  /** The chat thread that drives it (chat stays first). */
  threadId: string | null
  /** Product engagement key: 'return:acme:2025' | 'contract:acme-msa' |
   *  'campaign:cpa-pilots'. */
  scopeKey: string
  status: WorkProductStatus
  version: number
  /** `null` while the draft accumulates (evidence streams in before the
   *  artifact arrives); non-null from the submit transition onward. Typed
   *  honestly rather than forcing a placeholder artifact on every draft. */
  artifact: WorkProductArtifact | null
  evidence: EvidenceEntry[]
  exceptions: ExceptionEntry[]
  checks: QualityCheck[]
  provenance: WorkProductProvenance
  history: WorkProductVersionEntry[]
  createdAt: number
  updatedAt: number
}

// ── store port — the /missions MissionStorePort pattern ──────────────────────

/** Fields a guarded write compares against the values the caller read. An
 *  absent field is unguarded. A SQL implementation compares like-for-like
 *  scalar columns; the in-memory store does the same. */
export interface WorkProductUpdateGuard {
  status?: WorkProductStatus
  version?: number
}

/** Fields a guarded write sets when the guard holds. */
export interface WorkProductPatch {
  status?: WorkProductStatus
  version?: number
  artifact?: WorkProductArtifact
  evidence?: EvidenceEntry[]
  exceptions?: ExceptionEntry[]
  checks?: QualityCheck[]
  provenance?: WorkProductProvenance
  history?: WorkProductVersionEntry[]
  updatedAt?: number
}

/** One audit-trail row, appended after every committed state change. */
export interface WorkProductAuditEvent {
  workProductId: string
  workspaceId: string
  /** Machine-readable transition name ('wp.created' | 'wp.evidence' |
   *  'wp.ready' | 'wp.verdict' | …). */
  step: string
  message: string
  metadata: Record<string, unknown>
  at: number
}

/**
 * Persistence seam — the product implements this over its own tables. The
 * invariant the implementation MUST keep: `update` applies `patch` ONLY when
 * every guard field still equals the stored value, and returns `null` when
 * the guard misses — a typed conflict, never a clobber.
 */
export interface WorkProductStorePort {
  load(id: string): Promise<WorkProductRecord | null>
  /** The scope's single OPEN accumulator row — status `draft` or `blocked` —
   *  or null when the scope has only reviewed/terminal rows (or none). The
   *  `changes_requested` row is found via {@link listByWorkspace}; reopening
   *  it is the service's job. */
  findDraft(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>
  listByWorkspace(workspaceId: string, opts?: { status?: WorkProductStatus[] }): Promise<WorkProductRecord[]>
  /** `extras` are opaque product-column values written in the SAME statement
   *  as the record (single-write creation), or ignored when the table has no
   *  extra columns. */
  insert(record: WorkProductRecord, extras?: Record<string, unknown>): Promise<WorkProductRecord>
  /** CAS: apply `patch` ONLY when guard fields equal stored values; null on a
   *  miss — typed conflict, never a clobber. */
  update(id: string, guard: WorkProductUpdateGuard, patch: WorkProductPatch): Promise<WorkProductRecord | null>
  appendEvent(event: WorkProductAuditEvent): Promise<void>
}

// ── input codecs (strict, named-field errors) ────────────────────────────────

/** Validation result whose failure names the exact field, so a tool layer can
 *  hand the model a correctable error it can act on. */
export type WorkProductParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; field: string; error: string }

function fail<T>(field: string, error: string): WorkProductParseResult<T> {
  return { ok: false, field, error }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Validate one raw evidence entry field-by-field. `path` prefixes the failure
 *  field name (e.g. `entries[3]`) so batched calls name the exact offender. */
export function parseEvidenceInput(raw: unknown, path = 'entry'): WorkProductParseResult<EvidenceEntry> {
  const record = asRecord(raw)
  if (!record) return fail(path, 'must be an object')
  if (!nonEmptyString(record.id)) return fail(`${path}.id`, 'must be a non-empty string (stable per entry; re-emitting the same id replaces it)')
  if (!nonEmptyString(record.sourceRef)) return fail(`${path}.sourceRef`, 'must be a non-empty source document ref')
  if (!nonEmptyString(record.target)) return fail(`${path}.target`, 'must name the artifact field/claim this evidence supports')
  if (!nonEmptyString(record.claim)) return fail(`${path}.claim`, 'must state the value/assertion at the target')
  const locatorRaw = record.locator === undefined ? {} : asRecord(record.locator)
  if (!locatorRaw) return fail(`${path}.locator`, 'must be an object when present')
  const locator: EvidenceLocator = {}
  if (locatorRaw.page !== undefined) {
    if (typeof locatorRaw.page !== 'number' || !Number.isFinite(locatorRaw.page)) {
      return fail(`${path}.locator.page`, 'must be a finite number when present')
    }
    locator.page = locatorRaw.page
  }
  if (locatorRaw.range !== undefined) {
    if (!nonEmptyString(locatorRaw.range)) return fail(`${path}.locator.range`, 'must be a non-empty string when present')
    locator.range = locatorRaw.range
  }
  if (locatorRaw.quote !== undefined) {
    if (typeof locatorRaw.quote !== 'string') return fail(`${path}.locator.quote`, 'must be a string when present')
    locator.quote = locatorRaw.quote
  }
  if (locatorRaw.span !== undefined) {
    const spanRaw = asRecord(locatorRaw.span)
    if (!spanRaw) return fail(`${path}.locator.span`, 'must be an object { start, end } when present')
    for (const field of ['start', 'end'] as const) {
      const value = spanRaw[field]
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return fail(`${path}.locator.span.${field}`, 'must be a non-negative integer character offset')
      }
    }
    if ((spanRaw.end as number) <= (spanRaw.start as number)) {
      return fail(`${path}.locator.span`, `end (${String(spanRaw.end)}) must be greater than start (${String(spanRaw.start)}) — the range is half-open [start, end)`)
    }
    locator.span = { start: spanRaw.start as number, end: spanRaw.end as number }
  }
  // `quoteBasis` is server-set. A model-supplied value is DROPPED rather than
  // rejected: it is not a correctable mistake the model should burn a turn on,
  // and silently honouring it would let a model label an unverified quote
  // 'span'. The tool layer stamps the real basis after resolution.
  const entry: EvidenceEntry = {
    id: (record.id as string).trim(),
    sourceRef: (record.sourceRef as string).trim(),
    locator,
    target: (record.target as string).trim(),
    claim: record.claim as string,
  }
  if (record.confidence !== undefined) {
    if (typeof record.confidence !== 'number' || !(record.confidence >= 0 && record.confidence <= 1)) {
      return fail(`${path}.confidence`, 'must be a number in 0..1 when present')
    }
    entry.confidence = record.confidence
  }
  return { ok: true, value: entry }
}

const EXCEPTION_SEVERITIES: readonly ExceptionSeverity[] = ['blocking', 'material', 'advisory']

/** Validate one raw exception entry field-by-field. Kind MEMBERSHIP in the
 *  product vocabulary is the tool layer's check (it owns the config). */
export function parseExceptionInput(raw: unknown, path = 'exception'): WorkProductParseResult<ExceptionEntry> {
  const record = asRecord(raw)
  if (!record) return fail(path, 'must be an object')
  if (!nonEmptyString(record.id)) return fail(`${path}.id`, 'must be a non-empty string (stable per entry; re-emitting the same id replaces it)')
  if (!EXCEPTION_SEVERITIES.includes(record.severity as ExceptionSeverity)) {
    return fail(`${path}.severity`, `must be one of: ${EXCEPTION_SEVERITIES.join(', ')}`)
  }
  if (!nonEmptyString(record.kind)) return fail(`${path}.kind`, 'must be a non-empty exception kind')
  if (!nonEmptyString(record.message)) return fail(`${path}.message`, 'must describe the problem')
  const entry: ExceptionEntry = {
    id: (record.id as string).trim(),
    severity: record.severity as ExceptionSeverity,
    kind: (record.kind as string).trim(),
    message: record.message as string,
    resolved: record.resolved === true,
  }
  if (record.targets !== undefined) {
    if (!Array.isArray(record.targets) || !record.targets.every(nonEmptyString)) {
      return fail(`${path}.targets`, 'must be an array of non-empty strings when present')
    }
    entry.targets = record.targets as string[]
  }
  if (record.resolvedBy !== undefined) {
    if (record.resolvedBy !== 'agent' && record.resolvedBy !== 'reviewer') {
      return fail(`${path}.resolvedBy`, "must be 'agent' or 'reviewer' when present")
    }
    entry.resolvedBy = record.resolvedBy
  }
  if (record.resolutionNote !== undefined) {
    if (typeof record.resolutionNote !== 'string') return fail(`${path}.resolutionNote`, 'must be a string when present')
    entry.resolutionNote = record.resolutionNote
  }
  return { ok: true, value: entry }
}

/** Validate a raw artifact. Kind MEMBERSHIP in `artifactKinds` is the tool
 *  layer's check. An artifact must carry a body: at least one of `path`,
 *  `content`, or `fields`. */
export function parseArtifactInput(raw: unknown, path = 'artifact'): WorkProductParseResult<WorkProductArtifact> {
  const record = asRecord(raw)
  if (!record) return fail(path, 'must be an object')
  if (!nonEmptyString(record.kind)) return fail(`${path}.kind`, 'must be a non-empty artifact kind')
  if (!nonEmptyString(record.title)) return fail(`${path}.title`, 'must be a non-empty title')
  for (const key of ['path', 'content', 'mediaType'] as const) {
    if (record[key] !== undefined && !nonEmptyString(record[key])) {
      return fail(`${path}.${key}`, 'must be a non-empty string when present')
    }
  }
  let baseline: WorkProductArtifact['baseline']
  if (record.baseline !== undefined) {
    const baselineRecord = asRecord(record.baseline)
    if (!baselineRecord) return fail(`${path}.baseline`, 'must be an object when present')
    baseline = {}
    if (baselineRecord.path !== undefined) {
      if (!nonEmptyString(baselineRecord.path)) return fail(`${path}.baseline.path`, 'must be a non-empty string when present')
      baseline.path = (baselineRecord.path as string).trim()
    }
    if (baselineRecord.content !== undefined) {
      if (typeof baselineRecord.content !== 'string') return fail(`${path}.baseline.content`, 'must be a string when present')
      baseline.content = baselineRecord.content
    }
  }
  let fields: Record<string, unknown> | undefined
  if (record.fields !== undefined) {
    const fieldsRecord = asRecord(record.fields)
    if (!fieldsRecord) return fail(`${path}.fields`, 'must be an object when present')
    fields = fieldsRecord
  }
  if (record.path === undefined && record.content === undefined && fields === undefined) {
    return fail(path, 'must carry a body: at least one of path, content, or fields')
  }
  const artifact: WorkProductArtifact = {
    kind: (record.kind as string).trim(),
    title: (record.title as string).trim(),
  }
  if (record.path !== undefined) artifact.path = (record.path as string).trim()
  if (record.content !== undefined) artifact.content = record.content as string
  if (record.mediaType !== undefined) artifact.mediaType = (record.mediaType as string).trim()
  if (baseline !== undefined) artifact.baseline = baseline
  if (fields !== undefined) artifact.fields = fields
  return { ok: true, value: artifact }
}

/** Agent self-reported check input for `submit_work_product` (persisted with
 *  `source: 'agent'`; `platform`/`judge` sources are never model-suppliable). */
export interface AgentCheckInput {
  id: string
  name: string
  passed: boolean
  detail?: string
}

/** Validate one agent self-check ensuring identifiers, verdict flag, and optional detail are well formed */
export function parseAgentCheckInput(raw: unknown, path = 'check'): WorkProductParseResult<AgentCheckInput> {
  const record = asRecord(raw)
  if (!record) return fail(path, 'must be an object')
  if (!nonEmptyString(record.id)) return fail(`${path}.id`, 'must be a non-empty string')
  if (!nonEmptyString(record.name)) return fail(`${path}.name`, 'must be a non-empty check name')
  if (typeof record.passed !== 'boolean') return fail(`${path}.passed`, 'must be a boolean')
  const check: AgentCheckInput = {
    id: (record.id as string).trim(),
    name: (record.name as string).trim(),
    passed: record.passed,
  }
  if (record.detail !== undefined) {
    if (typeof record.detail !== 'string') return fail(`${path}.detail`, 'must be a string when present')
    check.detail = record.detail
  }
  return { ok: true, value: check }
}

// ── chat transcript anchor (system-authored) ─────────────────────────────────

/**
 * The persisted `type:'work_product'` transcript anchor — the chat card that
 * keeps chat the driver surface for review. The PLATFORM writes it on the
 * ready transition (and updates it on a verdict); no prompt ever teaches an
 * agent to author one. `/chat-store` aliases this as `ChatWorkProductPart` in
 * its stored-part union, exactly like the `interaction`/`plan` members.
 */
export interface WorkProductPersistedPart {
  type: 'work_product'
  ref: WorkProductRef
  kind: string
  title: string
  status: WorkProductStatus
}

/** Project the transcript anchor part from a record. Requires the submitted
 *  artifact (the anchor is written on the ready transition, after which
 *  `artifact` is always non-null); falls back to the scopeKey label for
 *  defensive callers on an accumulating draft. */
export function workProductToPersistedPart(record: WorkProductRecord): WorkProductPersistedPart {
  return {
    type: 'work_product',
    ref: { id: record.id, version: record.version },
    kind: record.artifact?.kind ?? '',
    title: record.artifact?.title ?? record.scopeKey,
    status: record.status,
  }
}

/** Re-validate a stored/wire part into the typed anchor; null for junk. */
export function persistedPartToWorkProduct(part: Record<string, unknown>): WorkProductPersistedPart | null {
  if (!part || part.type !== 'work_product') return null
  const ref = asRecord(part.ref)
  if (!ref || !nonEmptyString(ref.id) || typeof ref.version !== 'number' || !Number.isFinite(ref.version)) return null
  if (typeof part.kind !== 'string' || !nonEmptyString(part.title) || !isWorkProductStatus(part.status)) return null
  return {
    type: 'work_product',
    ref: { id: ref.id as string, version: ref.version },
    kind: part.kind,
    title: part.title as string,
    status: part.status,
  }
}
