import { beforeEach, describe, expect, it } from 'vitest'

import {
  createInMemoryMissionStore,
  createMissionService,
  type InMemoryMissionStore,
  type MissionService,
  type MissionStep,
  type MissionStorePort,
} from '../src/missions/index'

// The guarded mission state machine over the storage port. The in-memory store
// is the port fake; `raceOnce` injects a concurrent writer between a mutator's
// read and its guarded write, which is exactly the window the CAS guards close.

const WORKSPACE_ID = 'ws-test'

function samplePlan(): MissionStep[] {
  return [
    { id: 'step-1', intent: 'research trend', kind: 'research', status: 'pending', attempts: 0 },
    { id: 'step-2', intent: 'draft storyboard', kind: 'generate', status: 'pending', attempts: 0 },
  ]
}

interface Harness {
  store: InMemoryMissionStore
  service: MissionService
  /** Run `fn` once, immediately before the NEXT guarded write commits — a
   *  stand-in for a concurrent owner racing the read-modify-write window. */
  raceOnce(fn: () => void | Promise<void>): void
  eventSteps(missionId: string): string[]
}

function harness(): Harness {
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
  return {
    store,
    service,
    raceOnce(fn) {
      hook = fn
    },
    eventSteps(missionId) {
      return store.events().filter((event) => event.missionId === missionId).map((event) => event.step)
    },
  }
}

