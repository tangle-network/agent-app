import { describe, expect, it } from 'vitest'

import {
  applyMissionEvent,
  asMissionStreamEvent,
  mergeMissionState,
  parseSessionStreamEnvelope,
  reduceMissionEvents,
  type MissionState,
  type MissionStreamEvent,
} from '../src/missions/index'

// The PURE mission-event reducer. No socket, no DOM — just data folding. These
// prove idempotency (duplicates), order-tolerance (out-of-order never regresses
// a step), and that non-mission events sharing a channel are ignored.

const PLAN: MissionStreamEvent = {
  type: 'mission.created',
  missionId: 'm1',
  at: 100,
  title: 'Render the previz',
  budgetUsd: 5,
  steps: [
    { id: 's1', intent: 'gather refs', kind: 'research', status: 'pending' },
    { id: 's2', intent: 'storyboard', kind: 'generate', status: 'pending' },
    { id: 's3', intent: 'assemble', kind: 'write', status: 'pending' },
  ],
}

function get(map: Map<string, MissionState>, id: string): MissionState {
  const state = map.get(id)
  if (!state) throw new Error(`mission ${id} missing from reduced state`)
  return state
}

describe('mission-events reducer', () => {
  it('folds a realistic happy-path sequence into the converged state', () => {
    const events: MissionStreamEvent[] = [
      PLAN,
      { type: 'mission.started', missionId: 'm1', at: 110 },
      { type: 'step.started', missionId: 'm1', at: 120, stepId: 's1' },
      { type: 'step.updated', missionId: 'm1', at: 130, stepId: 's1', sublabel: '3/8 refs' },
      { type: 'step.completed', missionId: 'm1', at: 140, stepId: 's1', ok: true, durationMs: 20 },
      { type: 'cost.updated', missionId: 'm1', at: 145, spentUsd: 0.42, capUsd: 5 },
      { type: 'step.started', missionId: 'm1', at: 150, stepId: 's2' },
      { type: 'step.completed', missionId: 'm1', at: 160, stepId: 's2', ok: true },
      { type: 'step.started', missionId: 'm1', at: 170, stepId: 's3' },
      { type: 'step.completed', missionId: 'm1', at: 180, stepId: 's3', ok: true },
      { type: 'mission.completed', missionId: 'm1', at: 190, ok: true, summary: 'Completed 3 steps' },
    ]

    const state = get(reduceMissionEvents(events), 'm1')
    expect(state.title).toBe('Render the previz')
    expect(state.status).toBe('succeeded')
    expect(state.capUsd).toBe(5)
    expect(state.spentUsd).toBeCloseTo(0.42)
    expect(state.summary).toBe('Completed 3 steps')
    expect(state.steps.map((s) => s.status)).toEqual(['done', 'done', 'done'])
    expect(state.steps[0]?.sublabel).toBe('3/8 refs')
    expect(state.steps[0]?.durationMs).toBe(20)
    expect(state.lastEventAt).toBe(190)
  })

  it('is idempotent: feeding every event twice converges to the same state', () => {
    const events: MissionStreamEvent[] = [
      PLAN,
      { type: 'step.started', missionId: 'm1', at: 120, stepId: 's1' },
      { type: 'step.completed', missionId: 'm1', at: 140, stepId: 's1', ok: true },
      { type: 'mission.completed', missionId: 'm1', at: 190, ok: true },
    ]
    const once = get(reduceMissionEvents(events), 'm1')
    const twice = get(reduceMissionEvents([...events, ...events]), 'm1')
    expect(twice).toEqual(once)
  })

  it('never regresses a step: a late step.started after step.completed is a no-op', () => {
    const completed = applyMissionEvent(undefined, {
      type: 'step.completed',
      missionId: 'm1',
      at: 140,
      stepId: 's1',
      ok: true,
    })
    expect(completed.steps[0]?.status).toBe('done')

    // A duplicate/out-of-order started arrives AFTER the completion.
    const after = applyMissionEvent(completed, {
      type: 'step.started',
      missionId: 'm1',
      at: 120,
      stepId: 's1',
    })
    expect(after.steps[0]?.status).toBe('done')
  })

  it('never un-finishes a mission: a stray mission.started after completed keeps succeeded', () => {
    const done = applyMissionEvent(undefined, {
      type: 'mission.completed',
      missionId: 'm1',
      at: 190,
      ok: true,
    })
    expect(done.status).toBe('succeeded')
    const after = applyMissionEvent(done, { type: 'mission.started', missionId: 'm1', at: 110 })
    expect(after.status).toBe('succeeded')
  })

  it('keeps user-stopped missions separate from failed missions', () => {
    const stopped = applyMissionEvent(undefined, {
      type: 'mission.completed',
      missionId: 'm1',
      at: 190,
      ok: false,
      status: 'aborted',
      summary: 'Mission stopped',
    })
    expect(stopped.status).toBe('aborted')

    const lateFailure = applyMissionEvent(stopped, {
      type: 'mission.completed',
      missionId: 'm1',
      at: 200,
      ok: false,
      summary: 'Step failed',
    })
    expect(lateFailure.status).toBe('aborted')
  })

  it('converges regardless of arrival order (out-of-order delivery)', () => {
    const inOrder: MissionStreamEvent[] = [
      PLAN,
      { type: 'step.started', missionId: 'm1', at: 120, stepId: 's1' },
      { type: 'step.updated', missionId: 'm1', at: 130, stepId: 's1', sublabel: 'final' },
      { type: 'step.completed', missionId: 'm1', at: 140, stepId: 's1', ok: true },
      { type: 'step.started', missionId: 'm1', at: 150, stepId: 's2' },
      { type: 'step.completed', missionId: 'm1', at: 160, stepId: 's2', ok: false, reason: 'bad output' },
      { type: 'mission.completed', missionId: 'm1', at: 190, ok: false, summary: 's2 failed' },
    ]
    // Reverse delivery — every event arrives backwards.
    const reversed = [...inOrder].reverse()

    const a = get(reduceMissionEvents(inOrder), 'm1')
    const b = get(reduceMissionEvents(reversed), 'm1')

    // Status converges to terminal failed; the failed step keeps its reason.
    expect(b.status).toBe('failed')
    expect(b.steps.find((s) => s.id === 's2')?.status).toBe('failed')
    expect(b.steps.find((s) => s.id === 's2')?.reason).toBe('bad output')
    expect(b.steps.find((s) => s.id === 's1')?.status).toBe('done')
    expect(b.steps.find((s) => s.id === 's1')?.sublabel).toBe('final')
    // Status, steps, spend agree regardless of order.
    expect(b.status).toBe(a.status)
    expect(b.steps.map((s) => `${s.id}:${s.status}`).sort()).toEqual(
      a.steps.map((s) => `${s.id}:${s.status}`).sort(),
    )
  })

  it('cost.updated never lowers the displayed spend on an out-of-order older value', () => {
    let state = applyMissionEvent(undefined, { type: 'cost.updated', missionId: 'm1', at: 200, spentUsd: 1.5 })
    expect(state.spentUsd).toBeCloseTo(1.5)
    // An older, smaller cumulative value arrives late — must NOT lower the spend.
    state = applyMissionEvent(state, { type: 'cost.updated', missionId: 'm1', at: 150, spentUsd: 0.9 })
    expect(state.spentUsd).toBeCloseTo(1.5)
  })

  it('mission.paused stores the pause reason for the live card', () => {
    const state = applyMissionEvent(undefined, {
      type: 'mission.paused',
      missionId: 'm1',
      at: 200,
      reason: 'Budget review required',
    })
    expect(state.status).toBe('paused')
    expect(state.pauseReason).toBe('Budget review required')
  })

  it('mission.created can seed a scheduled mission without marking it running', () => {
    const state = applyMissionEvent(undefined, {
      type: 'mission.created',
      missionId: 'm1',
      at: 1,
      title: 'Scheduled',
      status: 'scheduled',
      steps: [{ id: 's1', intent: 'wait', kind: 'schedule', status: 'pending' }],
    })
    expect(state.status).toBe('scheduled')
  })

  it('mission.resumed clears pause state without reviving terminal missions', () => {
    const paused = applyMissionEvent(undefined, {
      type: 'mission.paused',
      missionId: 'm1',
      at: 10,
      reason: 'Paused',
    })
    const resumed = applyMissionEvent(paused, { type: 'mission.resumed', missionId: 'm1', at: 20 })
    expect(resumed.status).toBe('running')
    expect(resumed.pauseReason).toBeUndefined()

    const done = applyMissionEvent(resumed, { type: 'mission.completed', missionId: 'm1', at: 30, ok: true })
    const lateResume = applyMissionEvent(done, { type: 'mission.resumed', missionId: 'm1', at: 40 })
    expect(lateResume.status).toBe('succeeded')
  })

  it('ignores an older pause event that arrives after a newer resume event', () => {
    const paused = applyMissionEvent(undefined, {
      type: 'mission.paused',
      missionId: 'm1',
      at: 100,
      reason: 'Paused',
    })
    const resumed = applyMissionEvent(paused, { type: 'mission.resumed', missionId: 'm1', at: 200 })
    const latePause = applyMissionEvent(resumed, {
      type: 'mission.paused',
      missionId: 'm1',
      at: 150,
      reason: 'Stale pause',
    })

    expect(latePause.status).toBe('running')
    expect(latePause.pauseReason).toBeUndefined()
  })

  it('ignores a same-timestamp pause event after a folded resume control event', () => {
    const paused = applyMissionEvent(undefined, {
      type: 'mission.paused',
      missionId: 'm1',
      at: 100,
      reason: 'Paused',
    })
    const resumed = applyMissionEvent(paused, { type: 'mission.resumed', missionId: 'm1', at: 200 })
    const sameTimePause = applyMissionEvent(resumed, {
      type: 'mission.paused',
      missionId: 'm1',
      at: 200,
      reason: 'Same tick pause',
    })

    expect(sameTimePause.status).toBe('running')
    expect(sameTimePause.pauseReason).toBeUndefined()
  })

  it('mission.plan.updated replaces the visible plan snapshot', () => {
    const seeded = applyMissionEvent(undefined, {
      type: 'mission.created',
      missionId: 'm1',
      at: 1,
      title: 'Original',
      budgetUsd: 10,
      steps: [
        { id: 's1', intent: 'Done step', kind: 'research', status: 'pending' },
        { id: 's2', intent: 'Old pending', kind: 'write', status: 'pending' },
      ],
    })
    const done = applyMissionEvent(seeded, {
      type: 'step.completed',
      missionId: 'm1',
      at: 2,
      stepId: 's1',
      ok: true,
    })
    const updated = applyMissionEvent(done, {
      type: 'mission.plan.updated',
      missionId: 'm1',
      at: 3,
      title: 'Original',
      budgetUsd: 10,
      steps: [
        { id: 's1', intent: 'Done step', kind: 'research', status: 'done' },
        { id: 's2', intent: 'Waiting for approval', kind: 'write', status: 'waiting_approval' },
      ],
    })

    expect(updated.steps.map((step) => step.id)).toEqual(['s1', 's2'])
    expect(updated.steps[0]?.status).toBe('done')
    expect(updated.steps[1]).toMatchObject({ intent: 'Waiting for approval', status: 'waiting_approval' })
  })

  it('creates a placeholder step when step.started precedes the create snapshot', () => {
    // Reconnect race: a step.started for s2 lands before mission.created.
    let state = applyMissionEvent(undefined, { type: 'step.started', missionId: 'm1', at: 150, stepId: 's2' })
    expect(state.steps).toHaveLength(1)
    expect(state.steps[0]).toMatchObject({ id: 's2', status: 'running' })

    // The create snapshot then fills in intent/kind WITHOUT regressing status.
    state = applyMissionEvent(state, PLAN)
    const s2 = state.steps.find((s) => s.id === 's2')
    expect(s2).toMatchObject({ id: 's2', intent: 'storyboard', kind: 'generate', status: 'running' })
    // The other plan steps are present too.
    expect(state.steps.map((s) => s.id).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('ignores non-mission events sharing the channel (asMissionStreamEvent returns null)', () => {
    expect(asMissionStreamEvent({ type: 'message.part.updated', data: { delta: 'hi' } })).toBeNull()
    expect(asMissionStreamEvent({ type: 'result', data: { finalText: 'done' } })).toBeNull()
    expect(asMissionStreamEvent({ type: 'session.mode', data: { mode: 'sandbox' } })).toBeNull()
    // Mission events with no missionId are also rejected (malformed).
    expect(asMissionStreamEvent({ type: 'step.started', stepId: 's1' })).toBeNull()
    // A well-formed mission event passes.
    expect(asMissionStreamEvent({ type: 'mission.started', missionId: 'm1', at: 1 })).toMatchObject({
      type: 'mission.started',
      missionId: 'm1',
    })
  })

  it('keeps missions on the same channel independent (keyed by missionId)', () => {
    const events: MissionStreamEvent[] = [
      { type: 'mission.started', missionId: 'm1', at: 1 },
      { type: 'mission.started', missionId: 'm2', at: 2 },
      { type: 'step.started', missionId: 'm2', at: 3, stepId: 's1' },
      { type: 'mission.completed', missionId: 'm1', at: 4, ok: true },
    ]
    const map = reduceMissionEvents(events)
    expect(map.size).toBe(2)
    expect(get(map, 'm1').status).toBe('succeeded')
    expect(get(map, 'm2').status).toBe('running')
    expect(get(map, 'm2').steps[0]?.status).toBe('running')
  })

  it('seeds from a prior state map without losing more-advanced live state', () => {
    // Loader seed: s1 already done on the row.
    const seed = new Map<string, MissionState>([
      [
        'm1',
        {
          missionId: 'm1',
          title: 'Seeded',
          status: 'running',
          steps: [{ id: 's1', intent: 'a', kind: 'research', status: 'done' }],
          spentUsd: 0.1,
          lastEventAt: 100,
        },
      ],
    ])
    // A stale started for s1 must not regress it below done.
    const map = reduceMissionEvents(
      [{ type: 'step.started', missionId: 'm1', at: 90, stepId: 's1' }],
      seed,
    )
    expect(get(map, 'm1').steps[0]?.status).toBe('done')
  })
})

describe('mergeMissionState (reconnect seed-merge)', () => {
  function runningLive(): MissionState {
    return {
      missionId: 'm1',
      title: 'Render',
      status: 'running',
      steps: [
        { id: 's1', intent: 'gather', kind: 'research', status: 'done' },
        { id: 's2', intent: 'storyboard', kind: 'generate', status: 'running' },
        { id: 's3', intent: 'assemble', kind: 'write', status: 'pending' },
      ],
      spentUsd: 0.4,
      capUsd: 5,
      lastEventAt: 150,
    }
  }

  it('adopts the seed when the mission is unknown to the client (live undefined)', () => {
    const seed = runningLive()
    expect(mergeMissionState(undefined, seed)).toBe(seed)
  })

  it('advances an already-known running mission to succeeded after an outage', () => {
    // The channel was down: the row finished (all steps done, mission
    // succeeded, spend rose) while the client live-state stayed frozen at
    // `running`. The reconnect seed must FILL that gap, not be dropped.
    const live = runningLive()
    const seed: MissionState = {
      missionId: 'm1',
      title: 'Render',
      status: 'succeeded',
      steps: [
        { id: 's1', intent: 'gather', kind: 'research', status: 'done' },
        { id: 's2', intent: 'storyboard', kind: 'generate', status: 'done' },
        { id: 's3', intent: 'assemble', kind: 'write', status: 'done' },
      ],
      spentUsd: 1.2,
      capUsd: 5,
      summary: 'Completed 3 steps',
      lastEventAt: 300,
    }

    const merged = mergeMissionState(live, seed)
    expect(merged.status).toBe('succeeded')
    expect(merged.steps.map((s) => s.status)).toEqual(['done', 'done', 'done'])
    expect(merged.spentUsd).toBeCloseTo(1.2)
    expect(merged.summary).toBe('Completed 3 steps')
    expect(merged.lastEventAt).toBe(300)
  })

  it('is a no-op when the live state is already more advanced than the seed', () => {
    // The client already folded the terminal events; a late/stale loader seed
    // (an earlier snapshot) must not regress anything.
    const live: MissionState = {
      missionId: 'm1',
      title: 'Render',
      status: 'succeeded',
      steps: [{ id: 's1', intent: 'gather', kind: 'research', status: 'done' }],
      spentUsd: 1.2,
      capUsd: 5,
      summary: 'Completed 1 step',
      lastEventAt: 300,
    }
    const staleSeed: MissionState = {
      missionId: 'm1',
      title: 'Render',
      status: 'running',
      steps: [{ id: 's1', intent: 'gather', kind: 'research', status: 'running' }],
      spentUsd: 0.1,
      capUsd: 5,
      lastEventAt: 120,
    }
    const merged = mergeMissionState(live, staleSeed)
    expect(merged.status).toBe('succeeded')
    expect(merged.steps[0]?.status).toBe('done')
    expect(merged.spentUsd).toBeCloseTo(1.2)
    expect(merged.summary).toBe('Completed 1 step')
    expect(merged.lastEventAt).toBe(300)
  })

  it('fills a placeholder step intent/kind and adds steps the live side never saw', () => {
    // A pre-create step.started left a bare placeholder; a step that never
    // arrived live is absent entirely. The seed (full plan) backfills both.
    const live: MissionState = {
      missionId: 'm1',
      status: 'running',
      steps: [{ id: 's2', intent: '', kind: '', status: 'running' }],
      spentUsd: 0,
      lastEventAt: 50,
    }
    const seed: MissionState = {
      missionId: 'm1',
      title: 'Render',
      status: 'running',
      steps: [
        { id: 's1', intent: 'gather', kind: 'research', status: 'pending' },
        { id: 's2', intent: 'storyboard', kind: 'generate', status: 'pending' },
      ],
      spentUsd: 0,
      lastEventAt: 100,
    }
    const merged = mergeMissionState(live, seed)
    const s2 = merged.steps.find((s) => s.id === 's2')
    // intent/kind filled from the seed; status kept at the more-advanced running.
    expect(s2).toMatchObject({ intent: 'storyboard', kind: 'generate', status: 'running' })
    // s1 (never seen live) added from the seed.
    expect(merged.steps.map((s) => s.id).sort()).toEqual(['s1', 's2'])
    expect(merged.title).toBe('Render')
  })

  it('does not let an older paused seed override a newer resume event', () => {
    const live: MissionState = {
      missionId: 'm1',
      title: 'Resume won',
      status: 'running',
      steps: [{ id: 's1', intent: 'draft', kind: 'write', status: 'running' }],
      spentUsd: 0,
      pauseReason: undefined,
      lastEventAt: 200,
      lastControlAt: 200,
    }
    const pausedSeed: MissionState = {
      missionId: 'm1',
      title: 'Resume won',
      status: 'paused',
      steps: [{ id: 's1', intent: 'draft', kind: 'write', status: 'running' }],
      spentUsd: 0,
      pauseReason: 'Older pause',
      lastEventAt: 150,
      lastControlAt: 0,
    }

    const merged = mergeMissionState(live, pausedSeed)
    expect(merged.status).toBe('running')
    expect(merged.pauseReason).toBeUndefined()
  })

  it('does not let an older waiting-approval seed override a newer resume event', () => {
    const live: MissionState = {
      missionId: 'm1',
      title: 'Resume won',
      status: 'running',
      steps: [{ id: 's1', intent: 'publish', kind: 'approval', status: 'waiting_approval' }],
      spentUsd: 0,
      lastEventAt: 200,
      lastControlAt: 200,
    }
    const waitingSeed: MissionState = {
      missionId: 'm1',
      title: 'Resume won',
      status: 'waiting_approval',
      steps: [{ id: 's1', intent: 'publish', kind: 'approval', status: 'waiting_approval' }],
      spentUsd: 0,
      pauseReason: 'Needs approval',
      lastEventAt: 150,
      lastControlAt: 0,
    }

    const merged = mergeMissionState(live, waitingSeed)
    expect(merged.status).toBe('running')
    expect(merged.pauseReason).toBeUndefined()
  })

  it('reconnect seed can resume a paused mission and clear the old reason', () => {
    const live: MissionState = {
      missionId: 'm1',
      title: 'Paused live',
      status: 'paused',
      steps: [{ id: 's1', intent: 'wait', kind: 'research', status: 'done' }],
      spentUsd: 0.2,
      capUsd: 5,
      pauseReason: 'Waiting on approval',
      lastEventAt: 200,
    }
    const seed: MissionState = {
      ...live,
      status: 'running',
      pauseReason: undefined,
      lastEventAt: 250,
    }

    const merged = mergeMissionState(live, seed)
    expect(merged.status).toBe('running')
    expect(merged.pauseReason).toBeUndefined()
  })

  it('uses the loader seed as the authoritative current plan', () => {
    const live: MissionState = {
      missionId: 'm1',
      title: 'Current plan',
      status: 'running',
      steps: [
        { id: 's1', intent: 'done', kind: 'research', status: 'done' },
        { id: 'old-tail', intent: 'old', kind: 'write', status: 'pending' },
      ],
      spentUsd: 0,
      lastEventAt: 100,
    }
    const seed: MissionState = {
      missionId: 'm1',
      title: 'Current plan',
      status: 'running',
      steps: [
        { id: 's1', intent: 'done', kind: 'research', status: 'done' },
        { id: 'new-tail', intent: 'new', kind: 'write', status: 'pending' },
      ],
      spentUsd: 0,
      lastEventAt: 120,
    }

    const merged = mergeMissionState(live, seed)
    expect(merged.steps.map((step) => step.id)).toEqual(['s1', 'new-tail'])
  })
})

describe('parseSessionStreamEnvelope (wire reconstruction)', () => {
  it('reconstructs the flat mission event from the broadcast envelope', () => {
    const envelope = {
      type: 'step.completed',
      data: { missionId: 'm1', at: 5, stepId: 'recon', ok: true, durationMs: 12 },
    }
    expect(parseSessionStreamEnvelope(envelope)).toMatchObject({
      type: 'step.completed',
      missionId: 'm1',
      stepId: 'recon',
      ok: true,
      durationMs: 12,
    })
  })

  it('keeps the envelope type authoritative — a data.type cannot shadow it', () => {
    // A payload riding the same channel carries its own nested `type` inside
    // data. The envelope discriminant (set by the server) must win; a
    // 'message.part.updated' envelope must NOT reconstruct as a mission event.
    expect(
      parseSessionStreamEnvelope({
        type: 'message.part.updated',
        data: { type: 'step.completed', missionId: 'm1', ok: true },
      }),
    ).toBeNull()
  })

  it('rejects non-mission envelopes and malformed payloads', () => {
    expect(parseSessionStreamEnvelope({ type: 'result', data: { finalText: 'x' } })).toBeNull()
    expect(parseSessionStreamEnvelope({ type: 'step.started', data: {} })).toBeNull() // no missionId
    expect(parseSessionStreamEnvelope({ data: { missionId: 'm1' } })).toBeNull() // no type
    expect(parseSessionStreamEnvelope(null)).toBeNull()
    expect(parseSessionStreamEnvelope('nope')).toBeNull()
  })

  it('tolerates an envelope whose data stamps routing fields (broadcaster shape)', () => {
    // Transports stamp workspaceId/threadId/sessionId into data; they must not
    // collide with any mission field and the event must still reconstruct.
    const event = parseSessionStreamEnvelope({
      type: 'mission.started',
      data: { missionId: 'm1', at: 1, workspaceId: 'ws1', threadId: 't1', sessionId: 't1' },
    })
    expect(event).toMatchObject({ type: 'mission.started', missionId: 'm1' })
  })
})
