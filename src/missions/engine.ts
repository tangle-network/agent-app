/**
 * Mission execution engine — drives one mission's plan to completion under a
 * SINGLE serialized owner (a Cloudflare Workflow, a Durable Object alarm, a
 * queue consumer — one per mission). The owner wraps each `runStep` call in its
 * durable-step primitive (e.g. Workflows `step.do(step.id, …)`) so a completed
 * step's result is persisted and replayed instead of re-run after a mid-run
 * restart. This module holds the logic that must be correct independent of any
 * runtime, so it is injectable and unit-testable with the dispatch mocked.
 *
 * Idempotency is layered, belt-and-suspenders:
 *   1. The owner's durable-step cache replays a completed step's result.
 *   2. `runStep` re-reads the mission first; a step already `done` (with a
 *      resultRef) returns the cached pointer WITHOUT re-dispatching — this
 *      closes the at-least-once window where a callback re-runs after the
 *      side effect committed but before the owner durably recorded it.
 *   3. The cursor advances only after a step is `done`, so a fresh run resumes
 *      from `mission.cursor` and never re-touches earlier steps.
 *
 * Seams (the product supplies domain; the engine owns mechanism):
 *   - {@link SandboxDispatch} — how a step actually executes.
 *   - {@link MissionEngineOptions.estimateStepCostUsd} — per-step USD estimate.
 *   - {@link MissionGateOptions.classifyStep} — which steps need approval.
 *   - {@link MissionApprovalsPort} — where gate proposals live and how they
 *     resolve.
 */

import type {
  MissionCostLedger,
  MissionOutcome,
  MissionRecord,
  MissionService,
  MissionStatus,
  MissionStep,
} from './service'
import { isMissionStopRequested, isMissionTerminal } from './service'
import { noopEventSink, type MissionEventSink, type MissionStreamEvent } from './events'

/**
 * A side-effecting unit of per-step work. The owner supplies the real
 * implementation (e.g. a detached sandbox-session dispatcher); tests supply a
 * mock. MUST return a SMALL pointer — large output is written to the product's
 * storage and only the resultRef is returned.
 */
export type SandboxDispatch = (input: SandboxDispatchInput) => Promise<SandboxDispatchResult>

/** Define input parameters for dispatching a mission step in the sandbox environment */
export interface SandboxDispatchInput {
  mission: MissionRecord
  step: MissionStep
  stepIndex: number
}

/** Define the result of a completed sandbox dispatch including artifact reference and optional cost details */
export interface SandboxDispatchDoneResult {
  kind?: 'done'
  /** Small pointer at the produced artifact/output (vault path, asset id, exec
   *  digest). Stored on the step as `resultRef`; never the full payload. */
  resultRef: string
  /** Optional one-line status surfaced on the step row. */
  sublabel?: string
  /** Optional marginal spend for this step. `ledgerDelta` carries platform-
   *  reported truth (real token counts, wall time); `deltaUsd` is set ONLY when
   *  a provider-authored price is known. Omit fields rather than synthesizing
   *  zeros — the engine substitutes its injected per-step estimate for a
   *  missing deltaUsd and records that estimate in the ledger. */
  cost?: {
    deltaUsd?: number
    ledgerDelta?: Partial<MissionCostLedger>
  }
}

/** The dispatched step's detached session is still executing on the platform.
 *  The owner sleeps `pollAfterMs` and re-invokes the step; the dispatch is
 *  idempotent on the session ref, so the re-invocation settles the same session
 *  rather than starting a second run. */
export interface SandboxDispatchInProgressResult {
  kind: 'in_progress'
  sessionRef: string
  pollAfterMs: number
  sublabel?: string
}

/** Resolve the result of a sandbox dispatch as done or in progress */
export type SandboxDispatchResult = SandboxDispatchDoneResult | SandboxDispatchInProgressResult

/** Outcome of running a single step. `cached` distinguishes a replay/skip
 *  (step was already done) from a fresh execution so the engine and its tests
 *  can assert the dispatch was NOT re-invoked. */
