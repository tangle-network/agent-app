/**
 * Shared mission realtime contract — the single source of truth for the typed
 * events the engine BROADCASTS over a live channel and the client REDUCES into
 * live mission state. Server emit and client reduce import the same module so
 * the wire shape can never drift between the two ends.
 *
 * This module is CLIENT-SAFE: no server imports, no platform globals, no DB
 * types. It is pure data + a pure reducer. Keep it that way — a server-only
 * import here would leak into the browser bundle.
 *
 * Sink contract — best-effort UI notification, never load-bearing:
 *   - fire-and-forget: the engine never awaits `emit` and a sink failure can
 *     never fail a step (the engine wraps every emit). The durable audit-event
 *     row is the authoritative timeline; the socket is a convenience.
 *   - replay-safe: the engine re-emits on a resume/replay. The reducer below is
 *     idempotent + order-tolerant, so a re-sent or duplicated event converges.
 *     The sink itself does no dedupe.
 */

import type { StepAgentActivity } from './agent-activity'

/** Handle mission stream events by processing emitted MissionStreamEvent objects */
export interface MissionEventSink {
  emit(event: MissionStreamEvent): void
}

/** A sink that drops every event — the engine default when no live channel is
 *  wired (and the unit-test default). */
export const noopEventSink: MissionEventSink = { emit() {} }

/** Workspace-wide channel id missions broadcast on (alongside any per-thread
 *  channel the product keys). */
export const MISSION_CONTROL_CHANNEL_ID = 'missions'

/** One plan step as it appears on the wire — only what a live UI needs
 *  (`sublabel` updates travel separately via `step.updated` so the snapshot
 *  stays small). */
export interface MissionStreamStep {
  id: string
  intent: string
  kind: string
  status: MissionStreamStepStatus
}

/** Define possible status values for a mission stream step */
export type MissionStreamStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'waiting_approval'

/** Define possible statuses representing the current state of a mission stream */
export type MissionStreamStatus =
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'succeeded'
  | 'aborted'
  | 'cancelled'
  | 'failed'

/**
 * Discriminated union of every live mission event. Every member carries
 * `missionId` (one channel may multiplex several missions) and a `type` the
 * client switches on. `at` is the emitter's wall-clock ms — used only for
 * display ordering; the reducer never trusts it for causality.
 */
export type MissionStreamEvent =
  | {
      type: 'mission.created'
      missionId: string
      at: number
      title: string
      status?: MissionStreamStatus
      steps: MissionStreamStep[]
      budgetUsd?: number | null
    }
  | { type: 'mission.started'; missionId: string; at: number }
  | { type: 'step.started'; missionId: string; at: number; stepId: string }
  | {
      type: 'step.updated'
      missionId: string
      at: number
      stepId: string
      sublabel?: string
      /**
       * Full CURRENT snapshot of the step's delegated runs — never a delta.
       * The reducer replaces the whole lane (latest snapshot wins by `at`), so
       * emitters re-send everything they know each time and at-least-once /
       * out-of-order delivery converges.
       */
      agentActivity?: StepAgentActivity[]
    }
  | {
      type: 'step.completed'
      missionId: string
      at: number
      stepId: string
      ok: boolean
      reason?: string
      durationMs?: number
    }
  | {
      type: 'cost.updated'
      missionId: string
      at: number
      spentUsd: number
      capUsd?: number | null
    }
  | { type: 'mission.paused'; missionId: string; at: number; reason?: string }
  | { type: 'mission.waiting_approval'; missionId: string; at: number; reason?: string }
  | { type: 'mission.resumed'; missionId: string; at: number }
  | {
      type: 'mission.plan.updated'
      missionId: string
      at: number
      title: string
      steps: MissionStreamStep[]
      budgetUsd?: number | null
    }
  | {
      type: 'mission.completed'
      missionId: string
      at: number
      ok: boolean
      status?: Extract<MissionStreamStatus, 'succeeded' | 'failed' | 'aborted' | 'cancelled'>
      summary?: string
    }

