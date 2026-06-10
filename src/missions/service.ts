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

export type MissionStatus =
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'cancelled'

export type MissionStepStatus = 'pending' | 'running' | 'waiting_approval' | 'done' | 'failed'

export interface MissionStep {
  id: string
  /** What the step should accomplish — an intent, never an implementation. */
  intent: string
  /** Product-defined kind label. Labels intent for gating/UX; it never selects
   *  a different execution path. */
  kind: string
  status: MissionStepStatus
  /** Count of genuine `* -> running` edges (retries inflate this; idempotent
   *  re-asserts do not). */
  attempts: number
  /** One-line live status surfaced on the step row ("7/15 refs"). */
  sublabel?: string
  /** Small pointer at the produced artifact (vault path, asset id) — never the
   *  full payload. */
  resultRef?: string
}

export interface MissionCostLedger {
  tokensIn: number
  tokensOut: number
  costUsd: number
  wallMs: number
  llmCalls: number
}

/** The durable mission row, shape-normalized. Timestamps are epoch ms. */
export interface MissionRecord {
  id: string
  workspaceId: string
  status: MissionStatus
  /** Product-defined origin label ('chat', 'manual', 'cron', …). */
  trigger: string
  summary: string | null
  plan: MissionStep[]
  /** Count of durably-completed steps; the next step to run is `plan[cursor]`. */
  cursor: number
  cost: MissionCostLedger | null
  budgetUsd: number | null
  spentUsd: number
  pauseReason: string | null
  /** The single owning engine's instance id, write-once (see `setEngineRef`). */
  engineRef: string | null
  scheduledAt: number | null
  startedAt: number
  completedAt: number | null
  metadata: Record<string, unknown> | null
}

/**
 * Discriminated outcome for guarded operations. Callers MUST inspect
 * `succeeded` before reading `value` — illegal transitions and missing rows
 * surface here, never as a throw-and-swallow or a silent no-op. `conflict`
 * distinguishes a lost guarded race (retryable — re-read and re-apply) from a
 * logic rejection (illegal edge, missing step — deterministic, never retried).
 */
export type MissionOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: string; conflict: boolean }

/** Fields a guarded write compares against the values the caller read. A SQL
 *  implementation compares JSON columns as serialized text
 *  (`coalesce(col, 'null') = JSON.stringify(expected)`), matching how the
 *  in-memory store compares. An absent field is unguarded. */
export interface MissionUpdateGuard {
  status?: MissionStatus
  cursor?: number
  plan?: MissionStep[]
  cost?: MissionCostLedger | null
  metadata?: Record<string, unknown> | null
  /** Guard that no engine has bound yet (the write-once bind). */
  engineRefIsNull?: true
}

/** Fields a guarded write sets when the guard holds. `null` values are real
 *  writes (clear the column), not skips. */
export interface MissionUpdatePatch {
  status?: MissionStatus
  pauseReason?: string | null
  summary?: string
  completedAt?: number | null
  plan?: MissionStep[]
  cursor?: number
  cost?: MissionCostLedger
  spentUsd?: number
  metadata?: Record<string, unknown>
  engineRef?: string
}

/** One audit-trail row. Appended after every committed state change, so an
 *  event always denotes a real transition (no phantom rows on rejected or
 *  no-op calls). */
export interface MissionAuditEvent {
  missionId: string
  workspaceId: string
  level: 'info' | 'warn' | 'error'
  /** Machine-readable transition name ('mission.created', 'mission.step.done',
   *  'mission.cursor', 'mission.cost', 'mission.paused', …). */
  step: string
  message: string
  metadata: Record<string, unknown>
  at: number
}

/**
 * Persistence seam — the product implements this over its own tables. The
 * invariant the implementation MUST keep: `update` applies `patch` ONLY when
 * every guard field still equals the stored value, and returns `null` when the
 * guard misses. That null is how a concurrent write surfaces as a typed
 * failure instead of a clobber.
 */
