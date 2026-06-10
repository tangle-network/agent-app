import { describe, expect, it, vi } from 'vitest'

import {
  budgetGateProposalId,
  createInMemoryMissionStore,
  createMissionEngine,
  createMissionService,
  MissionConcurrencyError,
  RetryableStepError,
  stepGateProposalId,
  volumeGateProposalId,
  type InMemoryMissionStore,
  type MissionApprovalsPort,
  type MissionEngine,
  type MissionGateProposal,
  type MissionProposalResolution,
  type MissionService,
  type MissionStep,
  type MissionStorePort,
  type MissionStreamEvent,
  type SandboxDispatch,
  type StepGateClassification,
  type StepOutcome,
} from '../src/missions/index'

// Engine logic with the dispatch MOCKED. These assert the crash-resume /
// idempotency contract the durable owner (e.g. a Cloudflare Workflow) relies
// on, without a live runtime: each `runStep` callback below stands in for the
// `step.do(stepId, retryConfig, () => engine.runStep(...))` the owner wraps it
// in. Domain (classification rules, cost tables, approval persistence) is
// supplied through the seams, exactly as a product would.

const WORKSPACE_ID = 'ws-test'

function threeStepPlan(): MissionStep[] {
  return [
    { id: 'recon', intent: 'probe', kind: 'research', status: 'pending', attempts: 0 },
    { id: 'workspace', intent: 'stage', kind: 'analyze', status: 'pending', attempts: 0 },
    { id: 'report', intent: 'emit', kind: 'write', status: 'pending', attempts: 0 },
  ]
}

// A dispatch that records every step it was asked to run and returns a unique
// resultRef per step. The recorded list is how a test proves a step was (or
// was NOT) re-executed.
function recordingDispatch(): { dispatch: SandboxDispatch; ran: string[] } {
  const ran: string[] = []
  const dispatch: SandboxDispatch = async ({ step }) => {
    ran.push(step.id)
    return { resultRef: `artifact:${step.id}`, sublabel: `ran ${step.id}` }
  }
  return { dispatch, ran }
}

// In-memory approvals port — the product's proposal table stand-in. Proposals
// resolve via `resolve`; `seedExternalCount` simulates prior external-action
// approvals already requested by this mission.
function approvalsFake() {
  const proposals = new Map<string, { proposal: MissionGateProposal; resolution: MissionProposalResolution }>()
  let externalSeed = 0
  const port: MissionApprovalsPort = {
    async findResolution(proposalId) {
      return proposals.get(proposalId)?.resolution ?? null
    },
    async createProposal(proposal) {
      proposals.set(proposal.id, { proposal, resolution: 'pending' })
    },
    async countExternalActionProposals(missionId) {
      const created = [...proposals.values()].filter(
        (entry) =>
          entry.proposal.missionId === missionId &&
          entry.proposal.gate === 'step' &&
          entry.proposal.classification?.externalAction === true,
      ).length
      return externalSeed + created
    },
  }
  return {
    port,
    resolve(proposalId: string, resolution: MissionProposalResolution) {
      const entry = proposals.get(proposalId)
      if (!entry) throw new Error(`no proposal ${proposalId}`)
      entry.resolution = resolution
    },
    get(proposalId: string) {
      return proposals.get(proposalId)
    },
    all() {
      return [...proposals.values()]
    },
    seedExternalCount(n: number) {
      externalSeed = n
    },
  }
}

// Product classification stand-in: 'generate' steps and external-action
// intents are gated; everything else runs free. The rules living HERE (in the
// consumer) is the point of the seam.
function testClassify(step: MissionStep): StepGateClassification | null {
  if (step.kind === 'generate') return { type: 'generate', estCostUsd: 0.25 }
  if (/\b(publish|upload|send|post)\b/.test(step.intent.toLowerCase())) {
    return { type: 'integration_invoke', externalAction: true }
  }
  return null
}

function estimate(step: MissionStep): number {
  return step.kind === 'generate' ? 0.5 : 0.05
}