export type StepOutcome =
  | { kind: 'done'; resultRef: string; cached: boolean }
  | { kind: 'in_progress'; sessionRef: string; pollAfterMs: number; sublabel?: string }
  | { kind: 'skipped-cursor'; reason: string }
  | { kind: 'failed'; error: string; fatal: boolean }

/** Outcome of running the whole plan from the cursor to the end. */
export type PlanOutcome =
  | { kind: 'completed'; summary: string }
  | { kind: 'in_progress'; stepId: string; sessionRef: string; pollAfterMs: number; sublabel?: string }
  | { kind: 'failed'; failedStepId: string; error: string }
  | { kind: 'halted'; status: MissionStatus; reason?: string | null }
  | { kind: 'terminal'; status: MissionStatus }
  | { kind: 'not-found' }

type StepGateOutcome =
  | { kind: 'continue' }
  | { kind: 'halted'; status: MissionStatus; reason: string }

/** Define options to control mission plan execution with optional pre-step veto logic */
export interface MissionPlanRunOptions {
  /** Pre-step veto (kill switch, schedule window). A non-null return pauses the
   *  mission with that reason before the step's side effect starts. */
  beforeStep?: (mission: MissionRecord, step: MissionStep) => Promise<string | null>
}

/** Thrown to make the owner's durable-step wrapper retry. The single-owner
 *  invariant makes a genuine concurrent change rare (it means another writer
 *  touched the row), so retrying — rather than corrupting state by forcing a
 *  stale write — is the correct response. Distinct from a task failure, which
 *  is recorded on the step. */
export class MissionConcurrencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissionConcurrencyError'
  }
}

/** Thrown by a {@link SandboxDispatch} for a TRANSIENT failure (platform blip,
 *  exec-time network fault) that should be re-attempted. `runStep` RE-THROWS it
 *  so the owner engages its bounded retry+backoff; the step is left `running`
 *  and the re-dispatch is made idempotent by the cached-done guard. A
 *  deterministic failure must be a plain Error instead — that is recorded as a
 *  fatal `failed` step and is never retried (no money-burning loop on a
 *  deterministic error). */
export class RetryableStepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RetryableStepError'
  }
}

/** Resolution states a gate proposal can be in. `approved`/`executed` unblock
 *  the gated step; everything else keeps the mission parked. */
export type MissionProposalResolution = 'pending' | 'approved' | 'rejected' | 'executed' | 'ignored'

/** Define mission gate categories as step, budget, or volume */
export type MissionGateKind = 'step' | 'budget' | 'volume'

/** Product classification of one step. Returned by
 *  {@link MissionGateOptions.classifyStep}; the matching rules (regexes, intent
 *  vocabularies, path allowlists) are product domain and never live here. */
export interface StepGateClassification {
  /** Product approval-type label persisted on the proposal ('generate',
   *  'integration_invoke', …). */
  type: string
  /** Counted against the per-mission external-action volume cap. */
  externalAction?: boolean
  estCostUsd?: number | null
}

/** A gate proposal the engine asks the product to persist. The id is
 *  deterministic per (gate, mission, step) — see the `*ProposalId` helpers —
 *  so a replay re-finds the same proposal instead of duplicating it. The
 *  product composes its own title/description from the structured fields. */
export interface MissionGateProposal {
  id: string
  missionId: string
  stepId: string
  gate: MissionGateKind
  mission: MissionRecord
  step: MissionStep
  /** Present for `gate: 'step'` — the classification that triggered the gate. */
  classification?: StepGateClassification
  /** Present for `gate: 'budget'`. */
  budget?: { spentUsd: number; budgetUsd: number; estimatedCostUsd: number }
  /** Present for `gate: 'volume'`. */
  volume?: { externalActionCount: number; cap: number }
}

/** Approval persistence seam — the product implements this over its own
 *  proposal table and resolution flow. */
export interface MissionApprovalsPort {
  /** Resolution of the proposal with this id, or null when none exists. */
  findResolution(proposalId: string): Promise<MissionProposalResolution | null>
  /** Persist a new gate proposal (id is deterministic; called at most once per
   *  (gate, mission, step) absent a resolution). */
  createProposal(proposal: MissionGateProposal): Promise<void>
  /** Count of this mission's `gate: 'step'` proposals whose classification was
   *  `externalAction: true` — the denominator of the volume cap. */
  countExternalActionProposals(missionId: string): Promise<number>
}

