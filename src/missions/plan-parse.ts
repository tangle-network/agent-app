/**
 * Parsing for the agent-authored `:::mission` block — the bridge from a chat
 * prompt contract to the engine's MissionStep[] shape. The block format:
 *
 *   :::mission
 *   title: <mission title>
 *   <id>: <kind> | <intent>
 *   :::
 *
 * The allowed kind vocabulary is a PARAMETER — products pass their own list to
 * match their prompt directive; {@link DEFAULT_MISSION_STEP_KINDS} is the
 * default. Kinds label intent for gating and UX; they never select a different
 * execution path.
 */

import type { MissionStep } from './service'

/** Default step-kind vocabulary. `best-effort` matches the engine's default
 *  non-fatal kind (a failure does not abort the mission); the rest are
 *  fatal-on-failure agent sub-tasks. */
export const DEFAULT_MISSION_STEP_KINDS: readonly string[] = [
  'research',
  'generate',
  'analyze',
  'write',
  'best-effort',
]

export interface ParsedMissionStep {
  id: string
  kind: string
  intent: string
}

export interface ParsedMission {
  title: string
  steps: ParsedMissionStep[]
}

export interface ParseMissionBlocksOptions {
  /** Allowed step kinds (lowercase). Default {@link DEFAULT_MISSION_STEP_KINDS}. */
  kinds?: readonly string[]
}

/**
 * Parse every well-formed `:::mission` block. A block without a title or
 * without at least one valid step yields nothing (it is malformed — never
 * guess a plan from loose prose). Unknown kinds and malformed step lines are
 * dropped; an empty result lets the caller skip the block rather than start an
 * empty mission.
 */
export function parseMissionBlocks(
  fullContent: string,
  options: ParseMissionBlocksOptions = {},
): ParsedMission[] {
  const kinds = new Set(options.kinds ?? DEFAULT_MISSION_STEP_KINDS)
  const missionRegex = /:::mission\s*\n([\s\S]*?)\n\s*:::/g
  const missions: ParsedMission[] = []
  let match
  while ((match = missionRegex.exec(fullContent)) !== null) {
    const body = match[1]
    if (body === undefined) continue
    const parsed = parseMissionBody(body, kinds)
    if (parsed) missions.push(parsed)
  }
  return missions
}

function parseMissionBody(body: string, kinds: ReadonlySet<string>): ParsedMission | null {
  let title: string | null = null
  const steps: ParsedMissionStep[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const titleMatch = /^title\s*:\s*(.+)$/i.exec(line)
    if (titleMatch?.[1] !== undefined) {
      if (title === null) title = titleMatch[1].trim()
      continue
    }
    // `<id>: <kind> | <intent>`
    const stepMatch = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*:\s*([A-Za-z-]+)\s*\|\s*(.+)$/.exec(line)
    if (!stepMatch) continue
    const id = stepMatch[1]?.trim()
    const kind = stepMatch[2]?.trim().toLowerCase()
    const intent = stepMatch[3]?.trim()
    if (!id || !kind || !intent) continue
    if (!kinds.has(kind)) continue
    steps.push({ id, kind, intent })
  }
  if (!title || steps.length === 0) return null
  return { title, steps }
}

/**
 * Materialize parsed steps into the engine's MissionStep[] shape. Rejects a
 * duplicate step id (fail loud — the owner keys its durable step cache by
 * step id and `createMission` rejects duplicates anyway; catching it here
 * gives a clearer diagnostic). Every step starts `pending` with zero attempts.
 */
export function buildAgentMissionPlan(steps: ParsedMissionStep[]): MissionStep[] {
  if (steps.length === 0) throw new Error('mission plan must have at least one step')
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`duplicate mission step id "${step.id}" — step ids must be unique`)
    }
    seen.add(step.id)
  }
  return steps.map((step) => ({
    id: step.id,
    intent: step.intent,
    kind: step.kind,
    status: 'pending' as const,
    attempts: 0,
  }))
}
