/**
 * Storage contract binding the sequence model to a product's database. The
 * product constructs one store per (workspace, sequence, actor) request scope —
 * RBAC and workspace isolation happen BEFORE construction (the product's
 * `requireWorkspaceAccess` equivalent); the store never re-checks identity.
 *
 * Every method throws on failure — no silent nulls, no `{ ok: false }` wrappers
 * at this layer. The MCP dispatcher (./mcp) is the boundary that converts
 * thrown errors into structured tool errors the model can read and react to.
 *
 * Mutations append to the decision log themselves only when the operation
 * dispatcher asks (`recordDecision`); plain CRUD stays log-free so human edits
 * driven by the UI can batch their own decision entries.
 */

import type {
  SequenceClip,
  SequenceDecision,
  SequenceExportFormat,
  SequenceExportRecord,
  SequenceMeta,
  SequenceTimeline,
  SequenceTrack,
  SequenceTrackKind,
} from './model'

export interface NewSequenceTrack {
  kind: SequenceTrackKind
  name: string
  sortOrder?: number
}

export interface NewSequenceClip {
  trackId: string
  label: string
  startFrame: number
  durationFrames: number
  sourceInFrame?: number
  sourceOutFrame?: number | null
  text?: string
  language?: string
  generationId?: string
  assetId?: string
  metadata?: Record<string, unknown>
}

export interface SequenceClipPatch {
  trackId?: string
  label?: string
  startFrame?: number
  durationFrames?: number
  sourceInFrame?: number
  sourceOutFrame?: number | null
  disabled?: boolean
  text?: string
  language?: string
  metadata?: Record<string, unknown>
}

export interface NewSequenceDecision {
  clipId?: string | null
  kind: SequenceDecision['kind']
  instruction: string
  reasoningSummary?: string | null
  accepted?: boolean | null
  metadata?: Record<string, unknown>
}

export interface SequenceStore {
  /** Full aggregate: sequence meta + tracks + clips with resolved media. */
  getTimeline(): Promise<SequenceTimeline>

  getClip(clipId: string): Promise<SequenceClip>

  createTrack(input: NewSequenceTrack): Promise<SequenceTrack>

  createClip(input: NewSequenceClip): Promise<SequenceClip>

  updateClip(clipId: string, patch: SequenceClipPatch): Promise<SequenceClip>

  deleteClip(clipId: string): Promise<void>

  /** Grow (or shrink, never below the last clip end) the sequence duration. */
  updateSequenceDuration(durationFrames: number): Promise<SequenceMeta>

  recordDecision(input: NewSequenceDecision): Promise<SequenceDecision>

  createExport(format: SequenceExportFormat, metadata?: Record<string, unknown>): Promise<SequenceExportRecord>

  listDecisions(limit?: number): Promise<SequenceDecision[]>

  listExports(limit?: number): Promise<SequenceExportRecord[]>
}

/** Per-request scope a product binds when constructing its store. Carried so
 *  decision rows and export rows attribute to the acting user; never trusted
 *  from tool arguments. */
export interface SequenceStoreScope {
  workspaceId: string
  sequenceId: string
  userId: string
}
