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

import { canonicalizeValue } from './claim-support'
import {
  unresolvedBlockingExceptions,
  type EvidenceEntry,
  type ExceptionEntry,
  type QualityCheck,
  type WorkProductArtifact,
  type WorkProductAuditEvent,
  type WorkProductPatch,
  type WorkProductProvenance,
  type WorkProductRecord,
  type WorkProductStatus,
  type WorkProductStorePort,
  type WorkProductVersionEntry,
} from './types'

/** Discriminated outcome for guarded operations — `conflict` distinguishes a
 *  lost guarded race (retryable) from a logic rejection (illegal edge,
 *  missing row — deterministic, never retried). */
export type WorkProductOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: string; conflict: boolean }

// Legal status transitions. A target absent from a source's set is rejected
// by the guarded helpers. `superseded` is terminal.
const WORK_PRODUCT_TRANSITIONS: Record<WorkProductStatus, ReadonlySet<WorkProductStatus>> = {
  draft: new Set<WorkProductStatus>(['blocked', 'ready']),
  blocked: new Set<WorkProductStatus>(['draft']),
  ready: new Set<WorkProductStatus>(['changes_requested', 'approved', 'superseded']),
  changes_requested: new Set<WorkProductStatus>(['draft', 'superseded']),
  approved: new Set<WorkProductStatus>(['superseded']),
  superseded: new Set<WorkProductStatus>(),
}

/** Whether a legal edge exists from `from` to `to` in the review machine. */
export function canTransitionWorkProduct(from: WorkProductStatus, to: WorkProductStatus): boolean {
  return WORK_PRODUCT_TRANSITIONS[from].has(to)
}

/** Statuses a work product can never leave. */
export function isWorkProductTerminal(status: WorkProductStatus): boolean {
  return WORK_PRODUCT_TRANSITIONS[status].size === 0
}

/** Define the input required to create a new draft work product row */
export interface CreateWorkProductInput {
  /** Explicit row id — omit to use the service's generator. The MODEL never
   *  supplies ids; this is for deterministic server-side creation. */
  id?: string
  workspaceId: string
  threadId: string | null
  scopeKey: string
  /** Version this draft will become; default 1. The tool layer passes
   *  `last reviewed version + 1` when a scope is re-engaged after approval. */
  version?: number
  provenance: WorkProductProvenance
  /** Opaque product-column values handed VERBATIM to the store's insert. */
  extras?: Record<string, unknown>
}

/** Payload for the draft→ready submit transition */
export interface SubmitWorkProductInput {
  artifact: WorkProductArtifact
  checks: QualityCheck[]
  provenance: WorkProductProvenance
  /** Frozen snapshot ref of this version's body for the history entry;
   *  defaults to `artifact.path`. */
  artifactPath?: string
}

/** Reviewer verdict payload for the ready→approved / ready→changes_requested transition */
export interface WorkProductVerdictInput {
  verdict: 'approve' | 'request_changes'
  reviewedBy: string
  note?: string
}