describe('mission service', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  it('createMission inserts a running run with plan, zeroed cost, and a created event', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Launch teaser',
      plan: samplePlan(),
      budgetUsd: 5,
      trigger: 'chat',
      metadata: { threadId: 'thread-1' },
    })

    expect(mission.status).toBe('running')
    expect(mission.cursor).toBe(0)
    expect(mission.budgetUsd).toBe(5)
    expect(mission.spentUsd).toBe(0)
    expect(mission.plan).toHaveLength(2)
    expect(mission.cost).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, wallMs: 0, llmCalls: 0 })
    expect(mission.metadata).toEqual({ threadId: 'thread-1' })
    expect(h.eventSteps(mission.id)).toEqual(['mission.created'])
  })

  it('createMission with scheduledAt starts in the scheduled state', async () => {
    const when = Date.UTC(2026, 6, 1, 12)
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Scheduled drop',
      plan: samplePlan(),
      scheduledAt: when,
      trigger: 'cron',
    })

    expect(mission.status).toBe('scheduled')
    expect(mission.scheduledAt).toBe(when)
  })

  it('rejects a plan with duplicate step ids at creation (unique durable-step names)', async () => {
    await expect(
      h.service.createMission({
        workspaceId: WORKSPACE_ID,
        title: 'Dup ids',
        plan: [
          { id: 'dup', intent: 'first', kind: 'research', status: 'pending', attempts: 0 },
          { id: 'dup', intent: 'second', kind: 'analyze', status: 'pending', attempts: 0 },
        ],
        trigger: 'manual',
      }),
    ).rejects.toThrow('Duplicate plan step id "dup"')
  })

  it('getMission returns the persisted row and null for a missing id', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'A',
      plan: samplePlan(),
      trigger: 'manual',
    })
    expect((await h.service.getMission(mission.id))?.id).toBe(mission.id)
    expect(await h.service.getMission('missing')).toBeNull()
  })

  it('setStepStatus mutates the targeted plan step and counts an attempt on running', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Step machine',
      plan: samplePlan(),
      trigger: 'chat',
    })

    const running = await h.service.setStepStatus(mission.id, 'step-1', 'running', { sublabel: 'searching' })
    expect(running.succeeded).toBe(true)
    if (!running.succeeded) throw new Error(running.error)
    expect(running.value.plan[0]).toMatchObject({ status: 'running', attempts: 1, sublabel: 'searching' })
    expect(running.value.plan[1]?.status).toBe('pending')

    const done = await h.service.setStepStatus(mission.id, 'step-1', 'done', { resultRef: 'asset:42' })
    expect(done.succeeded).toBe(true)
    if (!done.succeeded) throw new Error(done.error)
    expect(done.value.plan[0]).toMatchObject({ status: 'done', attempts: 1, resultRef: 'asset:42' })

    expect(h.eventSteps(mission.id)).toEqual([
      'mission.created',
      'mission.step.running',
      'mission.step.done',
    ])
  })

  it('setStepStatus rejects unknown steps and illegal step transitions', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Step guards',
      plan: samplePlan(),
      trigger: 'chat',
    })

    const unknown = await h.service.setStepStatus(mission.id, 'nope', 'running')
    expect(unknown).toEqual({
      succeeded: false,
      error: expect.stringContaining('Step nope not found'),
      conflict: false,
    })

    // pending -> done is not a legal step edge (must pass through running).
    const illegal = await h.service.setStepStatus(mission.id, 'step-1', 'done')
    expect(illegal).toEqual({
      succeeded: false,
      error: expect.stringContaining('Illegal step transition pending -> done'),
      conflict: false,
    })

    // No event rows beyond creation were written for the rejected calls.
    expect(h.eventSteps(mission.id)).toEqual(['mission.created'])
  })

  it('advanceCursor moves the cursor and rejects advancing past the plan end', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Cursor walk',
      plan: samplePlan(),
      trigger: 'chat',
    })

    const a = await h.service.advanceCursor(mission.id)
    expect(a.succeeded && a.value.cursor).toBe(1)
    const b = await h.service.advanceCursor(mission.id)
    expect(b.succeeded && b.value.cursor).toBe(2)
    // cursor == plan.length is allowed; one past that is rejected.
    const c = await h.service.advanceCursor(mission.id)
    expect(c).toEqual({
      succeeded: false,
      error: expect.stringContaining('already at the end'),
      conflict: false,
    })

    expect(h.eventSteps(mission.id)).toEqual(['mission.created', 'mission.cursor', 'mission.cursor'])
  })

  it('addCost accumulates spend and merges the cost ledger', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Spend',
      plan: samplePlan(),
      budgetUsd: 10,
      trigger: 'chat',
    })

    const first = await h.service.addCost(mission.id, 0.5, {
      tokensIn: 100,
      tokensOut: 40,
      costUsd: 0.5,
      wallMs: 1200,
      llmCalls: 1,
    })
    expect(first.succeeded).toBe(true)
    if (!first.succeeded) throw new Error(first.error)
    expect(first.value.spentUsd).toBeCloseTo(0.5)
    expect(first.value.cost).toEqual({ tokensIn: 100, tokensOut: 40, costUsd: 0.5, wallMs: 1200, llmCalls: 1 })

    const second = await h.service.addCost(mission.id, 0.25, {
      tokensIn: 50,
      tokensOut: 10,
      costUsd: 0.25,
      wallMs: 300,
      llmCalls: 1,
    })
    expect(second.succeeded).toBe(true)
    if (!second.succeeded) throw new Error(second.error)
    expect(second.value.spentUsd).toBeCloseTo(0.75)
    expect(second.value.cost).toEqual({ tokensIn: 150, tokensOut: 50, costUsd: 0.75, wallMs: 1500, llmCalls: 2 })

    // Bare-USD delta with no ledger breakdown still moves spend + costUsd.
    const third = await h.service.addCost(mission.id, 0.25)
    expect(third.succeeded && third.value.spentUsd).toBeCloseTo(1)
    expect(third.succeeded && third.value.cost?.costUsd).toBeCloseTo(1)

    expect(h.eventSteps(mission.id)).toEqual([
      'mission.created',
      'mission.cost',
      'mission.cost',
      'mission.cost',
    ])
  })

  it('runs the legal pause -> resume -> abort lifecycle and writes an event per transition', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Lifecycle',
      plan: samplePlan(),
      trigger: 'chat',
    })

    const paused = await h.service.pause(mission.id, 'waiting on user assets')
    expect(paused.succeeded && paused.value.status).toBe('paused')
    expect(paused.succeeded && paused.value.pauseReason).toBe('waiting on user assets')

    const resumed = await h.service.resume(mission.id)
    expect(resumed.succeeded && resumed.value.status).toBe('running')
    expect(resumed.succeeded && resumed.value.pauseReason).toBeNull()

    const aborted = await h.service.abort(mission.id)
    expect(aborted.succeeded && aborted.value.status).toBe('aborted')
    expect(aborted.succeeded && typeof aborted.value.completedAt).toBe('number')

    expect(h.eventSteps(mission.id)).toEqual([
      'mission.created',
      'mission.paused',
      'mission.running',
      'mission.aborted',
    ])
  })

  it('markWaitingApproval flips the step and the mission together', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Approval gate',
      plan: samplePlan(),
      trigger: 'chat',
    })

    const waiting = await h.service.markWaitingApproval(mission.id, 'step-1')
    expect(waiting.succeeded && waiting.value.status).toBe('waiting_approval')
    if (!waiting.succeeded) throw new Error(waiting.error)
    expect(waiting.value.plan[0]?.status).toBe('waiting_approval')

    expect(h.eventSteps(mission.id)).toEqual([
      'mission.created',
      'mission.step.waiting_approval',
      'mission.waiting_approval',
    ])
  })

  it('complete drives the terminal status from the ok flag', async () => {
    const ok = await h.service.createMission({ workspaceId: WORKSPACE_ID, title: 'ok', plan: samplePlan(), trigger: 'chat' })
    const okDone = await h.service.complete(ok.id, { ok: true, summary: 'shipped' })
    expect(okDone.succeeded && okDone.value.status).toBe('succeeded')
    expect(okDone.succeeded && okDone.value.summary).toBe('shipped')
    expect(okDone.succeeded && typeof okDone.value.completedAt).toBe('number')

    const bad = await h.service.createMission({ workspaceId: WORKSPACE_ID, title: 'bad', plan: samplePlan(), trigger: 'chat' })
    const badDone = await h.service.complete(bad.id, { ok: false })
    expect(badDone.succeeded && badDone.value.status).toBe('failed')
  })

  it('rejects illegal mission transitions and transitions out of terminal states', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Guards',
      plan: samplePlan(),
      trigger: 'chat',
    })

    // running -> resume(running) is a same-status no-op, not an error.
    const resumeFromRunning = await h.service.resume(mission.id)
    expect(resumeFromRunning.succeeded && resumeFromRunning.value.status).toBe('running')

    await h.service.complete(mission.id, { ok: true })
    // Terminal: every further transition is rejected.
    const afterPause = await h.service.pause(mission.id, 'too late')
    expect(afterPause).toEqual({
      succeeded: false,
      error: expect.stringContaining('is terminal (succeeded)'),
      conflict: false,
    })
    const afterAbort = await h.service.abort(mission.id)
    expect(afterAbort).toEqual({
      succeeded: false,
      error: expect.stringContaining('is terminal (succeeded)'),
      conflict: false,
    })

    // Missing mission also fails loud.
    const missing = await h.service.pause('nope', 'x')
    expect(missing).toEqual({
      succeeded: false,
      error: expect.stringContaining('Mission nope not found'),
      conflict: false,
    })
  })

  it('scheduled -> running is a legal start edge (the scheduler resumes the run)', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Scheduled',
      plan: samplePlan(),
      scheduledAt: Date.UTC(2026, 6, 1),
      trigger: 'cron',
    })
    const started = await h.service.resume(mission.id)
    expect(started.succeeded && started.value.status).toBe('running')
  })

  it('markWaitingApproval on a non-running mission is rejected and leaves no half-applied state', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Gated while paused',
      plan: samplePlan(),
      trigger: 'chat',
    })
    const paused = await h.service.pause(mission.id, 'awaiting assets')
    expect(paused.succeeded).toBe(true)

    const result = await h.service.markWaitingApproval(mission.id, 'step-1')
    expect(result).toEqual({
      succeeded: false,
      error: expect.stringContaining('Illegal mission transition paused -> waiting_approval'),
      conflict: false,
    })

    // The mission transition was validated FIRST, so the step was never
    // flipped and no dangling step/transition event was written.
    const after = await h.service.getMission(mission.id)
    expect(after?.status).toBe('paused')
    expect(after?.plan[0]?.status).toBe('pending')
    expect(h.eventSteps(mission.id)).toEqual(['mission.created', 'mission.paused'])
  })

  it('setStepStatus running->running is an idempotent no-op (no attempt bump, no event)', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Idempotent re-assert',
      plan: samplePlan(),
      trigger: 'chat',
    })

    const first = await h.service.setStepStatus(mission.id, 'step-1', 'running')
    expect(first.succeeded && first.value.plan[0]).toMatchObject({ status: 'running', attempts: 1 })

    // Re-asserting running (retry / at-least-once delivery) must not inflate
    // attempts or write a duplicate event.
    const reassert = await h.service.setStepStatus(mission.id, 'step-1', 'running')
    expect(reassert.succeeded && reassert.value.plan[0]).toMatchObject({ status: 'running', attempts: 1 })

    expect(h.eventSteps(mission.id)).toEqual(['mission.created', 'mission.step.running'])
  })

  it('setStepStatus same-status with a real patch change persists without counting an attempt', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Sublabel update',
      plan: samplePlan(),
      trigger: 'chat',
    })
    await h.service.setStepStatus(mission.id, 'step-1', 'running', { sublabel: 'searching' })

    const relabel = await h.service.setStepStatus(mission.id, 'step-1', 'running', { sublabel: 'still searching' })
    expect(relabel.succeeded && relabel.value.plan[0]).toMatchObject({
      status: 'running',
      attempts: 1,
      sublabel: 'still searching',
    })
    expect(h.eventSteps(mission.id)).toEqual([
      'mission.created',
      'mission.step.running',
      'mission.step.running',
    ])
  })

  it('mergeMetadata shallow-merges keys and preserves untouched ones', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Metadata',
      plan: samplePlan(),
      trigger: 'chat',
      metadata: { threadId: 'thread-1' },
    })

    const merged = await h.service.mergeMetadata(mission.id, { initiatedBy: 'user-1' })
    expect(merged.succeeded && merged.value.metadata).toEqual({ threadId: 'thread-1', initiatedBy: 'user-1' })
  })

  it('setStepStatus loses the race when a stop request lands before the plan write', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Stopped step race',
      plan: samplePlan(),
      trigger: 'chat',
    })

    h.raceOnce(() => {
      h.store.put({
        ...mission,
        metadata: { stopRequested: true },
        pauseReason: 'Stop requested',
      })
    })
    const stale = await h.service.setStepStatus(mission.id, 'step-1', 'running')
    expect(stale).toEqual({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
      conflict: true,
    })

    const after = await h.service.getMission(mission.id)
    expect(after?.metadata?.stopRequested).toBe(true)
    expect(after?.plan[0]?.status).toBe('pending')
  })

  it('a transition loses the race when the status changes between its read and write', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Concurrent status',
      plan: samplePlan(),
      trigger: 'chat',
    })

    // pause() reads `running`, validates running->paused, then the guarded
    // write fires. A concurrent owner flips the row to `aborted` first, so the
    // status guard misses and the loser reports the race instead of clobbering
    // the concurrent terminal state.
    h.raceOnce(() => {
      h.store.put({ ...mission, status: 'aborted' })
    })
    const stale = await h.service.pause(mission.id, 'too late')
    expect(stale).toEqual({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
      conflict: true,
    })

    const after = await h.service.getMission(mission.id)
    expect(after?.status).toBe('aborted')
  })

  it('advanceCursor loses the race when the cursor moves between its read and write', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Cursor race',
      plan: samplePlan(),
      trigger: 'chat',
    })

    // Caller reads cursor=0; a concurrent advance moves it to 1 before the
    // guarded write. The guard on cursor=0 misses, so the stale write is
    // rejected and the concurrent increment is preserved.
    h.raceOnce(() => {
      h.store.put({ ...mission, cursor: 1 })
    })
    const stale = await h.service.advanceCursor(mission.id)
    expect(stale).toEqual({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
      conflict: true,
    })

    const after = await h.service.getMission(mission.id)
    expect(after?.cursor).toBe(1)
  })

  it('addCost loses the race when the cost ledger changes between its read and write', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Spend race',
      plan: samplePlan(),
      budgetUsd: 10,
      trigger: 'chat',
    })

    // Caller read the zeroed ledger; a concurrent spend merges a ledger before
    // the guarded write. The cost guard misses, so the stale merge is rejected
    // rather than clobbering the concurrent spend (an undercount here would be
    // an over-spend against the budget gate).
    h.raceOnce(() => {
      h.store.put({
        ...mission,
        cost: { tokensIn: 5, tokensOut: 0, costUsd: 0.2, wallMs: 0, llmCalls: 1 },
        spentUsd: 0.2,
      })
    })
    const stale = await h.service.addCost(mission.id, 0.5)
    expect(stale).toEqual({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
      conflict: true,
    })

    const after = await h.service.getMission(mission.id)
    expect(after?.spentUsd).toBeCloseTo(0.2)
  })

  it('mergeMetadata loses the race when metadata changes between its read and write', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Metadata race',
      plan: samplePlan(),
      trigger: 'chat',
      metadata: { threadId: 'thread-1' },
    })

    h.raceOnce(() => {
      h.store.put({ ...mission, metadata: { threadId: 'thread-1', concurrent: true } })
    })
    const stale = await h.service.mergeMetadata(mission.id, { initiatedBy: 'user-1' })
    expect(stale).toEqual({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
      conflict: true,
    })

    const after = await h.service.getMission(mission.id)
    expect(after?.metadata).toEqual({ threadId: 'thread-1', concurrent: true })
  })
})