interface Harness {
  store: InMemoryMissionStore
  service: MissionService
  engine: MissionEngine
  approvals: ReturnType<typeof approvalsFake>
  emitted: MissionStreamEvent[]
  raceOnce(fn: () => void | Promise<void>): void
  createMission(plan: MissionStep[], opts?: { budgetUsd?: number; title?: string }): Promise<string>
  directRunStep(missionId: string, dispatch: SandboxDispatch): (step: MissionStep) => Promise<StepOutcome>
  eventSteps(missionId: string): string[]
}

function harness(opts: { gated?: boolean; sinkThrows?: boolean } = {}): Harness {
  const store = createInMemoryMissionStore()
  let hook: (() => void | Promise<void>) | null = null
  const racingStore: MissionStorePort = {
    load: (id) => store.load(id),
    insert: (record) => store.insert(record),
    appendEvent: (event) => store.appendEvent(event),
    async update(id, guard, patch) {
      if (hook) {
        const fn = hook
        hook = null
        await fn()
      }
      return store.update(id, guard, patch)
    },
  }
  const service = createMissionService({ store: racingStore })
  const approvals = approvalsFake()
  const emitted: MissionStreamEvent[] = []
  const engine = createMissionEngine({
    service,
    estimateStepCostUsd: estimate,
    sink: {
      emit(event) {
        emitted.push(event)
        if (opts.sinkThrows) throw new Error('socket down')
      },
    },
    ...(opts.gated ? { gates: { approvals: approvals.port, classifyStep: testClassify } } : {}),
  })
  return {
    store,
    service,
    engine,
    approvals,
    emitted,
    raceOnce(fn) {
      hook = fn
    },
    async createMission(plan, mopts = {}) {
      const mission = await service.createMission({
        workspaceId: WORKSPACE_ID,
        title: mopts.title ?? 'Mission',
        plan,
        trigger: 'manual',
        ...(mopts.budgetUsd === undefined ? {} : { budgetUsd: mopts.budgetUsd }),
      })
      return mission.id
    },
    directRunStep(missionId, dispatch) {
      return (step) => engine.runStep(missionId, step.id, dispatch)
    },
    eventSteps(missionId) {
      return store.events().filter((event) => event.missionId === missionId).map((event) => event.step)
    },
  }
}