// All mission event `type` discriminants. Used to cheaply reject the non-mission
// events that share a channel without a full switch.
const MISSION_EVENT_TYPES: ReadonlySet<string> = new Set<MissionStreamEvent['type']>([
  'mission.created',
  'mission.started',
  'step.started',
  'step.updated',
  'step.completed',
  'cost.updated',
  'mission.paused',
  'mission.waiting_approval',
  'mission.resumed',
  'mission.plan.updated',
  'mission.completed',
])

/**
 * Reconstruct the flat MissionStreamEvent from a broadcast envelope of shape
 * `{ type, data: { ...missionFields } }` (transports may also stamp routing
 * fields like workspaceId/threadId into `data`). The envelope `type` is the
 * AUTHORITATIVE discriminant set by the server, so it is spread LAST — a
 * payload that happens to carry a top-level `type` inside `data` cannot shadow
 * it and mis-render as a mission event. Non-mission envelopes and malformed
 * payloads return null and are simply skipped, so one channel can carry both
 * streams.
 */
export function parseSessionStreamEnvelope(raw: unknown): MissionStreamEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const envelope = raw as { type?: unknown; data?: unknown }
  if (typeof envelope.type !== 'string') return null
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {}
  return asMissionStreamEvent({ ...(data as Record<string, unknown>), type: envelope.type })
}

/** Narrow an arbitrary channel payload to a MissionStreamEvent. Returns null
 *  for non-mission events and anything malformed — the reducer skips those. */
export function asMissionStreamEvent(value: unknown): MissionStreamEvent | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string' || !MISSION_EVENT_TYPES.has(type)) return null
  if (typeof record.missionId !== 'string' || !record.missionId) return null
  // `at` is best-effort: this narrows the type but does not fill a default —
  // the reducer tolerates a missing `at` and treats it as 0.
  return value as MissionStreamEvent
}

/** Live per-step view the reducer maintains. `status` only ever moves FORWARD
 *  (see STEP_RANK) so a duplicate/out-of-order event can never regress a step
 *  from done back to running. */
export interface MissionStepState {
  id: string
  intent: string
  kind: string
  status: MissionStreamStepStatus
  sublabel?: string
  reason?: string
  durationMs?: number
  /** Latest delegated-run snapshot for the step (see `step.updated`). */
  agentActivity?: StepAgentActivity[]
  /** The `at` of the snapshot currently held — an older snapshot arriving
   *  late never replaces a newer one. */
  agentActivityAt?: number
}

/** Live per-mission view the reducer folds events into. */
export interface MissionState {
  missionId: string
  title?: string
  status: MissionStreamStatus
  steps: MissionStepState[]
  spentUsd: number
  capUsd?: number | null
  pauseReason?: string
  summary?: string
  /** The largest `at` folded so far — purely for display; never gates folding. */
  lastEventAt: number
  /** The largest pause/resume control `at` folded — lets a newer resume beat an
   *  older pause that arrives late. */
  lastControlAt?: number
}

// Monotonic rank for step status. A fold NEVER moves a step to a lower rank, so
// a late/duplicate `step.started` arriving after `step.completed` is a no-op —
// the reducer tolerates out-of-order and at-least-once delivery.
const STEP_RANK: Record<MissionStreamStepStatus, number> = {
  pending: 0,
  running: 1,
  waiting_approval: 2,
  // done and failed are both TERMINAL for a step; rank them equal-and-highest
  // so neither can be overwritten by the other or regressed to running.
  done: 3,
  failed: 3,
}

// Monotonic rank for mission status. Same forward-only guarantee: a stray
// `mission.started` after `mission.completed` cannot un-finish a mission.
const MISSION_RANK: Record<MissionStreamStatus, number> = {
  scheduled: 0,
  running: 1,
  paused: 2,
  waiting_approval: 2,
  succeeded: 3,
  aborted: 3,
  cancelled: 3,
  failed: 3,
}

function maxStepStatus(
  current: MissionStreamStepStatus,
  next: MissionStreamStepStatus,
): MissionStreamStepStatus {
  // Equal rank but different terminal kind (done vs failed): the FIRST terminal
  // wins — a step.completed is authoritative and a later contradicting one is a
  // duplicate-class artifact we ignore.
  if (STEP_RANK[next] <= STEP_RANK[current]) return current
  return next
}

function maxMissionStatus(
  current: MissionStreamStatus,
  next: MissionStreamStatus,
): MissionStreamStatus {
  if (MISSION_RANK[next] <= MISSION_RANK[current]) return current
  return next
}