/** Guarded mutation surface over the work-product store */
export interface WorkProductService {
  create(input: CreateWorkProductInput): Promise<WorkProductRecord>
  get(id: string): Promise<WorkProductRecord | null>
  /** The scope's open accumulator row (`draft`/`blocked`), or null. */
  openDraft(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>
  /** The scope's `changes_requested` row awaiting its correction turn, or null. */
  awaitingCorrection(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>
  /** The scope's `ready` row awaiting review, or null. */
  awaitingReview(workspaceId: string, scopeKey: string): Promise<WorkProductRecord | null>
  /** `max(version over the scope's approved/superseded rows) + 1` — the
   *  version a fresh draft for the scope should carry. */
  nextVersion(workspaceId: string, scopeKey: string): Promise<number>
  /** Re-open a `changes_requested` row as the next draft: version bumps +1
   *  and the correction turn accumulates into the same scope row. */
  reopen(id: string): Promise<WorkProductOutcome<WorkProductRecord>>
  /** Merge evidence entries by id AND by what they assert (target + source +
   *  claim), so re-stating a fact already recorded replaces it under whatever
   *  id this batch minted rather than appending a near-copy. Legal only while
   *  `draft`/`blocked`. */
  upsertEvidence(id: string, entries: readonly EvidenceEntry[]): Promise<WorkProductOutcome<WorkProductRecord>>
  /** Merge exception entries by id, then reconcile the blocked flag: any
   *  unresolved blocking entry parks `draft`→`blocked`; resolving the last
   *  one releases `blocked`→`draft`. */
  upsertExceptions(id: string, entries: readonly ExceptionEntry[]): Promise<WorkProductOutcome<WorkProductRecord>>
  /** Persist a checks array without transitioning — how a failed platform
   *  gate (e.g. evidence_coverage) stays visible on the still-draft row. */
  recordChecks(id: string, checks: readonly QualityCheck[]): Promise<WorkProductOutcome<WorkProductRecord>>
  /** The terminal agent call: CAS `draft`→`ready` with artifact + checks +
   *  provenance, appending the version-history entry. Refuses while an
   *  unresolved blocking exception exists. */
  submit(id: string, input: SubmitWorkProductInput): Promise<WorkProductOutcome<WorkProductRecord>>
  /** Reviewer verdict: CAS `ready`→`approved`/`changes_requested` + history
   *  entry. Approval also supersedes the scope's prior approved versions so
   *  exactly one approved version is current per scope. */
  applyVerdict(id: string, input: WorkProductVerdictInput): Promise<WorkProductOutcome<WorkProductRecord>>
  /** Explicit replacement: CAS to `superseded` (legal from ready /
   *  changes_requested / approved). */
  supersede(id: string): Promise<WorkProductOutcome<WorkProductRecord>>
}

/** Configuration options for creating a work product service */
export interface WorkProductServiceOptions {
  store: WorkProductStorePort
  /** Injectable clock (epoch ms). Default `Date.now`. */
  now?: () => number
  /** Row-id generator. Default `crypto.randomUUID()`. */
  generateId?: () => string
}

function rejected<T>(error: string): WorkProductOutcome<T> {
  return { succeeded: false, error, conflict: false }
}

function lostRace<T>(id: string): WorkProductOutcome<T> {
  return { succeeded: false, error: `Work product ${id} changed concurrently`, conflict: true }
}

/** Merge-by-id upsert: existing order preserved, replaced in place, new
 *  entries appended in call order. */
function mergeById<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): T[] {
  const merged = existing.slice()
  const indexById = new Map(merged.map((entry, index) => [entry.id, index] as const))
  for (const entry of incoming) {
    const at = indexById.get(entry.id)
    if (at === undefined) {
      indexById.set(entry.id, merged.length)
      merged.push(entry)
    } else {
      merged[at] = entry
    }
  }
  return merged
}

/**
 * What makes two evidence rows THE SAME ROW, independent of the id the model
 * happened to mint for them.
 *
 * Merging on the model-supplied id alone is idempotent only if the model
 * re-uses ids, and it does not. Production row `95105c8a` carries 21 entries
 * for 7 targets: the same seven facts emitted three times across a turn under
 * `wages-line1a`, then `w2-wages`, then `wages` — every batch a fresh set of
 * ids, so every batch appended instead of replacing. The tool contract says
 * "re-emit an id to replace"; nothing made re-stating a fact you already
 * recorded a replace, and re-stating facts is what an agent does when it
 * revisits its work.
 *
 * So identity is what the row ASSERTS: this target, from this source, with
 * this value. Re-emit any of the three under any id and it replaces.
 *
 * The claim is part of the key on purpose, and it is the part that keeps
 * honest lineage alive: Form 1040 line 2b legitimately carries two rows from
 * one 1099-INT (box 1 and box 3), and line 1a two rows from two W-2s. Keying
 * on target+source alone would silently delete the second one — a merge rule
 * that destroys evidence is worse than the duplication it fixes. A claim that
 * IS a value keys on the canonical NUMBER, so `128450.00` and `128,450.00`
 * are one fact; any other claim keys on its folded text, which is
 * conservative: two different sentences stay two rows.
 */
function evidenceIdentity(entry: EvidenceEntry): string {
  const whole = canonicalizeValue(entry.claim)
  const claimKey = whole ?? entry.claim.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  return `${entry.target} ${entry.sourceRef} ${claimKey}`
}

/**
 * Upsert evidence by BOTH keys: the explicit id (the documented "re-emit to
 * replace") and the assertion identity above. An incoming entry replaces every
 * existing row it matches on either key, collapsing them to one at the position
 * of the earliest — so a re-stated fact patches the row it duplicates instead of
 * appending a near-copy, and a batch that re-states a fact twice lands once.
 */
function mergeEvidence(existing: readonly EvidenceEntry[], incoming: readonly EvidenceEntry[]): EvidenceEntry[] {
  const merged = existing.slice()
  for (const entry of incoming) {
    const identity = evidenceIdentity(entry)
    const hits: number[] = []
    for (let index = 0; index < merged.length; index += 1) {
      const candidate = merged[index]!
      if (candidate.id === entry.id || evidenceIdentity(candidate) === identity) hits.push(index)
    }
    if (hits.length === 0) {
      merged.push(entry)
      continue
    }
    merged[hits[0]!] = entry
    for (const index of hits.slice(1).reverse()) merged.splice(index, 1)
  }
  return merged
}

/** Create the guarded work-product service over a store port */
export function createWorkProductService(options: WorkProductServiceOptions): WorkProductService {
  const { store } = options
  const now = options.now ?? (() => Date.now())
  const generateId = options.generateId ?? (() => crypto.randomUUID())

  async function appendEvent(
    record: WorkProductRecord,
    step: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await store.appendEvent({
      workProductId: record.id,
      workspaceId: record.workspaceId,
      step,
      message,
      metadata,
      at: now(),
    })
  }

  // Guarded status transition: load → validate the edge → CAS guarded on the
  // {status, version} read → audit event. The loser of a racing transition
  // gets a conflict instead of silently violating the machine.
  async function transition(
    id: string,
    to: WorkProductStatus,
    patch: Omit<WorkProductPatch, 'status'> = {},
    eventMeta: Record<string, unknown> = {},
  ): Promise<WorkProductOutcome<WorkProductRecord>> {
    const record = await store.load(id)
    if (!record) return rejected(`Work product ${id} not found`)
    const from = record.status
    if (isWorkProductTerminal(from)) {
      return rejected(`Work product ${id} is terminal (${from}); cannot transition to ${to}`)
    }
    if (!canTransitionWorkProduct(from, to)) {
      return rejected(`Illegal work-product transition ${from} -> ${to} for ${id}`)
    }
    const updated = await store.update(
      id,
      { status: from, version: record.version },
      { status: to, updatedAt: now(), ...patch },
    )
    if (!updated) return lostRace(id)
    await appendEvent(updated, `wp.${to}`, `Work product ${from} -> ${to}`, { from, to, ...eventMeta })
    return { succeeded: true, value: updated }
  }

  // Merge-style guarded write with no status change (evidence / exceptions /
  // checks accumulate on the open row).
  async function guardedMerge(
    id: string,
    legalStatuses: readonly WorkProductStatus[],
    build: (record: WorkProductRecord) => Omit<WorkProductPatch, 'status' | 'version'>,
    event: { step: string; message: (record: WorkProductRecord) => string; metadata?: (record: WorkProductRecord) => Record<string, unknown> },
  ): Promise<WorkProductOutcome<WorkProductRecord>> {
    const record = await store.load(id)
    if (!record) return rejected(`Work product ${id} not found`)
    if (!legalStatuses.includes(record.status)) {
      return rejected(`Work product ${id} is ${record.status}; expected ${legalStatuses.join('/')}`)
    }
    const updated = await store.update(
      id,
      { status: record.status, version: record.version },
      { updatedAt: now(), ...build(record) },
    )
    if (!updated) return lostRace(id)
    await appendEvent(updated, event.step, event.message(updated), event.metadata?.(updated) ?? {})
    return { succeeded: true, value: updated }
  }

  const create: WorkProductService['create'] = async (input) => {
    const at = now()
    const record = await store.insert(
      {
        id: input.id ?? generateId(),
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        scopeKey: input.scopeKey,
        status: 'draft',
        version: input.version ?? 1,
        artifact: null,
        evidence: [],
        exceptions: [],
        checks: [],
        provenance: input.provenance,
        history: [],
        createdAt: at,
        updatedAt: at,
      },
      input.extras,
    )
    await appendEvent(record, 'wp.created', `Work product draft v${record.version} created for ${record.scopeKey}`, {
      scopeKey: record.scopeKey,
      version: record.version,
      threadId: record.threadId,
    })
    return record
  }

  async function findByScopeAndStatus(
    workspaceId: string,
    scopeKey: string,
    status: WorkProductStatus,
  ): Promise<WorkProductRecord | null> {
    const rows = await store.listByWorkspace(workspaceId, { status: [status] })
    return rows.find((row) => row.scopeKey === scopeKey) ?? null
  }

  const nextVersion: WorkProductService['nextVersion'] = async (workspaceId, scopeKey) => {
    const reviewed = await store.listByWorkspace(workspaceId, { status: ['approved', 'superseded'] })
    const versions = reviewed.filter((row) => row.scopeKey === scopeKey).map((row) => row.version)
    return versions.length === 0 ? 1 : Math.max(...versions) + 1
  }

  const reopen: WorkProductService['reopen'] = async (id) => {
    const record = await store.load(id)
    if (!record) return rejected(`Work product ${id} not found`)
    if (record.status !== 'changes_requested') {
      return rejected(`Work product ${id} is ${record.status}; only changes_requested reopens`)
    }
    const updated = await store.update(
      id,
      { status: 'changes_requested', version: record.version },
      { status: 'draft', version: record.version + 1, updatedAt: now() },
    )
    if (!updated) return lostRace(id)
    await appendEvent(updated, 'wp.reopened', `Correction draft v${updated.version} opened`, {
      from: record.version,
      to: updated.version,
    })
    return { succeeded: true, value: updated }
  }

  const upsertEvidence: WorkProductService['upsertEvidence'] = (id, entries) =>
    guardedMerge(
      id,
      ['draft', 'blocked'],
      (record) => ({ evidence: mergeEvidence(record.evidence, entries) }),
      {
        step: 'wp.evidence',
        message: (record) => `Evidence upserted (${entries.length} entries, ${record.evidence.length} total)`,
        metadata: () => ({ upserted: entries.map((entry) => entry.id) }),
      },
    )

  const upsertExceptions: WorkProductService['upsertExceptions'] = async (id, entries) => {
    const merged = await guardedMerge(
      id,
      ['draft', 'blocked'],
      (record) => ({ exceptions: mergeById(record.exceptions, entries) }),
      {
        step: 'wp.exception',
        message: (record) =>
          `Exceptions upserted (${entries.length} entries, ${unresolvedBlockingExceptions(record.exceptions).length} blocking unresolved)`,
        metadata: () => ({ upserted: entries.map((entry) => entry.id) }),
      },
    )
    if (!merged.succeeded) return merged
    // Reconcile the blocked flag AFTER the merge commits: an unresolved
    // blocking entry parks the draft; resolving the last one releases it.
    const record = merged.value
    const blocking = unresolvedBlockingExceptions(record.exceptions).length
    if (record.status === 'draft' && blocking > 0) {
      return transition(id, 'blocked', {}, { blocking })
    }
    if (record.status === 'blocked' && blocking === 0) {
      return transition(id, 'draft', {}, { blocking })
    }
    return merged
  }

  const recordChecks: WorkProductService['recordChecks'] = (id, checks) =>
    guardedMerge(
      id,
      ['draft', 'blocked'],
      () => ({ checks: checks.slice() }),
      {
        step: 'wp.checks',
        message: () => `Checks recorded (${checks.length}, ${checks.filter((check) => !check.passed).length} failed)`,
        metadata: () => ({ failed: checks.filter((check) => !check.passed).map((check) => check.name) }),
      },
    )

  const submit: WorkProductService['submit'] = async (id, input) => {
    const record = await store.load(id)
    if (!record) return rejected(`Work product ${id} not found`)
    if (record.status !== 'draft') {
      return rejected(`Work product ${id} is ${record.status}; only a draft submits`)
    }
    const blocking = unresolvedBlockingExceptions(record.exceptions)
    if (blocking.length > 0) {
      return rejected(
        `Work product ${id} has ${blocking.length} unresolved blocking exception(s): ${blocking.map((entry) => entry.id).join(', ')}`,
      )
    }
    const artifactPath = input.artifactPath ?? input.artifact.path
    const entry: WorkProductVersionEntry = {
      version: record.version,
      status: 'ready',
      provenance: input.provenance,
      ...(artifactPath === undefined ? {} : { artifactPath }),
      at: now(),
    }
    return transition(
      id,
      'ready',
      {
        artifact: input.artifact,
        checks: input.checks.slice(),
        provenance: input.provenance,
        history: [...record.history, entry],
      },
      { version: record.version, failedChecks: input.checks.filter((check) => !check.passed).length },
    )
  }

  const applyVerdict: WorkProductService['applyVerdict'] = async (id, input) => {
    const record = await store.load(id)
    if (!record) return rejected(`Work product ${id} not found`)
    if (record.status !== 'ready') {
      return rejected(`Work product ${id} is ${record.status}; a verdict applies only to ready`)
    }
    const to: WorkProductStatus = input.verdict === 'approve' ? 'approved' : 'changes_requested'
    const entry: WorkProductVersionEntry = {
      version: record.version,
      status: to,
      provenance: record.provenance,
      ...(record.artifact?.path === undefined ? {} : { artifactPath: record.artifact.path }),
      reviewedBy: input.reviewedBy,
      ...(input.note === undefined ? {} : { reviewNote: input.note }),
      at: now(),
    }
    const outcome = await transition(
      id,
      to,
      { history: [...record.history, entry] },
      { verdict: input.verdict, reviewedBy: input.reviewedBy },
    )
    if (!outcome.succeeded || to !== 'approved') return outcome
    // Exactly one approved version per scope: supersede prior approved rows.
    const priorApproved = await store.listByWorkspace(record.workspaceId, { status: ['approved'] })
    for (const prior of priorApproved) {
      if (prior.id === id || prior.scopeKey !== record.scopeKey) continue
      await transition(prior.id, 'superseded', {}, { supersededBy: id })
    }
    return outcome
  }

  return {
    create,
    get: (id) => store.load(id),
    openDraft: (workspaceId, scopeKey) => store.findDraft(workspaceId, scopeKey),
    awaitingCorrection: (workspaceId, scopeKey) => findByScopeAndStatus(workspaceId, scopeKey, 'changes_requested'),
    awaitingReview: (workspaceId, scopeKey) => findByScopeAndStatus(workspaceId, scopeKey, 'ready'),
    nextVersion,
    reopen,
    upsertEvidence,
    upsertExceptions,
    recordChecks,
    submit,
    applyVerdict,
    supersede: (id) => transition(id, 'superseded'),
  }
}

// ── in-memory store ──────────────────────────────────────────────────────────

/** In-memory store surface with audit trail access and unguarded direct writes for tests */
export interface InMemoryWorkProductStore extends WorkProductStorePort {
  /** The full audit trail, append order. */
  events(): WorkProductAuditEvent[]
  /** Unguarded direct write — simulates a concurrent owner in tests. */
  put(record: WorkProductRecord): void
}

/**
 * In-memory {@link WorkProductStorePort} — the portable backend for tests and
 * reference assemblies. Records are deep-copied on every boundary so callers
 * can never mutate stored state around the guards.
 */
export function createInMemoryWorkProductStore(): InMemoryWorkProductStore {
  const rows = new Map<string, WorkProductRecord>()
  const events: WorkProductAuditEvent[] = []

  return {
    async load(id) {
      const record = rows.get(id)
      return record ? structuredClone(record) : null
    },
    async findDraft(workspaceId, scopeKey) {
      for (const record of rows.values()) {
        if (
          record.workspaceId === workspaceId &&
          record.scopeKey === scopeKey &&
          (record.status === 'draft' || record.status === 'blocked')
        ) {
          return structuredClone(record)
        }
      }
      return null
    },
    async listByWorkspace(workspaceId, opts) {
      const out: WorkProductRecord[] = []
      for (const record of rows.values()) {
        if (record.workspaceId !== workspaceId) continue
        if (opts?.status && !opts.status.includes(record.status)) continue
        out.push(structuredClone(record))
      }
      return out
    },
    async insert(record) {
      if (rows.has(record.id)) throw new Error(`Work product ${record.id} already exists`)
      rows.set(record.id, structuredClone(record))
      return structuredClone(record)
    },
    async update(id, guard, patch) {
      const current = rows.get(id)
      if (!current) return null
      if (guard.status !== undefined && current.status !== guard.status) return null
      if (guard.version !== undefined && current.version !== guard.version) return null
      const next: WorkProductRecord = { ...current }
      if (patch.status !== undefined) next.status = patch.status
      if (patch.version !== undefined) next.version = patch.version
      if (patch.artifact !== undefined) next.artifact = patch.artifact
      if (patch.evidence !== undefined) next.evidence = patch.evidence
      if (patch.exceptions !== undefined) next.exceptions = patch.exceptions
      if (patch.checks !== undefined) next.checks = patch.checks
      if (patch.provenance !== undefined) next.provenance = patch.provenance
      if (patch.history !== undefined) next.history = patch.history
      if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt
      rows.set(id, structuredClone(next))
      return structuredClone(next)
    },
    async appendEvent(event) {
      events.push(structuredClone(event))
    },
    events() {
      return events.map((event) => structuredClone(event))
    },
    put(record) {
      rows.set(record.id, structuredClone(record))
    },
  }
}