export interface MissionStorePort {
  load(id: string): Promise<MissionRecord | null>
  insert(record: MissionRecord): Promise<MissionRecord>
  update(id: string, guard: MissionUpdateGuard, patch: MissionUpdatePatch): Promise<MissionRecord | null>
  appendEvent(event: MissionAuditEvent): Promise<void>
}

const TERMINAL_STATUSES: ReadonlySet<MissionStatus> = new Set<MissionStatus>([
  'succeeded',
  'failed',
  'aborted',
  'cancelled',
])

/** Statuses a mission can never leave — the run is done. */
export function isMissionTerminal(status: MissionStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** The cooperative kill switch: a stop request rides metadata so it survives
 *  any status and is honored by the engine before the next side effect. */
export function isMissionStopRequested(mission: MissionRecord): boolean {
  return (mission.metadata ?? {}).stopRequested === true
}

// Legal mission status transitions. A target absent from a source's set is
// rejected by the guarded helpers. Terminal statuses have no outgoing edges.
const MISSION_TRANSITIONS: Record<MissionStatus, ReadonlySet<MissionStatus>> = {
  scheduled: new Set<MissionStatus>(['running', 'cancelled', 'aborted']),
  running: new Set<MissionStatus>([
    'paused',
    'waiting_approval',
    'blocked',
    'succeeded',
    'failed',
    'aborted',
  ]),
  paused: new Set<MissionStatus>(['running', 'aborted', 'cancelled']),
  waiting_approval: new Set<MissionStatus>(['running', 'aborted', 'cancelled']),
  blocked: new Set<MissionStatus>(['running', 'aborted', 'cancelled']),
  succeeded: new Set<MissionStatus>(),
  failed: new Set<MissionStatus>(),
  aborted: new Set<MissionStatus>(),
  cancelled: new Set<MissionStatus>(),
}

// Legal per-step transitions inside a plan.
const STEP_TRANSITIONS: Record<MissionStepStatus, ReadonlySet<MissionStepStatus>> = {
  pending: new Set<MissionStepStatus>(['running', 'waiting_approval', 'failed']),
  running: new Set<MissionStepStatus>(['done', 'failed', 'waiting_approval']),
  waiting_approval: new Set<MissionStepStatus>(['running', 'done', 'failed']),
  done: new Set<MissionStepStatus>([]),
  failed: new Set<MissionStepStatus>(['pending', 'running']),
}

const ZERO_LEDGER: MissionCostLedger = {
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  wallMs: 0,
  llmCalls: 0,
}

export interface CreateMissionInput {
  /** Explicit row id. Omit to use the service's id generator. Pass a
   *  DETERMINISTIC id (derived from the originating turn) when the caller may
   *  re-create the same mission under at-least-once delivery — the duplicate
   *  insert then trips the store's uniqueness instead of spawning a second run. */
  id?: string
  workspaceId: string
  /** Becomes the mission summary. */
  title: string
  /** Plan step ids MUST be unique: the owning workflow keys its durable step
   *  cache by step id, so a collision would silently replay the wrong result.
   *  A duplicate is rejected here (fail loud). */
  plan: MissionStep[]
  budgetUsd?: number | null
  /** Epoch ms. Present → the mission starts `scheduled` instead of `running`. */
  scheduledAt?: number | null
  trigger: string
  /** Caller-defined context stamped onto the record (thread ids, source turn,
   *  model). Read back via `mission.metadata`; the engine only reads
   *  `stopRequested` from it. */
  metadata?: Record<string, unknown> | null
}

export interface SetStepStatusPatch {
  sublabel?: string
  resultRef?: string
  error?: string
}

export interface CompleteMissionInput {
  ok: boolean
  summary?: string
}

export interface MissionService {
  createMission(input: CreateMissionInput): Promise<MissionRecord>
  getMission(id: string): Promise<MissionRecord | null>
  /** Bind the executing engine's instance id, write-once from the single
   *  owner: re-asserting the same ref is a no-op; binding a DIFFERENT ref over
   *  an existing one is rejected so a second owner can never steal the run. */
  setEngineRef(id: string, engineRef: string): Promise<MissionOutcome<MissionRecord>>
  /** Shallow-merge keys into metadata. Guarded on the metadata read, so racing
   *  merges surface as conflicts instead of silently dropping keys. */
  mergeMetadata(id: string, patch: Record<string, unknown>): Promise<MissionOutcome<MissionRecord>>
  /** Mutate one plan step's status (+ optional sublabel/resultRef) and append a
   *  transition event. Rejects unknown steps and illegal step edges. Does NOT
   *  move the cursor — call `advanceCursor` for that. */
  setStepStatus(
    id: string,
    stepId: string,
    status: MissionStepStatus,
    patch?: SetStepStatusPatch,
  ): Promise<MissionOutcome<MissionRecord>>
  /** Move the done-count cursor forward by one. Rejects advancing past the end
   *  of the plan so the caller learns the mission has no further work. */
  advanceCursor(id: string): Promise<MissionOutcome<MissionRecord>>
  /** Increment spentUsd and merge a partial ledger into the cumulative ledger.
   *  `deltaUsd` is the marginal spend; `ledgerDelta` carries the token/wall/
   *  llm-call breakdown for the same unit of work. */
  addCost(
    id: string,
    deltaUsd: number,
    ledgerDelta?: Partial<MissionCostLedger>,
  ): Promise<MissionOutcome<MissionRecord>>
  pause(id: string, reason: string): Promise<MissionOutcome<MissionRecord>>
  resume(id: string): Promise<MissionOutcome<MissionRecord>>
  abort(id: string): Promise<MissionOutcome<MissionRecord>>
  /** Flip one step and the whole mission to waiting_approval together. The
   *  mission transition is validated FIRST so an illegal source is rejected
   *  without mutating the step — no half-applied state. */
  markWaitingApproval(id: string, stepId: string): Promise<MissionOutcome<MissionRecord>>
  complete(id: string, input: CompleteMissionInput): Promise<MissionOutcome<MissionRecord>>
}

export interface MissionServiceOptions {
  store: MissionStorePort
  /** Injectable clock (epoch ms). Default `Date.now`. */
  now?: () => number
  /** Row-id generator when `CreateMissionInput.id` is omitted.
   *  Default `crypto.randomUUID`. */
  generateId?: () => string
}

function rejected<T>(error: string): MissionOutcome<T> {
  return { succeeded: false, error, conflict: false }
}

function lostRace<T>(id: string): MissionOutcome<T> {
  return { succeeded: false, error: `Mission ${id} changed concurrently`, conflict: true }
}

export function createMissionService(options: MissionServiceOptions): MissionService {
  const { store } = options
  const now = options.now ?? (() => Date.now())
  const generateId = options.generateId ?? (() => crypto.randomUUID())

  async function appendEvent(
    mission: MissionRecord,
    level: MissionAuditEvent['level'],
    step: string,
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await store.appendEvent({
      missionId: mission.id,
      workspaceId: mission.workspaceId,
      level,
      step,
      message,
      metadata,
      at: now(),
    })
  }

  // Guarded status transition: load → validate against the transition table →
  // CAS-write guarded on the status we read → event. The loser of a racing
  // transition gets a conflict instead of silently violating the machine.
  async function transition(
    id: string,
    to: MissionStatus,
    patch: Omit<MissionUpdatePatch, 'status'> = {},
    eventMeta: Record<string, unknown> = {},
  ): Promise<MissionOutcome<MissionRecord>> {
    const mission = await store.load(id)
    if (!mission) return rejected(`Mission ${id} not found`)

    const from = mission.status
    if (TERMINAL_STATUSES.has(from)) {
      return rejected(`Mission ${id} is terminal (${from}); cannot transition to ${to}`)
    }
    // Same-status calls are a true no-op (resume-while-running, idempotent
    // re-assert under at-least-once delivery): no patch re-apply, no phantom
    // event, so an event row always denotes a real state change.
    if (from === to) return { succeeded: true, value: mission }
    if (!MISSION_TRANSITIONS[from].has(to)) {
      return rejected(`Illegal mission transition ${from} -> ${to} for mission ${id}`)
    }

    const updated = await store.update(id, { status: from }, { status: to, ...patch })
    if (!updated) return lostRace(id)
    await appendEvent(updated, to === 'failed' ? 'error' : 'info', `mission.${to}`, `Mission ${from} -> ${to}`, {
      from,
      to,
      ...eventMeta,
    })
    return { succeeded: true, value: updated }
  }

  const createMission: MissionService['createMission'] = async (input) => {
    const seen = new Set<string>()
    for (const step of input.plan) {
      if (seen.has(step.id)) {
        throw new Error(`Duplicate plan step id "${step.id}" — mission plan step ids must be unique`)
      }
      seen.add(step.id)
    }

    const scheduledAt = input.scheduledAt ?? null
    const status: MissionStatus = scheduledAt !== null ? 'scheduled' : 'running'
    const plan: MissionStep[] = input.plan.map((step) => ({
      id: step.id,
      intent: step.intent,
      kind: step.kind,
      status: step.status,
      attempts: step.attempts,
      ...(step.sublabel === undefined ? {} : { sublabel: step.sublabel }),
      ...(step.resultRef === undefined ? {} : { resultRef: step.resultRef }),
    }))

    const record = await store.insert({
      id: input.id ?? generateId(),
      workspaceId: input.workspaceId,
      status,
      trigger: input.trigger,
      summary: input.title,
      plan,
      cursor: 0,
      cost: { ...ZERO_LEDGER },
      budgetUsd: input.budgetUsd ?? null,
      spentUsd: 0,
      pauseReason: null,
      engineRef: null,
      scheduledAt,
      startedAt: now(),
      completedAt: null,
      metadata: input.metadata ?? null,
    })

    await appendEvent(record, 'info', 'mission.created', `Mission "${input.title}" ${status}`, {
      status,
      stepCount: plan.length,
      budgetUsd: input.budgetUsd ?? null,
      scheduledAt,
    })
    return record
  }

  const getMission: MissionService['getMission'] = (id) => store.load(id)

  const setEngineRef: MissionService['setEngineRef'] = async (id, engineRef) => {
    const mission = await store.load(id)
    if (!mission) return rejected(`Mission ${id} not found`)
    if (TERMINAL_STATUSES.has(mission.status) || isMissionStopRequested(mission)) {
      return rejected(`Mission ${id} is not writable in status ${mission.status}`)
    }
    if (mission.engineRef === engineRef) return { succeeded: true, value: mission }
    if (mission.engineRef !== null) {
      return rejected(`Mission ${id} is already bound to engine ${mission.engineRef}`)
    }

    // Guard on the null engineRef we read so two racing owners cannot both
    // bind: the second write misses the guard and reports the lost race —
    // distinct from the deterministic already-bound rejection above.
    const updated = await store.update(id, { engineRefIsNull: true }, { engineRef })
    if (!updated) return lostRace(id)
    await appendEvent(updated, 'info', 'mission.engine', `Engine bound: ${engineRef}`, { engineRef })
    return { succeeded: true, value: updated }
  }

  const mergeMetadata: MissionService['mergeMetadata'] = async (id, patch) => {
    const mission = await store.load(id)
    if (!mission) return rejected(`Mission ${id} not found`)
    if (TERMINAL_STATUSES.has(mission.status) || isMissionStopRequested(mission)) {
      return rejected(`Mission ${id} is not writable in status ${mission.status}`)
    }

    const updated = await store.update(
      id,
      { metadata: mission.metadata },
      { metadata: { ...(mission.metadata ?? {}), ...patch } },
    )
    if (!updated) return lostRace(id)
    return { succeeded: true, value: updated }
  }

  const setStepStatus: MissionService['setStepStatus'] = async (id, stepId, status, patch = {}) => {
    const mission = await store.load(id)
    if (!mission) return rejected(`Mission ${id} not found`)

    const plan = mission.plan
    const index = plan.findIndex((step) => step.id === stepId)
    const current = index < 0 ? undefined : plan[index]
    if (!current) return rejected(`Step ${stepId} not found in mission ${id}`)

    const sameStatus = current.status === status
    if (!sameStatus && !STEP_TRANSITIONS[current.status].has(status)) {
      return rejected(`Illegal step transition ${current.status} -> ${status} for step ${stepId}`)
    }

    // True no-op: re-asserting the same status with no patch field change must
    // not bump attempts or write a duplicate event (at-least-once delivery,
    // retries, and reconnects re-assert state). A patch on the same status
    // still persists, but does not count a new attempt.
    const sublabelChanges = patch.sublabel !== undefined && patch.sublabel !== current.sublabel
    const resultRefChanges = patch.resultRef !== undefined && patch.resultRef !== current.resultRef
    if (sameStatus && !sublabelChanges && !resultRefChanges) {
      return { succeeded: true, value: mission }
    }

    // Only a genuine `* -> running` edge counts an attempt; a running->running
    // re-assert (handled as a no-op above) never inflates the counter.
    const nextStep: MissionStep = {
      ...current,
      status,
      attempts: status === 'running' && !sameStatus ? current.attempts + 1 : current.attempts,
      ...(patch.sublabel === undefined ? {} : { sublabel: patch.sublabel }),
      ...(patch.resultRef === undefined ? {} : { resultRef: patch.resultRef }),
    }
    const nextPlan = plan.slice()
    nextPlan[index] = nextStep

    // The plan write is guarded on the status, plan, AND metadata we read: a
    // concurrent stop request (a metadata write) or any plan mutation flips a
    // guard and the loser reports the race instead of clobbering it.
    const updated = await store.update(
      id,
      { status: mission.status, plan: mission.plan, metadata: mission.metadata },
      { plan: nextPlan },
    )
    if (!updated) return lostRace(id)
    await appendEvent(
      updated,
      status === 'failed' ? 'error' : 'info',
      `mission.step.${status}`,
      patch.error ?? `Step ${stepId} (${current.intent}) -> ${status}`,
      {
        stepId,
        from: current.status,
        to: status,
        attempts: nextStep.attempts,
        ...(patch.resultRef ? { resultRef: patch.resultRef } : {}),
      },
    )
    return { succeeded: true, value: updated }
  }

  const advanceCursor: MissionService['advanceCursor'] = async (id) => {
    const mission = await store.load(id)
    if (!mission) return rejected(`Mission ${id} not found`)

    const next = mission.cursor + 1
    if (next > mission.plan.length) {
      return rejected(`Cursor ${mission.cursor} is already at the end of mission ${id}`)
    }

    // Guarded on the cursor (and status) we read: a concurrent advance shifts
    // the cursor, the guard misses, and we report the lost race rather than
    // writing a stale value that drops the other increment.
    const updated = await store.update(
      id,
      { status: mission.status, cursor: mission.cursor },
      { cursor: next },
    )
    if (!updated) return lostRace(id)
    await appendEvent(updated, 'info', 'mission.cursor', `Cursor ${mission.cursor} -> ${updated.cursor}`, {
      from: mission.cursor,
      to: updated.cursor,
    })
    return { succeeded: true, value: updated }
  }

  const addCost: MissionService['addCost'] = async (id, deltaUsd, ledgerDelta) => {
    const mission = await store.load(id)
    if (!mission) return rejected(`Mission ${id} not found`)

    const base = mission.cost ?? { ...ZERO_LEDGER }
    const nextCost: MissionCostLedger = {
      tokensIn: base.tokensIn + (ledgerDelta?.tokensIn ?? 0),
      tokensOut: base.tokensOut + (ledgerDelta?.tokensOut ?? 0),
      costUsd: base.costUsd + (ledgerDelta?.costUsd ?? deltaUsd),
      wallMs: base.wallMs + (ledgerDelta?.wallMs ?? 0),
      llmCalls: base.llmCalls + (ledgerDelta?.llmCalls ?? 0),
    }

    // Guarded on the ledger we read: an undercounted spend is an over-spend
    // against the budget gate, so a concurrent merge must surface as a lost
    // race (retry re-reads and re-merges), never be clobbered.
    const updated = await store.update(
      id,
      { cost: mission.cost },
      { cost: nextCost, spentUsd: mission.spentUsd + deltaUsd },
    )
    if (!updated) return lostRace(id)
    await appendEvent(updated, 'info', 'mission.cost', `Spent +$${deltaUsd.toFixed(4)}`, {
      deltaUsd,
      spentUsd: updated.spentUsd,
      budgetUsd: updated.budgetUsd,
    })
    return { succeeded: true, value: updated }
  }

  const markWaitingApproval: MissionService['markWaitingApproval'] = async (id, stepId) => {
    const mission = await store.load(id)
    if (!mission) return rejected(`Mission ${id} not found`)
    if (!MISSION_TRANSITIONS[mission.status].has('waiting_approval')) {
      return rejected(`Illegal mission transition ${mission.status} -> waiting_approval for mission ${id}`)
    }

    const stepResult = await setStepStatus(id, stepId, 'waiting_approval')
    if (!stepResult.succeeded) return stepResult
    return transition(id, 'waiting_approval', {}, { stepId })
  }

  return {
    createMission,
    getMission,
    setEngineRef,
    mergeMetadata,
    setStepStatus,
    advanceCursor,
    addCost,
    markWaitingApproval,
    pause: (id, reason) => transition(id, 'paused', { pauseReason: reason }),
    resume: (id) => transition(id, 'running', { pauseReason: null }),
    abort: (id) => transition(id, 'aborted', { completedAt: now() }),
    complete: (id, input) =>
      transition(id, input.ok ? 'succeeded' : 'failed', {
        completedAt: now(),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }),
  }
}

// ── in-memory store ──────────────────────────────────────────────────────────

export interface InMemoryMissionStore extends MissionStorePort {
  /** The full audit trail, append order. */
  events(): MissionAuditEvent[]
  /** Unguarded direct write — simulates a concurrent owner or a crash-shaped
   *  state in tests. Production writers go through the guarded `update`. */
  put(record: MissionRecord): void
}

/**
 * In-memory {@link MissionStorePort} — the portable backend for tests and
 * sandbox/eval shells. Guard comparison uses JSON serialization of the read
 * value, the same contract a SQL implementation honors by comparing stored
 * JSON text. Records are deep-copied on every boundary so callers can never
 * mutate stored state around the guards.
 */
export function createInMemoryMissionStore(): InMemoryMissionStore {
  const rows = new Map<string, MissionRecord>()
  const events: MissionAuditEvent[] = []

  return {
    async load(id) {
      const record = rows.get(id)
      return record ? structuredClone(record) : null
    },
    async insert(record) {
      if (rows.has(record.id)) throw new Error(`Mission ${record.id} already exists`)
      rows.set(record.id, structuredClone(record))
      return structuredClone(record)
    },
    async update(id, guard, patch) {
      const current = rows.get(id)
      if (!current) return null
      if (guard.status !== undefined && current.status !== guard.status) return null
      if (guard.cursor !== undefined && current.cursor !== guard.cursor) return null
      if (guard.plan !== undefined && JSON.stringify(current.plan) !== JSON.stringify(guard.plan)) return null
      if (guard.cost !== undefined && JSON.stringify(current.cost) !== JSON.stringify(guard.cost)) return null
      if (
        guard.metadata !== undefined &&
        JSON.stringify(current.metadata) !== JSON.stringify(guard.metadata)
      ) {
        return null
      }
      if (guard.engineRefIsNull && current.engineRef !== null) return null

      const next: MissionRecord = { ...current }
      if (patch.status !== undefined) next.status = patch.status
      if (patch.pauseReason !== undefined) next.pauseReason = patch.pauseReason
      if (patch.summary !== undefined) next.summary = patch.summary
      if (patch.completedAt !== undefined) next.completedAt = patch.completedAt
      if (patch.plan !== undefined) next.plan = patch.plan
      if (patch.cursor !== undefined) next.cursor = patch.cursor
      if (patch.cost !== undefined) next.cost = patch.cost
      if (patch.spentUsd !== undefined) next.spentUsd = patch.spentUsd
      if (patch.metadata !== undefined) next.metadata = patch.metadata
      if (patch.engineRef !== undefined) next.engineRef = patch.engineRef
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