function emptyMission(missionId: string): MissionState {
  // Seed at the LOWEST status rank so a fold-in is purely monotonic. A
  // step.started that arrives before mission.created must not pin the mission
  // at `running`: were the create to carry `scheduled`, the reducer would then
  // diverge by arrival order (created-first → scheduled, started-first →
  // running). Seeding `scheduled` makes every status edge climb upward only, so
  // both orders converge to the same state.
  return {
    missionId,
    status: 'scheduled',
    steps: [],
    spentUsd: 0,
    lastEventAt: 0,
    lastControlAt: 0,
  }
}

function stepStateFrom(step: MissionStreamStep): MissionStepState {
  return { id: step.id, intent: step.intent, kind: step.kind, status: step.status }
}

/**
 * Fold one event into one mission's state. PURE: returns a new state, mutates
 * nothing. Idempotent + order-tolerant — every status move is clamped through
 * the monotonic ranks above, so duplicates and out-of-order delivery converge
 * to the same terminal state regardless of arrival order.
 */
export function applyMissionEvent(
  prev: MissionState | undefined,
  event: MissionStreamEvent,
): MissionState {
  const at = typeof event.at === 'number' ? event.at : 0
  const base = prev ?? emptyMission(event.missionId)
  const lastEventAt = Math.max(base.lastEventAt, at)
  const lastControlAt = base.lastControlAt ?? 0

  switch (event.type) {
    case 'mission.created': {
      // The authoritative plan snapshot. Merge rather than overwrite so a
      // late-arriving create (e.g. after the client already saw a step.started
      // from a reconnect race) does not clobber forward step progress.
      const merged = event.steps.map((incoming) => {
        const existing = base.steps.find((s) => s.id === incoming.id)
        if (!existing) return stepStateFrom(incoming)
        return {
          ...existing,
          intent: incoming.intent,
          kind: incoming.kind,
          status: maxStepStatus(existing.status, incoming.status),
        }
      })
      // Keep any steps the client already knew that the snapshot omits (it
      // never should, but never drop known progress).
      for (const known of base.steps) {
        if (!merged.some((s) => s.id === known.id)) merged.push(known)
      }
      return {
        ...base,
        title: event.title || base.title,
        status: maxMissionStatus(base.status, event.status ?? base.status),
        capUsd: event.budgetUsd ?? base.capUsd,
        steps: merged,
        lastEventAt,
      }
    }

    case 'mission.started':
      return { ...base, status: maxMissionStatus(base.status, 'running'), lastEventAt }

    case 'step.started':
      return {
        ...base,
        steps: upsertStep(base.steps, event.stepId, (step) => ({
          ...step,
          status: maxStepStatus(step.status, 'running'),
        })),
        lastEventAt,
      }

    case 'step.updated':
      return {
        ...base,
        steps: upsertStep(base.steps, event.stepId, (step) => ({
          ...step,
          // A sublabel is a live counter ("7/15") — always take the latest; it
          // does not move status.
          ...(event.sublabel !== undefined ? { sublabel: event.sublabel } : {}),
          // agentActivity is a full snapshot, replaced wholesale. Guarded by
          // `at` so a stale snapshot delivered late never erases newer rows;
          // an equal-`at` replay rewrites identical content (idempotent).
          ...(event.agentActivity !== undefined && at >= (step.agentActivityAt ?? 0)
            ? { agentActivity: event.agentActivity, agentActivityAt: at }
            : {}),
        })),
        lastEventAt,
      }

    case 'step.completed':
      return {
        ...base,
        steps: upsertStep(base.steps, event.stepId, (step) => ({
          ...step,
          status: maxStepStatus(step.status, event.ok ? 'done' : 'failed'),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        })),
        lastEventAt,
      }

    case 'cost.updated':
      return {
        ...base,
        // spentUsd is cumulative and monotonically non-decreasing at the
        // source; clamp so an out-of-order older value never lowers the
        // displayed spend.
        spentUsd: Math.max(base.spentUsd, event.spentUsd),
        capUsd: event.capUsd ?? base.capUsd,
        lastEventAt,
      }

    case 'mission.paused':
      if (at <= lastControlAt) return { ...base, lastEventAt }
      return {
        ...base,
        status: maxMissionStatus(base.status, 'paused'),
        ...(event.reason !== undefined ? { pauseReason: event.reason } : {}),
        lastEventAt,
        lastControlAt: Math.max(lastControlAt, at),
      }

    case 'mission.waiting_approval':
      if (at <= lastControlAt) return { ...base, lastEventAt }
      return {
        ...base,
        status: maxMissionStatus(base.status, 'waiting_approval'),
        ...(event.reason !== undefined ? { pauseReason: event.reason } : {}),
        lastEventAt,
        lastControlAt: Math.max(lastControlAt, at),
      }

    case 'mission.resumed':
      if (at <= lastControlAt) return { ...base, lastEventAt }
      return {
        ...base,
        status: isTerminalStreamStatus(base.status) ? base.status : 'running',
        pauseReason: undefined,
        lastEventAt,
        lastControlAt: Math.max(lastControlAt, at),
      }

    case 'mission.plan.updated':
      return {
        ...base,
        title: event.title || base.title,
        capUsd: event.budgetUsd ?? base.capUsd,
        steps: event.steps.map((incoming) => {
          const existing = base.steps.find((s) => s.id === incoming.id)
          if (!existing) return stepStateFrom(incoming)
          return {
            ...stepStateFrom(incoming),
            status: maxStepStatus(existing.status, incoming.status),
            ...(existing.sublabel !== undefined ? { sublabel: existing.sublabel } : {}),
            ...(existing.reason !== undefined ? { reason: existing.reason } : {}),
            ...(existing.durationMs !== undefined ? { durationMs: existing.durationMs } : {}),
            ...(existing.agentActivity !== undefined ? { agentActivity: existing.agentActivity } : {}),
            ...(existing.agentActivityAt !== undefined ? { agentActivityAt: existing.agentActivityAt } : {}),
          }
        }),
        lastEventAt,
      }

    case 'mission.completed':
      return {
        ...base,
        status: maxMissionStatus(base.status, event.status ?? (event.ok ? 'succeeded' : 'failed')),
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        lastEventAt,
      }
  }
}