// The single-owner binding contract the owning workflow's guard depends on.
// The owner proceeds ONLY on succeeded:true; it refuses a different owner and
// retries a lost race. These prove the three distinct outcomes that guard
// branches on, so the guard can never silently invert.
describe('mission engine binding (setEngineRef)', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  it('binds a null engineRef and re-asserting the SAME id is a no-op success (replay)', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Bind',
      plan: samplePlan(),
      trigger: 'manual',
    })

    const first = await h.service.setEngineRef(mission.id, 'owner-A')
    expect(first.succeeded).toBe(true)
    expect(first.succeeded && first.value.engineRef).toBe('owner-A')

    // A replay re-feeds the same instance id; this must succeed without
    // writing a second engine-bound event.
    const replay = await h.service.setEngineRef(mission.id, 'owner-A')
    expect(replay.succeeded).toBe(true)
    expect(h.eventSteps(mission.id)).toEqual(['mission.created', 'mission.engine'])
  })

  it('refuses a DIFFERENT owner once bound (never double-drive)', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Foreign owner',
      plan: samplePlan(),
      trigger: 'manual',
    })
    await h.service.setEngineRef(mission.id, 'owner-A')

    const foreign = await h.service.setEngineRef(mission.id, 'owner-B')
    expect(foreign).toEqual({
      succeeded: false,
      error: expect.stringContaining('already bound to engine owner-A'),
      conflict: false,
    })
    // The bound ref is untouched — owner-B cannot steal the run.
    const after = await h.service.getMission(mission.id)
    expect(after?.engineRef).toBe('owner-A')
  })

  it('reports a lost null-guard race distinctly (retryable, not different-owner)', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Bind race',
      plan: samplePlan(),
      trigger: 'manual',
    })

    // A second owner binds engineRef between this caller's read (null) and its
    // guarded write, so the null guard misses. The failure is the conflict
    // race — distinct from 'already bound' — which the owner treats as
    // retryable rather than a fatal different-owner refusal.
    h.raceOnce(() => {
      h.store.put({ ...mission, engineRef: 'owner-A' })
    })
    const raced = await h.service.setEngineRef(mission.id, 'owner-B')
    expect(raced).toEqual({
      succeeded: false,
      error: expect.stringContaining('changed concurrently'),
      conflict: true,
    })
    expect(raced.succeeded === false && raced.error.includes('already bound')).toBe(false)
  })

  it('refuses to bind a terminal or stop-requested mission', async () => {
    const mission = await h.service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'Unbindable',
      plan: samplePlan(),
      trigger: 'manual',
    })
    await h.service.mergeMetadata(mission.id, { stopRequested: true })
    const stopped = await h.service.setEngineRef(mission.id, 'owner-A')
    expect(stopped).toEqual({
      succeeded: false,
      error: expect.stringContaining('not writable'),
      conflict: false,
    })
  })
})

