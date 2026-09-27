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
import type { MissionStep } from './service';
/** Default step-kind vocabulary. `best-effort` matches the engine's default
 *  non-fatal kind (a failure does not abort the mission); the rest are
 *  fatal-on-failure agent sub-tasks. */
export declare const DEFAULT_MISSION_STEP_KINDS: readonly string[];
/** Define the structure representing a parsed mission step with id, kind, and intent fields */
export interface ParsedMissionStep {
    id: string;
    kind: string;
    intent: string;
}
/** Describe a mission with a title and an ordered list of parsed steps */
export interface ParsedMission {
    title: string;
    steps: ParsedMissionStep[];
}
/** Define options to specify allowed lowercase step kinds for parsing mission blocks */
export interface ParseMissionBlocksOptions {
    /** Allowed step kinds (lowercase). Default {@link DEFAULT_MISSION_STEP_KINDS}. */
    kinds?: readonly string[];
}
/**
 * Parse every well-formed `:::mission` block. A block without a title or
 * without at least one valid step yields nothing (it is malformed — never
 * guess a plan from loose prose). Unknown kinds and malformed step lines are
 * dropped; an empty result lets the caller skip the block rather than start an
 * empty mission.
 */
export declare function parseMissionBlocks(fullContent: string, options?: ParseMissionBlocksOptions): ParsedMission[];
/**
 * Materialize parsed steps into the engine's MissionStep[] shape. Rejects a
 * duplicate step id (fail loud — the owner keys its durable step cache by
 * step id and `createMission` rejects duplicates anyway; catching it here
 * gives a clearer diagnostic). Every step starts `pending` with zero attempts.
 */
export declare function buildAgentMissionPlan(steps: ParsedMissionStep[]): MissionStep[];