function isTerminalStreamStatus(status: MissionStreamStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'aborted' || status === 'cancelled'
}

// Upsert one step by id, applying `patch`. A step unknown to the client (e.g. a
// step.started arriving before the create snapshot on a reconnect) is created
// as a minimal `pending` row so progress is never dropped; the create snapshot
// fills in intent/kind when it arrives.
function upsertStep(
  steps: MissionStepState[],
  stepId: string,
  patch: (step: MissionStepState) => MissionStepState,
): MissionStepState[] {
  const index = steps.findIndex((s) => s.id === stepId)
  const existing = index < 0 ? undefined : steps[index]
  if (!existing) {
    const placeholder: MissionStepState = {
      id: stepId,
      intent: '',
      kind: '',
      status: 'pending',
    }
    return [...steps, patch(placeholder)]
  }
  const next = steps.slice()
  next[index] = patch(existing)
  return next
}

/**
 * Merge a loader SEED into the live state for one mission, advancing through
 * the SAME monotonic clamps the event reducer uses. The durable mission row is
 * the authoritative converged state: while the live channel is down the row
 * advances but the frozen live state does not, and nothing re-fires the gap to
 * a reconnecting client. Folding the seed THROUGH the clamps backfills that gap
 * on reconnect while never regressing a more-advanced live value:
 *   - a stale seed for a more-advanced live mission is a no-op,
 *   - an advanced seed after an outage fills the gap (status/steps/spend move
 *     forward to the row's converged state).
 * `live === undefined` (mission unknown to the client) just adopts the seed.
 */