describe('createMission extras passthrough (opaque product columns)', () => {
  it('hands extras VERBATIM to MissionStorePort.insert alongside the record', async () => {
    const store = createInMemoryMissionStore()
    const seen: Array<Record<string, unknown> | undefined> = []
    const capturing: MissionStorePort = {
      load: (id) => store.load(id),
      appendEvent: (event) => store.appendEvent(event),
      update: (id, guard, patch) => store.update(id, guard, patch),
      insert: (record, extras) => {
        seen.push(extras)
        return store.insert(record, extras)
      },
    }
    const service = createMissionService({ store: capturing })

    const extras = { workflowId: 'wf-9', sourceTurnId: 'turn-3' }
    const record = await service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'single-write create',
      plan: samplePlan(),
      trigger: 'manual',
      extras,
    })

    expect(seen).toEqual([extras])
    // extras never leak onto the record itself — they are insert-call-only.
    expect(record.metadata).toBeNull()
    expect('workflowId' in record).toBe(false)
  })

  it('omitting extras passes undefined (stores without product columns ignore it)', async () => {
    const store = createInMemoryMissionStore()
    const seen: Array<Record<string, unknown> | undefined> = []
    const capturing: MissionStorePort = {
      ...store,
      insert: (record, extras) => {
        seen.push(extras)
        return store.insert(record)
      },
    }
    const service = createMissionService({ store: capturing })
    await service.createMission({
      workspaceId: WORKSPACE_ID,
      title: 'no extras',
      plan: samplePlan(),
      trigger: 'manual',
    })
    expect(seen).toEqual([undefined])
  })
})
