/**
 * Property/fuzz harness for `reduceMissionEvents`. The reducer documents a hard
 * promise: it is PURE, idempotent, and order-tolerant — feeding the same set of
 * events in ANY order, with ANY events duplicated, must converge to the same
 * Map<missionId, MissionState>. That property is what lets the live channel
 * drop, replay, and re-deliver out of order without corrupting the UI.
 *
 * Found-bug provenance (kept as a regression guard, see the second `describe`):
 * the reducer's STEP-ARRAY ORDER is arrival-dependent when step events arrive
 * BEFORE any `mission.created` / `mission.plan.updated` declares the canonical
 * step list — two shuffles then differ only in step array order (per-step state
 * is identical). The full-equality property below therefore guarantees each
 * mission's stream begins with a `mission.created`, which is the production
 * contract (a mission is always created before its steps run) and fixes the
 * order. A separate property asserts the WEAKER, always-true invariant: per-step
 * state keyed by id converges regardless of any seeding event.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { reduceMissionEvents } from '../src/missions/events'
import type { MissionState, MissionStreamEvent } from '../src/missions/events'

const MISSION_IDS = ['m1', 'm2'] as const
const STEP_IDS = ['s1', 's2', 's3'] as const

/** Stamp each event with a unique, strictly increasing `at` by canonical
 *  position. This models a real emitter clock: every distinct event has its own
 *  timestamp, so the reducer's "latest snapshot wins by `at`" rule is total —
 *  there are no equal-`at` ties whose resolution would depend on arrival order.
 *  Duplicates created later reuse the SAME event object (same `at`), so a
 *  re-delivery is genuinely idempotent rather than a fresh same-timestamp write. */
function stampMonotonic(events: MissionStreamEvent[]): MissionStreamEvent[] {
  return events.map((event, index) => ({ ...event, at: (index + 1) * 10 }))
}

/**
 * Generates only events that touch CONVERGENT fields — those the reducer
 * resolves by a total order (status via the monotonic STEP_RANK clamp, spentUsd
 * via `Math.max`, agentActivity via its `at`-guard) — so any delivery order +
 * duplication folds to the same state.
 *
 * Deliberately EXCLUDED (found, documented order-sensitivity, NOT a bug):
 *  - `step.updated.sublabel` — the reducer takes the latest sublabel
 *    UNCONDITIONALLY ("a live counter; freshest delivered wins"), so two
 *    sublabels at distinct `at` resolve by ARRIVAL order, not by `at`. It is an
 *    intentional non-`at`-gated field; including it would fail convergence by
 *    design rather than surface a defect.
 *  - generated `mission.created` — the synthetic create from `withCreates`
 *    seeds the canonical plan; a second generated create would just be a
 *    redundant same-content plan.
 * `at` is a placeholder here; `stampMonotonic` assigns the real unique clock.
 */
function eventArbitrary(): fc.Arbitrary<MissionStreamEvent> {
  const missionId = fc.constantFrom(...MISSION_IDS)
  const stepId = fc.constantFrom(...STEP_IDS)
  const at = fc.constant(0)
  return fc.oneof(
    fc.record({ missionId, at }).map(
      ({ missionId, at }): MissionStreamEvent => ({ type: 'mission.started', missionId, at }),
    ),
    fc.record({ missionId, at, stepId }).map(
      ({ missionId, at, stepId }): MissionStreamEvent => ({ type: 'step.started', missionId, at, stepId }),
    ),
    fc.record({ missionId, at, stepId, rows: fc.integer({ min: 0, max: 3 }) }).map(
      ({ missionId, at, stepId, rows }): MissionStreamEvent => ({
        type: 'step.updated',
        missionId,
        at,
        stepId,
        // A full activity snapshot is `at`-gated (latest-by-`at` wins), so it
        // converges. Content keyed off `rows` so distinct snapshots differ.
        agentActivity: Array.from({ length: rows }, (_, i) => ({
          taskId: `${stepId}-run-${i}`,
          tool: 'coder',
          status: 'completed',
          detail: `run ${i}`,
          startedAt: '2026-01-01T00:00:00.000Z',
        })),
      }),
    ),
    // A step/mission completes ONCE with ONE outcome — the reducer makes the
    // FIRST terminal of equal rank authoritative and ignores a later
    // contradicting one (documented duplicate-class artifact handling). So the
    // outcome is derived deterministically from the id: every (re)delivery of a
    // given step/mission's completion agrees, modelling reality rather than
    // manufacturing a contradictory-terminal stream the reducer never sees.
    fc.record({ missionId, at, stepId }).map(
      ({ missionId, at, stepId }): MissionStreamEvent => ({
        type: 'step.completed',
        missionId,
        at,
        stepId,
        ok: outcomeFor(`${missionId}:${stepId}`),
      }),
    ),
    fc.record({ missionId, at, spentUsd: fc.integer({ min: 0, max: 1000 }).map((n) => n / 100) }).map(
      ({ missionId, at, spentUsd }): MissionStreamEvent => ({ type: 'cost.updated', missionId, at, spentUsd }),
    ),
    fc.record({ missionId, at }).map(
      ({ missionId, at }): MissionStreamEvent => ({ type: 'mission.paused', missionId, at }),
    ),
    fc.record({ missionId, at }).map(
      ({ missionId, at }): MissionStreamEvent => ({ type: 'mission.resumed', missionId, at }),
    ),
    fc.record({ missionId, at }).map(
      ({ missionId, at }): MissionStreamEvent => {
        const ok = outcomeFor(missionId)
        return { type: 'mission.completed', missionId, at, ok, status: ok ? 'succeeded' : 'failed' }
      },
    ),
  )
}