export function mergeMissionState(live: MissionState | undefined, seed: MissionState): MissionState {
  if (!live) return seed

  // The loader seed carries the authoritative current plan. Rebuild from it,
  // while preserving live progress fields for matching ids and retaining
  // live-only steps that have real progress evidence.
  const steps: MissionStepState[] = []
  for (const seededStep of seed.steps) {
    const current = live.steps.find((s) => s.id === seededStep.id)
    if (!current) {
      steps.push(seededStep)
      continue
    }
    steps.push({
      ...seededStep,
      intent: current.intent || seededStep.intent,
      kind: current.kind || seededStep.kind,
      status: maxStepStatus(current.status, seededStep.status),
      ...(current.sublabel !== undefined ? { sublabel: current.sublabel } : seededStep.sublabel !== undefined ? { sublabel: seededStep.sublabel } : {}),
      ...(current.reason !== undefined ? { reason: current.reason } : seededStep.reason !== undefined ? { reason: seededStep.reason } : {}),
      ...(current.durationMs !== undefined ? { durationMs: current.durationMs } : seededStep.durationMs !== undefined ? { durationMs: seededStep.durationMs } : {}),
      // The newer snapshot wins by its stamped `at`; an unstamped lane (loader
      // seed copied from the settled artifact) only fills an empty live lane.
      ...(mergeActivity(current, seededStep)),
    })
  }
  for (const current of live.steps) {
    if (seed.steps.some((step) => step.id === current.id)) continue
    if (hasStepProgressEvidence(current)) steps.push(current)
  }

  const status = mergeSeedMissionStatus(live.status, seed.status, live.lastControlAt ?? 0, seed.lastControlAt ?? 0)
  return {
    ...live,
    title: live.title ?? seed.title,
    status,
    steps,
    spentUsd: Math.max(live.spentUsd, seed.spentUsd),
    capUsd: live.capUsd ?? seed.capUsd,
    pauseReason: status === 'running' || status === 'scheduled' ? undefined : seed.pauseReason ?? live.pauseReason,
    summary: live.summary ?? seed.summary,
    lastEventAt: Math.max(live.lastEventAt, seed.lastEventAt),
    lastControlAt: Math.max(live.lastControlAt ?? 0, seed.lastControlAt ?? 0),
  }
}

function hasStepProgressEvidence(step: MissionStepState): boolean {
  return step.status !== 'pending' ||
    step.sublabel !== undefined ||
    step.reason !== undefined ||
    step.durationMs !== undefined ||
    step.agentActivity !== undefined
}

// Pick the activity lane to keep when merging a loader seed into live state:
// the snapshot with the larger `at` wins; ties keep the live side.
function mergeActivity(
  live: MissionStepState,
  seeded: MissionStepState,
): Pick<MissionStepState, 'agentActivity' | 'agentActivityAt'> {
  const winner = (seeded.agentActivityAt ?? 0) > (live.agentActivityAt ?? 0) ? seeded : live
  if (winner.agentActivity === undefined) {
    const fallback = winner === live ? seeded : live
    if (fallback.agentActivity === undefined) return {}
    return {
      agentActivity: fallback.agentActivity,
      ...(fallback.agentActivityAt !== undefined ? { agentActivityAt: fallback.agentActivityAt } : {}),
    }
  }
  return {
    agentActivity: winner.agentActivity,
    ...(winner.agentActivityAt !== undefined ? { agentActivityAt: winner.agentActivityAt } : {}),
  }
}

function mergeSeedMissionStatus(
  liveStatus: MissionStreamStatus,
  seedStatus: MissionStreamStatus,
  liveControlAt: number,
  seedControlAt: number,
): MissionStreamStatus {
  if (isTerminalStreamStatus(liveStatus)) return liveStatus
  if (isTerminalStreamStatus(seedStatus)) return seedStatus
  if ((seedStatus === 'paused' || seedStatus === 'waiting_approval') && liveControlAt > seedControlAt) {
    return liveStatus
  }
  if (seedStatus === 'running') return 'running'
  if (seedStatus === 'scheduled' && liveStatus !== 'scheduled') return liveStatus
  return maxMissionStatus(liveStatus, seedStatus)
}

/**
 * Fold a whole event sequence into a Map<missionId, MissionState>. PURE and
 * order-tolerant: feeding the same events in any order (with duplicates)
 * converges to the same map. `seed` lets a reload start from loader-rehydrated
 * state before live events arrive.
 */
export function reduceMissionEvents(
  events: MissionStreamEvent[],
  seed?: Map<string, MissionState>,
): Map<string, MissionState> {
  const next = new Map<string, MissionState>(seed ?? [])
  for (const event of events) {
    next.set(event.missionId, applyMissionEvent(next.get(event.missionId), event))
  }
  return next
}