/** Define configuration options for mission gating including approvals, step classification, and action limits */
export interface MissionGateOptions {
  approvals: MissionApprovalsPort
  /** Which steps need human approval, and as what. Return null for an ungated
   *  step. The rules are product domain (intent regexes, kind tables). */
  classifyStep: (step: MissionStep) => StepGateClassification | null
  /** Max external-action approvals per mission before an approved override is
   *  required to request another. Default 5. */
  externalActionCap?: number
}

/** Define configuration options for initializing and controlling the mission engine behavior */
export interface MissionEngineOptions {
  service: MissionService
  /** Per-step USD estimate. Load-bearing twice: the budget gate parks on it
   *  BEFORE a step runs, and the engine records it as the step's spend when the
   *  dispatch reports no provider-authored price — using one estimator keeps
   *  spend and gate consistent. */
  estimateStepCostUsd: (step: MissionStep) => number
  /** Best-effort live notifier. Fired AFTER each guarded write commits, so a
   *  broadcast always reflects persisted state; re-fired on idempotent replays
   *  so a reconnecting client converges. Never awaited; a throwing sink can
   *  never fail a step. Default: drop everything. */
  sink?: MissionEventSink
  /** Approval gating. Omitted → no classification/volume gates, and a budget
   *  overrun pauses the mission (fail closed) instead of parking it
   *  waiting_approval behind an override proposal. */
  gates?: MissionGateOptions
  /** Step kinds whose failure does NOT abort the whole mission — enrichment
   *  steps the plan can complete without. Every other kind is fatal-on-failure.
   *  Default `['optional', 'best-effort']`. */
  nonFatalStepKinds?: readonly string[]
}

/** Resolve mission plan steps with concurrency control and durable state management */
export interface MissionEngine {
  /** Run exactly one plan step. Idempotent: re-invoking for a step already
   *  `done` returns the cached pointer without re-dispatching. A lost guarded
   *  race throws {@link MissionConcurrencyError} so the owner's durable-step
   *  wrapper retries instead of writing a stale value. */
  runStep(missionId: string, stepId: string, dispatch: SandboxDispatch): Promise<StepOutcome>
  /** Walk the plan from the durable cursor to the end, re-reading the mission
   *  between steps so a pause/stop control that lands while a step is running
   *  is honored before the next side effect. `runStep` is the owner's boundary:
   *  in production `(step) => durableStep.do(step.id, () => engine.runStep(…))`;
   *  in tests `engine.runStep` directly. */
  runPlan(
    missionId: string,
    runStep: (step: MissionStep, stepIndex: number) => Promise<StepOutcome>,
    options?: MissionPlanRunOptions,
  ): Promise<PlanOutcome>
  /** Record spend durable-first, live second: the guarded ledger write commits,
   *  then the sink sees the new total. A guarded failure returns unchanged. */
  recordCost(
    missionId: string,
    deltaUsd: number,
    ledgerDelta?: Partial<MissionCostLedger>,
  ): Promise<MissionOutcome<MissionRecord>>
  /** Pause durable-first, live second (the paused event fires only on a real
   *  edge, not an idempotent re-pause). */
  pauseMission(missionId: string, reason: string): Promise<MissionOutcome<MissionRecord>>
}

const DEFAULT_EXTERNAL_ACTION_CAP = 5
const DEFAULT_NON_FATAL_STEP_KINDS: readonly string[] = ['optional', 'best-effort']

/** Deterministic proposal id for a step-classification gate. */
export function stepGateProposalId(missionId: string, stepId: string): string {
  return `mission-step-gate:${missionId}:${stepId}`
}

/** Deterministic proposal id for a budget-overrun override. */
export function budgetGateProposalId(missionId: string, stepId: string): string {
  return `mission-budget-gate:${missionId}:${stepId}`
}

/** Deterministic proposal id for an external-action volume-cap override. */
export function volumeGateProposalId(missionId: string, stepId: string): string {
  return `mission-volume-gate:${missionId}:${stepId}`
}

