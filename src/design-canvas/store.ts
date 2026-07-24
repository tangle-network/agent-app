/**
 * Storage contract for design-canvas documents. Unlike sequences (row per
 * clip), a scene document persists as ONE JSON value with a monotonic
 * revision counter — saves are atomic and optimistic: a save carrying a
 * stale `expectedRev` throws, the caller refetches and replays. That keeps
 * concurrent editors (human + agent in the same document) from silently
 * clobbering each other without needing row-level merge machinery.
 *
 * The product constructs one store per (workspace, document, actor) request
 * scope — RBAC runs BEFORE construction; the store never re-checks identity.
 * Every method throws on failure; the MCP dispatcher converts throws into
 * structured tool errors.
 */

import type { SceneDocument } from './model'

/** Represent a scene document with its current revision number for version tracking */
export interface SceneDocumentRecord {
  document: SceneDocument
  /** Monotonic revision; increments on every successful save. */
  rev: number
}

/** Define the structure for decisions made within a scene including type, instructions, and metadata */
export interface SceneDecision {
  id: string
  kind: 'human_edit' | 'agent_edit' | 'agent_proposal' | 'export' | 'note'
  instruction: string
  reasoningSummary: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

/** Define the structure for decisions related to creating a new scene with instructions and optional details */
export interface NewSceneDecision {
  kind: SceneDecision['kind']
  instruction: string
  reasoningSummary?: string | null
  metadata?: Record<string, unknown>
}

/** Define supported formats for exporting a scene including image and JSON options */
export type SceneExportFormat = 'png' | 'jpeg' | 'json'

/** Describe a scene export with its status, format, metadata, and result information */
export interface SceneExportRecord {
  id: string
  format: SceneExportFormat
  status: 'queued' | 'processing' | 'completed' | 'failed'
  resultUrl: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

/** Manage scene documents, decisions, and exports with atomic save and revision control */
export interface SceneStore {
  /** Current document + revision. */
  getDocument(): Promise<SceneDocumentRecord>

  /** Atomic full-document save. Throws when `expectedRev` is stale — the
   *  caller must refetch, reapply, and retry; never merge silently. */
  saveDocument(document: SceneDocument, expectedRev: number): Promise<SceneDocumentRecord>

  recordDecision(input: NewSceneDecision): Promise<SceneDecision>

  createExport(format: SceneExportFormat, metadata?: Record<string, unknown>): Promise<SceneExportRecord>

  listDecisions(limit?: number): Promise<SceneDecision[]>

  listExports(limit?: number): Promise<SceneExportRecord[]>
}

/** Per-request scope a product binds at store construction; decision and
 *  export rows attribute to the acting user — never trusted from tool args. */
export interface SceneStoreScope {
  workspaceId: string
  documentId: string
  userId: string
}