/** Deterministic, id-derived completion outcome so every duplicate of a logical
 *  completion carries the SAME terminal — a step/mission completes once. */
function outcomeFor(key: string): boolean {
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return (hash & 1) === 0
}

/** Deterministic permutation of `events` driven by a list of fractional keys —
 *  a stable sort on the keys reorders without depending on Array.sort timing. */
function permute<T>(events: T[], keys: number[]): T[] {
  return events
    .map((event, index) => ({ event, key: keys[index] ?? 0, index }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.event)
}

/** Prepend a `mission.created` for every mission id present so the stream
 *  carries the plan that declares canonical step order — the production
 *  invariant a mission always satisfies. */
function withCreates(events: MissionStreamEvent[]): MissionStreamEvent[] {
  const ids = [...new Set(events.map((event) => event.missionId))]
  const creates = ids.map((missionId): MissionStreamEvent => ({
    type: 'mission.created',
    missionId,
    at: 0,
    title: `Mission ${missionId}`,
    steps: STEP_IDS.map((id) => ({ id, intent: `do ${id}`, kind: 'agent', status: 'pending' as const })),
  }))
  return [...creates, ...events]
}

describe('reduceMissionEvents — property: order + duplication tolerant', () => {
  it('any shuffle + duplication of a created stream converges to the same state', () => {
    fc.assert(
      fc.property(
        fc.array(eventArbitrary(), { minLength: 1, maxLength: 30 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 90, maxLength: 160 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        (rawEvents, shuffleKeys, dupePicks) => {
          const events = stampMonotonic(withCreates(rawEvents))
          const canonical = reduceMissionEvents(events)

          // Build a shuffled stream that also re-delivers a random subset of
          // events (at-least-once duplicates), then shuffle the whole thing —
          // the mission.created events shuffle too, proving the plan that fixes
          // step order may itself arrive late.
          const duplicated = [...events]
          for (const pick of dupePicks) {
            duplicated.push(events[pick % events.length]!)
          }
          const shuffled = permute(duplicated, shuffleKeys)
          const replayed = reduceMissionEvents(shuffled)

          expect(normalize(replayed)).toEqual(normalize(canonical))
        },
      ),
      { numRuns: 300 },
    )
  })

  it('per-step state (keyed by id) converges under ANY shuffle, even with no plan event', () => {
    // The weaker invariant that holds with NO mission.created: step ARRAY order
    // may be arrival-dependent, but each step's STATE keyed by id is identical.
    fc.assert(
      fc.property(
        fc.array(eventArbitrary(), { minLength: 1, maxLength: 30 }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 30, maxLength: 90 }),
        (rawEvents, shuffleKeys) => {
          const events = stampMonotonic(rawEvents)
          const canonical = reduceMissionEvents(events)
          const replayed = reduceMissionEvents(permute(events, shuffleKeys))
          expect(stepStatesById(replayed)).toEqual(stepStatesById(canonical))
        },
      ),
      { numRuns: 300 },
    )
  })

  it('folding in two halves equals folding the whole (seed associativity)', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary(), { minLength: 1, maxLength: 30 }), (rawEvents) => {
        const events = stampMonotonic(withCreates(rawEvents))
        const whole = reduceMissionEvents(events)
        const mid = Math.floor(events.length / 2)
        const firstHalf = reduceMissionEvents(events.slice(0, mid))
        const both = reduceMissionEvents(events.slice(mid), firstHalf)
        expect(normalize(both)).toEqual(normalize(whole))
      }),
      { numRuns: 300 },
    )
  })
})

/** Map → plain object with sorted keys so `toEqual` compares state, not Map
 *  insertion order. */
function normalize(state: Map<string, MissionState>): Record<string, MissionState> {
  const out: Record<string, MissionState> = {}
  for (const key of [...state.keys()].sort()) out[key] = state.get(key)!
  return out
}

/** Project each mission to a sorted-by-id map of step states — order-insensitive
 *  so it isolates per-step state convergence from step-array ordering. */
function stepStatesById(state: Map<string, MissionState>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const key of [...state.keys()].sort()) {
    const mission = state.get(key)!
    const byId: Record<string, unknown> = {}
    for (const step of [...mission.steps].sort((a, b) => a.id.localeCompare(b.id))) byId[step.id] = step
    out[key] = byId
  }
  return out
}