// Emit a live event without letting the sink's failure touch the step path.
// The engine owns the fire-and-forget guarantee at this boundary: a sink that
// throws synchronously can NEVER fail a step. The durable audit row is the
// authoritative timeline; the live channel is a convenience.
function safeEmit(sink: MissionEventSink, event: MissionStreamEvent): void {
  try {
    sink.emit(event)
  } catch {
    // Best-effort UI notification — a broadcast fault never fails the step.
  }
}

function unblocked(resolution: MissionProposalResolution | null): boolean {
  return resolution === 'approved' || resolution === 'executed'
}

// Map a durable terminal status onto the live `mission.completed` event. Only
// `succeeded` is ok=true; aborted/cancelled/failed fold to ok=false with the
// terminal status preserved so the reducer keeps user stops distinct from
// failures.
function terminalMissionEvent(
  missionId: string,
  status: MissionStatus,
): Extract<MissionStreamEvent, { type: 'mission.completed' }> {
  const terminal = status === 'succeeded' || status === 'failed' || status === 'aborted' || status === 'cancelled'
    ? status
    : 'failed'
  return {
    type: 'mission.completed',
    missionId,
    at: Date.now(),
    ok: terminal === 'succeeded',
    status: terminal,
    ...(terminal === 'succeeded' ? {} : { summary: `Mission ${status}` }),
  }
}