describe('mission engine', () => {
  it('runs a full plan: every step dispatched once, cursor walked, mission succeeded', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    const { dispatch, ran } = recordingDispatch()
    const outcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(outcome).toEqual({ kind: 'completed', summary: 'Completed 3 steps' })
    expect(ran).toEqual(['recon', 'workspace', 'report'])

    const after = await h.service.getMission(missionId)
    expect(after?.status).toBe('succeeded')
    expect(after?.cursor).toBe(3)
    expect(typeof after?.completedAt).toBe('number')
    expect(after?.plan.every((step) => step.status === 'done')).toBe(true)
    expect(after?.plan.map((step) => step.resultRef)).toEqual([
      'artifact:recon',
      'artifact:workspace',
      'artifact:report',
    ])
  })

  it('halts before the next step when a pause lands during the current step', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())
    const { dispatch, ran } = recordingDispatch()

    const outcome = await h.engine.runPlan(missionId, async (step) => {
      const result = await h.engine.runStep(missionId, step.id, dispatch)
      if (step.id === 'recon') {
        const paused = await h.service.pause(missionId, 'User pause')
        expect(paused.succeeded).toBe(true)
      }
      return result
    })

    expect(outcome).toEqual({ kind: 'halted', status: 'paused', reason: 'User pause' })
    expect(ran).toEqual(['recon'])
    const after = await h.service.getMission(missionId)
    expect(after?.status).toBe('paused')
    expect(after?.cursor).toBe(1)
    expect(after?.plan[0]?.status).toBe('done')
    expect(after?.plan[1]?.status).toBe('pending')
  })

  it('returns in_progress without advancing the cursor while a detached session runs', async () => {
    const h = harness()
    const missionId = await h.createMission([
      { id: 'long-research', intent: 'Long-running evidence gathering', kind: 'research', status: 'pending', attempts: 0 },
    ])
    const dispatch: SandboxDispatch = async () => ({
      kind: 'in_progress',
      sessionRef: 'session:mission-x-long-research',
      pollAfterMs: 20_000,
      sublabel: 'Working in sandbox (30s elapsed)',
    })

    const outcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(outcome).toEqual({
      kind: 'in_progress',
      stepId: 'long-research',
      sessionRef: 'session:mission-x-long-research',
      pollAfterMs: 20_000,
      sublabel: 'Working in sandbox (30s elapsed)',
    })
    const after = await h.service.getMission(missionId)
    expect(after?.status).toBe('running')
    expect(after?.cursor).toBe(0)
    expect(after?.plan[0]?.status).toBe('running')
    expect(after?.completedAt).toBeNull()
  })

  it('does not dispatch a paused mission when a session poll wakes up', async () => {
    const h = harness()
    const missionId = await h.createMission([
      { id: 'long-research', intent: 'Long-running evidence gathering', kind: 'research', status: 'pending', attempts: 0 },
    ])
    await h.service.setStepStatus(missionId, 'long-research', 'running')
    await h.service.pause(missionId, 'User pause')
    const dispatch = vi.fn<SandboxDispatch>(async () => ({ resultRef: 'artifact:unexpected' }))

    const outcome = await h.engine.runStep(missionId, 'long-research', dispatch)

    expect(outcome).toEqual({ kind: 'skipped-cursor', reason: 'User pause' })
    expect(dispatch).not.toHaveBeenCalled()
    const after = await h.service.getMission(missionId)
    expect(after?.cursor).toBe(0)
    expect(after?.plan[0]?.status).toBe('running')
  })

  it('does not dispatch a waiting-approval mission when a session poll wakes up', async () => {
    const h = harness()
    const missionId = await h.createMission([
      { id: 'long-research', intent: 'Long-running evidence gathering', kind: 'research', status: 'pending', attempts: 0 },
    ])
    await h.service.markWaitingApproval(missionId, 'long-research')
    const dispatch = vi.fn<SandboxDispatch>(async () => ({ resultRef: 'artifact:unexpected' }))

    const outcome = await h.engine.runStep(missionId, 'long-research', dispatch)

    expect(outcome).toEqual({ kind: 'skipped-cursor', reason: 'Mission is waiting_approval' })
    expect(dispatch).not.toHaveBeenCalled()
    const after = await h.service.getMission(missionId)
    expect(after?.cursor).toBe(0)
    expect(after?.plan[0]?.status).toBe('waiting_approval')
  })

  it('does not dispatch an aborted mission when a session poll wakes up', async () => {
    const h = harness()
    const missionId = await h.createMission([
      { id: 'long-research', intent: 'Long-running evidence gathering', kind: 'research', status: 'pending', attempts: 0 },
    ])
    await h.service.setStepStatus(missionId, 'long-research', 'running')
    await h.service.abort(missionId)
    const dispatch = vi.fn<SandboxDispatch>(async () => ({ resultRef: 'artifact:unexpected' }))

    const outcome = await h.engine.runStep(missionId, 'long-research', dispatch)

    expect(outcome).toEqual({ kind: 'skipped-cursor', reason: 'Mission is aborted' })
    expect(dispatch).not.toHaveBeenCalled()
    const after = await h.service.getMission(missionId)
    expect(after?.cursor).toBe(0)
    expect(after?.status).toBe('aborted')
  })

  it('a stop request is honored before dispatch as a fatal failure', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())
    await h.service.mergeMetadata(missionId, { stopRequested: true })
    const dispatch = vi.fn<SandboxDispatch>(async () => ({ resultRef: 'artifact:unexpected' }))

    const outcome = await h.engine.runStep(missionId, 'recon', dispatch)

    expect(outcome).toEqual({ kind: 'failed', error: 'Mission stop requested', fatal: true })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('parks a gated mission step before dispatch and resumes after approval', async () => {
    const h = harness({ gated: true })
    const missionId = await h.createMission([
      { id: 'make-image', intent: 'Generate campaign image', kind: 'generate', status: 'pending', attempts: 0 },
    ])
    const { dispatch, ran } = recordingDispatch()

    const parked = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(parked).toEqual({
      kind: 'halted',
      status: 'waiting_approval',
      reason: 'Approval required for step make-image',
    })
    expect(ran).toEqual([])
    const proposalId = stepGateProposalId(missionId, 'make-image')
    const entry = h.approvals.get(proposalId)
    expect(entry?.resolution).toBe('pending')
    expect(entry?.proposal).toMatchObject({
      id: proposalId,
      gate: 'step',
      missionId,
      stepId: 'make-image',
      classification: { type: 'generate', estCostUsd: 0.25 },
    })
    const waiting = await h.service.getMission(missionId)
    expect(waiting?.status).toBe('waiting_approval')
    expect(waiting?.plan[0]?.status).toBe('waiting_approval')

    h.approvals.resolve(proposalId, 'approved')
    await h.service.resume(missionId)

    const completed = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))
    expect(completed).toEqual({ kind: 'completed', summary: 'Completed 1 step' })
    expect(ran).toEqual(['make-image'])
    // The replayed gate pass found the approved proposal — no duplicate created.
    expect(h.approvals.all()).toHaveLength(1)
  })

  it('an ungated step runs without any proposal', async () => {
    const h = harness({ gated: true })
    const missionId = await h.createMission([
      { id: 'study', intent: 'Study the channel transcripts for hook patterns', kind: 'research', status: 'pending', attempts: 0 },
    ])
    const { dispatch, ran } = recordingDispatch()

    const completed = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(completed).toEqual({ kind: 'completed', summary: 'Completed 1 step' })
    expect(ran).toEqual(['study'])
    expect(h.approvals.all()).toHaveLength(0)
  })

  it('parks before a step that would exceed the mission budget (approvals port wired)', async () => {
    const h = harness({ gated: true })
    const missionId = await h.createMission(
      [{ id: 'draft', intent: 'Write the article', kind: 'write', status: 'pending', attempts: 0 }],
      { budgetUsd: 0.01 },
    )
    const { dispatch, ran } = recordingDispatch()

    const parked = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(parked).toEqual({
      kind: 'halted',
      status: 'waiting_approval',
      reason: 'Budget approval required for step draft',
    })
    expect(ran).toEqual([])
    const proposalId = budgetGateProposalId(missionId, 'draft')
    expect(h.approvals.get(proposalId)?.proposal).toMatchObject({
      gate: 'budget',
      budget: { spentUsd: 0, budgetUsd: 0.01, estimatedCostUsd: 0.05 },
    })

    h.approvals.resolve(proposalId, 'approved')
    await h.service.resume(missionId)
    const completed = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))
    expect(completed).toEqual({ kind: 'completed', summary: 'Completed 1 step' })
    expect(ran).toEqual(['draft'])
  })

  it('pauses (fail closed) on a budget overrun when no approvals port is wired', async () => {
    const h = harness()
    const missionId = await h.createMission(
      [{ id: 'draft', intent: 'Write the article', kind: 'write', status: 'pending', attempts: 0 }],
      { budgetUsd: 0.01 },
    )
    const { dispatch, ran } = recordingDispatch()

    const halted = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(halted).toMatchObject({ kind: 'halted', status: 'paused' })
    expect(halted.kind === 'halted' && halted.reason).toContain('Budget cap reached before step draft')
    expect(ran).toEqual([])
    const after = await h.service.getMission(missionId)
    expect(after?.status).toBe('paused')
  })

  it('parks when the external-action volume cap needs an override, then gates the step itself', async () => {
    const h = harness({ gated: true })
    const missionId = await h.createMission([
      { id: 'post-6', intent: 'Publish another LinkedIn post', kind: 'write', status: 'pending', attempts: 0 },
    ])
    h.approvals.seedExternalCount(5)
    const { dispatch, ran } = recordingDispatch()

    const parked = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(parked).toEqual({
      kind: 'halted',
      status: 'waiting_approval',
      reason: 'External action cap approval required for step post-6',
    })
    expect(ran).toEqual([])
    const overrideId = volumeGateProposalId(missionId, 'post-6')
    expect(h.approvals.get(overrideId)?.proposal).toMatchObject({
      gate: 'volume',
      volume: { externalActionCount: 5, cap: 5 },
    })

    // Override approved: the volume cap clears, but the external-action step
    // STILL needs its own step-gate approval before dispatch.
    h.approvals.resolve(overrideId, 'approved')
    await h.service.resume(missionId)
    const stepParked = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))
    expect(stepParked).toEqual({
      kind: 'halted',
      status: 'waiting_approval',
      reason: 'Approval required for step post-6',
    })
    expect(ran).toEqual([])

    h.approvals.resolve(stepGateProposalId(missionId, 'post-6'), 'approved')
    await h.service.resume(missionId)
    const completed = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))
    expect(completed).toEqual({ kind: 'completed', summary: 'Completed 1 step' })
    expect(ran).toEqual(['post-6'])
  })

  it('a rejected gate proposal keeps the mission parked without duplicating the proposal', async () => {
    const h = harness({ gated: true })
    const missionId = await h.createMission([
      { id: 'make-image', intent: 'Generate campaign image', kind: 'generate', status: 'pending', attempts: 0 },
    ])
    const { dispatch, ran } = recordingDispatch()

    await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))
    h.approvals.resolve(stepGateProposalId(missionId, 'make-image'), 'rejected')
    await h.service.resume(missionId)

    const reParked = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))
    expect(reParked).toEqual({
      kind: 'halted',
      status: 'waiting_approval',
      reason: 'Approval required for step make-image',
    })
    expect(ran).toEqual([])
    expect(h.approvals.all()).toHaveLength(1)
  })

  it('pauses before a step when the beforeStep kill switch fires', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())
    const { dispatch, ran } = recordingDispatch()

    const halted = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch), {
      beforeStep: async () => 'Mission kill switch is enabled',
    })

    expect(halted).toEqual({ kind: 'halted', status: 'paused', reason: 'Mission kill switch is enabled' })
    expect(ran).toEqual([])
    const after = await h.service.getMission(missionId)
    expect(after?.status).toBe('paused')
    expect(after?.pauseReason).toBe('Mission kill switch is enabled')
  })

  it('skips a step already done without re-dispatching the side effect', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    // Pre-complete the first step the way a prior (crashed-after-commit) run
    // would have left it: running -> done with a resultRef.
    await h.service.setStepStatus(missionId, 'recon', 'running')
    await h.service.setStepStatus(missionId, 'recon', 'done', { resultRef: 'artifact:prior-recon' })

    const { dispatch, ran } = recordingDispatch()
    const outcome = await h.engine.runStep(missionId, 'recon', dispatch)

    expect(outcome).toEqual({ kind: 'done', resultRef: 'artifact:prior-recon', cached: true })
    // The mock was never invoked — the cached pointer was returned as-is.
    expect(ran).toEqual([])
  })

  it('reconciles a done step whose cursor never advanced: final cursor === plan.length', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    // Simulate a crash in the window between setStepStatus('done') and
    // advanceCursor: step 1 is `done` with a resultRef but the cursor is still
    // 0 (the advance never committed). A fresh engine-driven resume (no
    // durable-step cache) re-walks step 1 at stepIndex === cursor.
    await h.service.setStepStatus(missionId, 'recon', 'running')
    await h.service.setStepStatus(missionId, 'recon', 'done', { resultRef: 'artifact:prior-recon' })

    const before = await h.service.getMission(missionId)
    expect(before?.cursor).toBe(0)
    expect(before?.plan[0]?.status).toBe('done')

    const { dispatch, ran } = recordingDispatch()
    const outcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(outcome).toEqual({ kind: 'completed', summary: 'Completed 3 steps' })
    // The done step is NOT re-dispatched; only the two remaining steps run.
    expect(ran).toEqual(['workspace', 'report'])

    const after = await h.service.getMission(missionId)
    // Cursor reconciled forward past the done step — ends at plan.length, not
    // plan.length - 1.
    expect(after?.cursor).toBe(3)
    expect(after?.status).toBe('succeeded')
  })

  it('resumes from the cursor and only runs the remaining steps', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    // Simulate a crash AFTER step 1 finished: step done + cursor advanced to 1
    // (the prior run's advanceCursor committed before the crash).
    await h.service.setStepStatus(missionId, 'recon', 'running')
    await h.service.setStepStatus(missionId, 'recon', 'done', { resultRef: 'artifact:prior-recon' })
    await h.service.advanceCursor(missionId)

    const { dispatch, ran } = recordingDispatch()
    const outcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    expect(outcome).toEqual({ kind: 'completed', summary: 'Completed 3 steps' })
    // Step 1 (recon) is behind the cursor and already done — NOT re-run. Only
    // the remaining two steps are dispatched.
    expect(ran).toEqual(['workspace', 'report'])

    const after = await h.service.getMission(missionId)
    expect(after?.status).toBe('succeeded')
    expect(after?.cursor).toBe(3)
    // The resumed steps keep their fresh resultRefs; recon keeps the prior one.
    expect(after?.plan.map((step) => step.resultRef)).toEqual([
      'artifact:prior-recon',
      'artifact:workspace',
      'artifact:report',
    ])
  })

  it('a concurrent change throws MissionConcurrencyError (retry), it does not corrupt state', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    // Drive the step to 'running' FIRST (a real transition) so the one-shot
    // race hook does not fire on it. Inside runStep the running re-assert is
    // then a no-op, and the FIRST guarded write is the post-dispatch cost
    // merge — that is the one we race.
    await h.service.setStepStatus(missionId, 'recon', 'running')

    // A second owner merges the cost ledger between this run's read and its
    // guarded ledger write, so the cost guard misses and the service reports
    // the conflict. The engine must THROW MissionConcurrencyError (so the
    // owner's durable-step wrapper retries) — never force a stale write.
    const { dispatch, ran } = recordingDispatch()
    h.raceOnce(async () => {
      const current = await h.store.load(missionId)
      if (!current) throw new Error('mission missing')
      h.store.put({
        ...current,
        cost: { tokensIn: 0, tokensOut: 0, costUsd: 1.23, wallMs: 0, llmCalls: 7 },
        spentUsd: 1.23,
      })
    })

    await expect(h.engine.runStep(missionId, 'recon', dispatch)).rejects.toBeInstanceOf(
      MissionConcurrencyError,
    )

    // The dispatch DID run (the race is on the write-back, after the side
    // effect) — the owner's retry re-runs it, and the re-run's idempotency
    // re-read keeps the work correct. State is intact: the concurrent write
    // landed, our stale write did not clobber it, and the step never reached
    // `done`.
    expect(ran).toEqual(['recon'])
    const after = await h.service.getMission(missionId)
    expect(after?.cursor).toBe(0)
    expect(after?.plan[0]?.status).toBe('running')
    expect(after?.status).toBe('running')
    expect(after?.spentUsd).toBe(1.23)
    expect(after?.cost?.costUsd).toBe(1.23)
    expect(after?.cost?.llmCalls).toBe(7)
  })

  it('re-throws a transient RetryableStepError (so the owner retries) and leaves the step running', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    const transient: SandboxDispatch = vi.fn(async () => {
      throw new RetryableStepError('platform_unavailable: 503')
    })

    // runStep must RE-THROW the retryable error (not swallow it into a
    // returned `failed`) so the owner engages its bounded retry+backoff.
    await expect(h.engine.runStep(missionId, 'recon', transient)).rejects.toBeInstanceOf(
      RetryableStepError,
    )

    const after = await h.service.getMission(missionId)
    // The step is left `running` (NOT `failed`) and the cursor has not
    // advanced — the re-attempt resumes it; the cached-done guard makes the
    // redo idempotent.
    expect(after?.plan[0]?.status).toBe('running')
    expect(after?.cursor).toBe(0)
    expect(after?.status).toBe('running')
  })

  it('a fatal step failure stops the plan and reports the failed step', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    const failing: SandboxDispatch = vi.fn(async ({ step }) => {
      if (step.id === 'workspace') throw new Error('sandbox exec exited 1')
      return { resultRef: `artifact:${step.id}` }
    })

    const outcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, failing))

    expect(outcome).toEqual({ kind: 'failed', failedStepId: 'workspace', error: 'sandbox exec exited 1' })
    // recon + workspace dispatched (workspace threw); report never reached.
    expect(failing).toHaveBeenCalledTimes(2)

    const after = await h.service.getMission(missionId)
    // Step 1 done + cursor advanced; step 2 failed; mission NOT terminalized
    // here (the owner marks it failed on the failed PlanOutcome).
    expect(after?.cursor).toBe(1)
    expect(after?.plan[0]?.status).toBe('done')
    expect(after?.plan[1]?.status).toBe('failed')
    expect(after?.status).toBe('running')
  })

  it('a non-fatal step kind failure advances the cursor and the plan continues', async () => {
    const h = harness()
    const missionId = await h.createMission([
      { id: 'enrich', intent: 'optional enrichment', kind: 'best-effort', status: 'pending', attempts: 0 },
      { id: 'report', intent: 'emit', kind: 'write', status: 'pending', attempts: 0 },
    ])

    const failing: SandboxDispatch = vi.fn(async ({ step }) => {
      if (step.id === 'enrich') throw new Error('enrichment source unavailable')
      return { resultRef: `artifact:${step.id}` }
    })

    const outcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, failing))

    expect(outcome).toEqual({ kind: 'completed', summary: 'Completed 2 steps' })
    const after = await h.service.getMission(missionId)
    expect(after?.status).toBe('succeeded')
    expect(after?.plan[0]?.status).toBe('failed')
    expect(after?.plan[1]?.status).toBe('done')
    expect(after?.cursor).toBe(2)
  })

  it('runPlan short-circuits on a terminal mission and a missing mission', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())
    await h.service.abort(missionId)

    const { dispatch, ran } = recordingDispatch()
    const terminalOutcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))
    expect(terminalOutcome).toEqual({ kind: 'terminal', status: 'aborted' })
    expect(ran).toEqual([])

    const missing = await h.engine.runPlan('does-not-exist', h.directRunStep('does-not-exist', dispatch))
    expect(missing).toEqual({ kind: 'not-found' })
  })

  it('re-running a completed plan is a no-op: terminal outcome, no re-dispatch', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())

    const first = recordingDispatch()
    await h.engine.runPlan(missionId, h.directRunStep(missionId, first.dispatch))
    expect(first.ran).toEqual(['recon', 'workspace', 'report'])

    // A full re-run (e.g. a crash-and-restart after completion) finds the
    // mission terminal and never touches the dispatch again.
    const second = recordingDispatch()
    const replay = await h.engine.runPlan(missionId, h.directRunStep(missionId, second.dispatch))
    expect(replay).toEqual({ kind: 'terminal', status: 'succeeded' })
    expect(second.ran).toEqual([])
  })

  it('writes a real audit event per step transition (engine drives the service)', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())
    const { dispatch } = recordingDispatch()
    await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    // created, then per step: running, estimated cost, done, cursor; then
    // mission.succeeded. Every step records a non-zero estimated cost when the
    // dispatch surfaces no provider-authored spend.
    expect(h.eventSteps(missionId)).toEqual([
      'mission.created',
      'mission.step.running',
      'mission.cost',
      'mission.step.done',
      'mission.cursor',
      'mission.step.running',
      'mission.cost',
      'mission.step.done',
      'mission.cursor',
      'mission.step.running',
      'mission.cost',
      'mission.step.done',
      'mission.cursor',
      'mission.succeeded',
    ])
  })

  it('emits live events after commits, and a throwing sink never fails the step', async () => {
    const h = harness({ sinkThrows: true })
    const missionId = await h.createMission([
      { id: 'solo', intent: 'one step', kind: 'write', status: 'pending', attempts: 0 },
    ])
    const { dispatch, ran } = recordingDispatch()

    const outcome = await h.engine.runPlan(missionId, h.directRunStep(missionId, dispatch))

    // Every emit threw, yet the plan ran to completion — the sink is
    // fire-and-forget at the engine boundary.
    expect(outcome).toEqual({ kind: 'completed', summary: 'Completed 1 step' })
    expect(ran).toEqual(['solo'])
    expect(h.emitted.map((event) => event.type)).toEqual([
      'step.started',
      'step.updated',
      'cost.updated',
      'step.completed',
      'mission.completed',
    ])
  })

  it('re-emits the terminal step event on a cached replay so reconnecting clients converge', async () => {
    const h = harness()
    const missionId = await h.createMission(threeStepPlan())
    await h.service.setStepStatus(missionId, 'recon', 'running')
    await h.service.setStepStatus(missionId, 'recon', 'done', { resultRef: 'artifact:prior' })
    await h.service.advanceCursor(missionId)
    h.emitted.length = 0

    const { dispatch } = recordingDispatch()
    const outcome = await h.engine.runStep(missionId, 'recon', dispatch)

    expect(outcome).toEqual({ kind: 'done', resultRef: 'artifact:prior', cached: true })
    expect(h.emitted.map((event) => event.type)).toEqual(['step.completed'])
  })
})