/** Create a mission engine configured with options to manage mission execution and error handling */
export function createMissionEngine(options: MissionEngineOptions): MissionEngine {
  const { service, estimateStepCostUsd, gates } = options
  const sink = options.sink ?? noopEventSink
  const nonFatalStepKinds = new Set(options.nonFatalStepKinds ?? DEFAULT_NON_FATAL_STEP_KINDS)
  const externalActionCap = gates?.externalActionCap ?? DEFAULT_EXTERNAL_ACTION_CAP

  function isFatalStepKind(kind: string): boolean {
    return !nonFatalStepKinds.has(kind)
  }

  // A guarded service rejection is one of two things:
  //   - a lost race (conflict: true) — THROW so the owner's durable-step
  //     wrapper retries; the single owner makes this rare and a retry re-reads
  //     fresh state rather than forcing a stale write.
  //   - a logic rejection (illegal transition, missing step) — that step is
  //     structurally broken; return a fatal `failed` outcome instead of
  //     looping a retry forever (no money-burning retry on a deterministic
  //     error).
  function rejectStep(failure: { error: string; conflict: boolean }): StepOutcome {
    if (failure.conflict) throw new MissionConcurrencyError(failure.error)
    return { kind: 'failed', error: failure.error, fatal: true }
  }

  function isStepCurrentOrFuture(mission: MissionRecord, stepId: string): boolean {
    const index = mission.plan.findIndex((candidate) => candidate.id === stepId)
    return index >= mission.cursor
  }

  const recordCost: MissionEngine['recordCost'] = async (missionId, deltaUsd, ledgerDelta) => {
    const recorded = await service.addCost(missionId, deltaUsd, ledgerDelta)
    if (!recorded.succeeded) return recorded
    safeEmit(sink, {
      type: 'cost.updated',
      missionId,
      at: Date.now(),
      spentUsd: recorded.value.spentUsd,
      capUsd: recorded.value.budgetUsd,
    })
    return recorded
  }

  const pauseMission: MissionEngine['pauseMission'] = async (missionId, reason) => {
    const before = await service.getMission(missionId)
    const paused = await service.pause(missionId, reason)
    if (!paused.succeeded) return paused
    if (before?.status !== 'paused') {
      safeEmit(sink, {
        type: 'mission.paused',
        missionId,
        at: Date.now(),
        reason: paused.value.pauseReason ?? reason,
      })
    }
    return paused
  }

  const runStep: MissionEngine['runStep'] = async (missionId, stepId, dispatch) => {
    const mission = await service.getMission(missionId)
    if (!mission) throw new MissionConcurrencyError(`Mission ${missionId} not found mid-run`)

    const stepIndex = mission.plan.findIndex((candidate) => candidate.id === stepId)
    const step = stepIndex < 0 ? undefined : mission.plan[stepIndex]
    if (!step) {
      return { kind: 'skipped-cursor', reason: `Step ${stepId} is no longer in mission plan` }
    }
    if (isMissionStopRequested(mission)) {
      return { kind: 'failed', error: mission.pauseReason ?? 'Mission stop requested', fatal: true }
    }
    if (mission.status !== 'running') {
      return { kind: 'skipped-cursor', reason: mission.pauseReason ?? `Mission is ${mission.status}` }
    }

    // (2) Idempotent short-circuit: a step that already reached `done` keeps
    // its resultRef. Return it WITHOUT re-running the side effect. Reconcile
    // the cursor first: a crash in the window between setStepStatus('done')
    // and advanceCursor leaves the cursor one slot behind this done step; a
    // fresh resume would otherwise end with cursor = plan.length - 1. Advance
    // it here (guarded — a lost race throws for the owner to retry) so the
    // cursor stays a true done-count.
    if (step.status === 'done' && step.resultRef) {
      if (stepIndex === mission.cursor) {
        const reconciled = await service.advanceCursor(missionId)
        if (!reconciled.succeeded) return rejectStep(reconciled)
      }
      // Re-emit the terminal event on replay so a client that connected after
      // the step finished still folds it (idempotent at the reducer).
      safeEmit(sink, { type: 'step.completed', missionId, at: Date.now(), stepId, ok: true })
      return { kind: 'done', resultRef: step.resultRef, cached: true }
    }

    // (3) The cursor has already moved past this step but it is not `done` —
    // the owner is replaying a step the engine no longer considers active.
    // Skip it rather than re-run; the cursor is the source of truth.
    if (stepIndex < mission.cursor) {
      return { kind: 'skipped-cursor', reason: `Step ${stepId} is behind cursor ${mission.cursor}` }
    }

    const startedAt = Date.now()
    if (step.status !== 'running') {
      const running = await service.setStepStatus(missionId, stepId, 'running')
      if (!running.succeeded) return rejectStep(running)
    }
    safeEmit(sink, { type: 'step.started', missionId, at: startedAt, stepId })

    let dispatched: SandboxDispatchResult
    try {
      dispatched = await dispatch({ mission, step, stepIndex })
    } catch (error) {
      // A TRANSIENT failure re-throws so the owner engages its bounded
      // retry+backoff: leave the step `running` (the re-dispatch is idempotent
      // via the cached-done guard) and let the owner re-attempt up to its limit.
      if (error instanceof RetryableStepError) throw error
      const latest = await service.getMission(missionId)
      if (
        latest &&
        !isMissionTerminal(latest.status) &&
        !isMissionStopRequested(latest) &&
        !isStepCurrentOrFuture(latest, stepId)
      ) {
        return { kind: 'skipped-cursor', reason: `Step ${stepId} is no longer active` }
      }
      // A deterministic failure is recorded as a fatal `failed` step and is
      // NOT retried — looping a retry on a deterministic error burns money.
      const message = error instanceof Error ? error.message : 'Sandbox dispatch failed'
      const failed = await service.setStepStatus(missionId, stepId, 'failed', { error: message })
      if (!failed.succeeded) return rejectStep(failed)
      safeEmit(sink, {
        type: 'step.completed',
        missionId,
        at: Date.now(),
        stepId,
        ok: false,
        reason: message,
        durationMs: Date.now() - startedAt,
      })
      return { kind: 'failed', error: message, fatal: isFatalStepKind(step.kind) }
    }

    const afterDispatch = await service.getMission(missionId)
    if (!afterDispatch) throw new MissionConcurrencyError(`Mission ${missionId} not found after dispatch`)
    if (isMissionTerminal(afterDispatch.status) || isMissionStopRequested(afterDispatch)) {
      return { kind: 'failed', error: afterDispatch.pauseReason ?? 'Mission stop requested', fatal: true }
    }
    if (afterDispatch.status !== 'running') {
      return { kind: 'skipped-cursor', reason: afterDispatch.pauseReason ?? `Mission is ${afterDispatch.status}` }
    }
    if (!isStepCurrentOrFuture(afterDispatch, stepId)) {
      return { kind: 'skipped-cursor', reason: `Step ${stepId} is no longer active` }
    }

    // The detached session is still running: surface the elapsed sublabel and
    // hand the poll cadence to the owner. The step row stays `running`.
    if (dispatched.kind === 'in_progress') {
      if (dispatched.sublabel !== undefined) {
        safeEmit(sink, { type: 'step.updated', missionId, at: Date.now(), stepId, sublabel: dispatched.sublabel })
      }
      return {
        kind: 'in_progress',
        sessionRef: dispatched.sessionRef,
        pollAfterMs: dispatched.pollAfterMs,
        ...(dispatched.sublabel === undefined ? {} : { sublabel: dispatched.sublabel }),
      }
    }

    // A live counter ("7/15") the dispatch surfaced — push it before the
    // terminal event so a long step shows progress, then settles to done.
    if (dispatched.sublabel !== undefined) {
      safeEmit(sink, { type: 'step.updated', missionId, at: Date.now(), stepId, sublabel: dispatched.sublabel })
    }

    // USD: provider-authored price when the dispatch reports one, the injected
    // estimate otherwise (the budget gate runs on the same estimate, so spend
    // and gate stay consistent). Token counts/wall time come from the
    // dispatch's ledgerDelta when the platform reported them. The spend is
    // folded into the SAME guarded pending->done write below so step completion
    // is the per-step idempotency key: a RESUME re-dispatching an already-done
    // step short-circuits as a no-op and never charges twice.
    const deltaUsd = dispatched.cost?.deltaUsd ?? estimateStepCostUsd(step)
    const chargeable = deltaUsd > 0 || Boolean(dispatched.cost?.ledgerDelta)
    const spentBefore = afterDispatch.spentUsd

    const done = await service.setStepStatus(missionId, stepId, 'done', {
      resultRef: dispatched.resultRef,
      ...(dispatched.sublabel === undefined ? {} : { sublabel: dispatched.sublabel }),
      ...(chargeable
        ? {
            cost: {
              deltaUsd,
              ledgerDelta: {
                costUsd: deltaUsd,
                llmCalls: 1,
                ...(dispatched.cost?.ledgerDelta ?? {}),
              },
            },
          }
        : {}),
    })
    if (!done.succeeded) return rejectStep(done)
    // Emit cost.updated only when the spend actually committed (a real
    // transition, not a replayed no-op that re-asserted an already-done step).
    if (done.value.spentUsd !== spentBefore) {
      safeEmit(sink, {
        type: 'cost.updated',
        missionId,
        at: Date.now(),
        spentUsd: done.value.spentUsd,
        capUsd: done.value.budgetUsd,
      })
    }
    safeEmit(sink, {
      type: 'step.completed',
      missionId,
      at: Date.now(),
      stepId,
      ok: true,
      durationMs: Date.now() - startedAt,
    })

    // Advance the cursor only after the step is durably `done`. A racing
    // advance (single owner ⇒ should not happen) surfaces as a retry.
    const advanced = await service.advanceCursor(missionId)
    if (!advanced.succeeded) return rejectStep(advanced)

    return { kind: 'done', resultRef: dispatched.resultRef, cached: false }
  }

  async function parkForApproval(
    mission: MissionRecord,
    step: MissionStep,
    reason: string,
  ): Promise<StepGateOutcome> {
    const waiting = await service.markWaitingApproval(mission.id, step.id)
    if (!waiting.succeeded) {
      if (waiting.conflict) throw new MissionConcurrencyError(waiting.error)
      return { kind: 'halted', status: mission.status, reason: waiting.error }
    }
    safeEmit(sink, {
      type: 'mission.waiting_approval',
      missionId: mission.id,
      at: Date.now(),
      reason,
    })
    safeEmit(sink, {
      type: 'mission.plan.updated',
      missionId: mission.id,
      at: Date.now(),
      title: waiting.value.summary ?? 'Mission',
      steps: waiting.value.plan.map((candidate) => ({
        id: candidate.id,
        intent: candidate.intent,
        kind: candidate.kind,
        status: candidate.status,
      })),
      budgetUsd: waiting.value.budgetUsd,
    })
    return { kind: 'halted', status: 'waiting_approval', reason }
  }

  // A budgeted mission never starts a step whose estimate would push spend
  // past the cap. With an approvals port the overrun parks behind a
  // deterministic override proposal; without one it pauses (fail closed) for a
  // manual budget raise + resume.
  async function enforceBudget(mission: MissionRecord, step: MissionStep): Promise<StepGateOutcome> {
    const capUsd = mission.budgetUsd
    if (capUsd === null) return { kind: 'continue' }
    const estimatedCostUsd = estimateStepCostUsd(step)
    if (estimatedCostUsd <= 0) return { kind: 'continue' }
    // Compare in integer cents: USD amounts accumulate binary-float error (e.g.
    // 0.1 + 0.2 > 0.3), so a raw float compare can spuriously trip the gate at
    // the exact cap. Cent-rounding makes the boundary deterministic.
    if (Math.round((mission.spentUsd + estimatedCostUsd) * 100) <= Math.round(capUsd * 100)) {
      return { kind: 'continue' }
    }

    if (!gates) {
      const reason = `Budget cap reached before step ${step.id}: $${mission.spentUsd.toFixed(2)} spent of $${capUsd.toFixed(2)}, next step estimated $${estimatedCostUsd.toFixed(2)}`
      const paused = await pauseMission(mission.id, reason)
      if (!paused.succeeded) {
        if (paused.conflict) throw new MissionConcurrencyError(paused.error)
        return { kind: 'halted', status: mission.status, reason: paused.error }
      }
      return { kind: 'halted', status: paused.value.status, reason }
    }

    const proposalId = budgetGateProposalId(mission.id, step.id)
    const resolution = await gates.approvals.findResolution(proposalId)
    if (unblocked(resolution)) return { kind: 'continue' }
    if (resolution === null) {
      await gates.approvals.createProposal({
        id: proposalId,
        missionId: mission.id,
        stepId: step.id,
        gate: 'budget',
        mission,
        step,
        budget: { spentUsd: mission.spentUsd, budgetUsd: capUsd, estimatedCostUsd },
      })
    }
    return parkForApproval(mission, step, `Budget approval required for step ${step.id}`)
  }

  async function enforceVolumeCap(mission: MissionRecord, step: MissionStep): Promise<StepGateOutcome> {
    if (!gates) return { kind: 'continue' }
    const overrideId = volumeGateProposalId(mission.id, step.id)
    const override = await gates.approvals.findResolution(overrideId)
    if (unblocked(override)) return { kind: 'continue' }

    const externalCount = await gates.approvals.countExternalActionProposals(mission.id)
    if (externalCount < externalActionCap) return { kind: 'continue' }

    if (override === null) {
      await gates.approvals.createProposal({
        id: overrideId,
        missionId: mission.id,
        stepId: step.id,
        gate: 'volume',
        mission,
        step,
        volume: { externalActionCount: externalCount, cap: externalActionCap },
      })
    }
    return parkForApproval(mission, step, `External action cap approval required for step ${step.id}`)
  }

  async function enforceStepGate(mission: MissionRecord, step: MissionStep): Promise<StepGateOutcome> {
    if (!gates) return { kind: 'continue' }
    const classification = gates.classifyStep(step)
    if (!classification) return { kind: 'continue' }

    if (classification.externalAction) {
      const volume = await enforceVolumeCap(mission, step)
      if (volume.kind === 'halted') return volume
    }

    const proposalId = stepGateProposalId(mission.id, step.id)
    const resolution = await gates.approvals.findResolution(proposalId)
    if (unblocked(resolution)) return { kind: 'continue' }

    if (resolution === null) {
      await gates.approvals.createProposal({
        id: proposalId,
        missionId: mission.id,
        stepId: step.id,
        gate: 'step',
        mission,
        step,
        classification,
      })
    }
    return parkForApproval(mission, step, `Approval required for step ${step.id}`)
  }

  const runPlan: MissionEngine['runPlan'] = async (missionId, runStepFn, planOptions = {}) => {
    const mission = await service.getMission(missionId)
    if (!mission) return { kind: 'not-found' }
    if (isMissionTerminal(mission.status)) {
      // Already terminal on entry (a replay after the row finished, or a
      // resume of an aborted/cancelled run). Re-emit the terminal event so a
      // client that connected during an outage still converges off this run.
      // Idempotent at the reducer.
      safeEmit(sink, terminalMissionEvent(missionId, mission.status))
      return { kind: 'terminal', status: mission.status }
    }

    // Resume from the durable cursor. Re-read the mission between steps so a
    // pause/stop control that lands while a step is running is honored before
    // the next side effect starts.
    while (true) {
      const currentMission = await service.getMission(missionId)
      if (!currentMission) return { kind: 'not-found' }
      if (isMissionTerminal(currentMission.status)) {
        safeEmit(sink, terminalMissionEvent(missionId, currentMission.status))
        return { kind: 'terminal', status: currentMission.status }
      }
      if (isMissionStopRequested(currentMission)) {
        return {
          kind: 'halted',
          status: currentMission.status,
          reason: currentMission.pauseReason ?? 'Mission stop requested',
        }
      }
      if (currentMission.status !== 'running') {
        return {
          kind: 'halted',
          status: currentMission.status,
          reason: currentMission.pauseReason,
        }
      }

      const index = currentMission.cursor
      if (index >= currentMission.plan.length) break
      const step = currentMission.plan[index]
      if (!step) break

      const haltReason = await planOptions.beforeStep?.(currentMission, step)
      if (haltReason) {
        const paused = await pauseMission(missionId, haltReason)
        if (!paused.succeeded) throw new MissionConcurrencyError(paused.error)
        return { kind: 'halted', status: paused.value.status, reason: paused.value.pauseReason ?? haltReason }
      }

      if (step.status !== 'done') {
        const budget = await enforceBudget(currentMission, step)
        if (budget.kind === 'halted') {
          return { kind: 'halted', status: budget.status, reason: budget.reason }
        }
        const gate = await enforceStepGate(currentMission, step)
        if (gate.kind === 'halted') {
          return { kind: 'halted', status: gate.status, reason: gate.reason }
        }
      }

      const outcome = await runStepFn(step, index)
      if (outcome.kind === 'failed' && outcome.fatal) {
        // The owner flips the mission row to `failed` on this outcome; emit the
        // live terminal event here so a watcher sees the failure without
        // waiting for the next loader poll. Idempotent at the reducer.
        safeEmit(sink, {
          type: 'mission.completed',
          missionId,
          at: Date.now(),
          ok: false,
          summary: `Step ${step.id} failed: ${outcome.error}`,
        })
        return { kind: 'failed', failedStepId: step.id, error: outcome.error }
      }
      if (outcome.kind === 'failed' && !outcome.fatal) {
        const advanced = await service.advanceCursor(missionId)
        if (!advanced.succeeded) throw new MissionConcurrencyError(advanced.error)
      }
      if (outcome.kind === 'in_progress') {
        return {
          kind: 'in_progress',
          stepId: step.id,
          sessionRef: outcome.sessionRef,
          pollAfterMs: outcome.pollAfterMs,
          ...(outcome.sublabel === undefined ? {} : { sublabel: outcome.sublabel }),
        }
      }
      // Cursor-skips fall through: another pass already moved past it. The next
      // loop re-reads the authoritative cursor and plan.
    }

    const finalMission = await service.getMission(missionId)
    const planLength = finalMission?.plan.length ?? 0
    const summary = `Completed ${planLength} step${planLength === 1 ? '' : 's'}`
    const completed = await service.complete(missionId, { ok: true, summary })
    if (!completed.succeeded) {
      // complete() is guarded; a concurrent terminal transition (abort/cancel)
      // wins the race. Re-read to report the real terminal status rather than
      // claim a completion that did not land.
      const after = await service.getMission(missionId)
      if (after && isMissionTerminal(after.status)) {
        safeEmit(sink, terminalMissionEvent(missionId, after.status))
        return { kind: 'terminal', status: after.status }
      }
      throw new MissionConcurrencyError(completed.error)
    }
    safeEmit(sink, { type: 'mission.completed', missionId, at: Date.now(), ok: true, summary })
    return { kind: 'completed', summary }
  }

  return { runStep, runPlan, recordCost, pauseMission }
}
