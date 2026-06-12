/**
 * Drizzle-backed `SequenceStore` over the tables from `createSequenceTables`.
 * Works against any SQLite drizzle driver (better-sqlite3, D1, libsql) — the
 * builders are awaited, never `.run()`/`.all()`, so sync and async drivers
 * behave identically.
 *
 * Defense in depth: RBAC runs before the store is constructed, but every
 * query still pins `workspaceId` AND `sequenceId` from the scope in its WHERE
 * clause, so a leaked or attacker-supplied row id from another workspace can
 * never read or write across the boundary — it surfaces as "not found".
 *
 * Store-level invariants (everything richer lives in the operation
 * validator): frame fields must be non-negative integers, clip durations at
 * least `MIN_SEQUENCE_CLIP_FRAMES`, and the sequence duration can never
 * shrink below the last clip end. Every mutation bumps `sequence.updatedAt`
 * so workspace recency sorts stay truthful.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase, SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core'
import {
  MIN_SEQUENCE_CLIP_FRAMES,
  type SequenceClip,
  type SequenceClipMedia,
  type SequenceDecision,
  type SequenceExportFormat,
  type SequenceExportRecord,
  type SequenceMeta,
  type SequenceTimeline,
  type SequenceTrack,
} from './model'
import type {
  NewSequenceClip,
  NewSequenceDecision,
  NewSequenceTrack,
  SequenceClipPatch,
  SequenceStore,
  SequenceStoreScope,
} from './store'
import type {
  SequenceClipRow,
  SequenceDecisionRow,
  SequenceExportRow,
  SequenceRow,
  SequenceTables,
  SequenceTrackRow,
} from './schema'

/** Any SQLite drizzle database — `any` erases the driver-specific run-result
 *  and schema generics so better-sqlite3, D1, and libsql handles all fit. */
export type SequenceDatabase = BaseSQLiteDatabase<'sync' | 'async', any, any>

/** Resolves product-specific media (generation rows, asset rows) for a batch
 *  of clip rows. Keyed by clip id; clips absent from the map carry no media. */
export type SequenceMediaResolver = (clipRows: SequenceClipRow[]) => Promise<Map<string, SequenceClipMedia>>

export interface CreateDrizzleSequenceStoreOptions {
  db: SequenceDatabase
  tables: SequenceTables
  scope: SequenceStoreScope
  resolveMedia?: SequenceMediaResolver
}

const DEFAULT_LIST_LIMIT = 50

export function createDrizzleSequenceStore(options: CreateDrizzleSequenceStoreOptions): SequenceStore {
  const { db, tables, scope, resolveMedia } = options
  const { sequences, sequenceTracks, sequenceClips, sequenceDecisions, sequenceExports } = tables

  const sequenceScope = () => and(eq(sequences.id, scope.sequenceId), eq(sequences.workspaceId, scope.workspaceId))
  const trackScope = () => and(eq(sequenceTracks.sequenceId, scope.sequenceId), eq(sequenceTracks.workspaceId, scope.workspaceId))
  const clipScope = () => and(eq(sequenceClips.sequenceId, scope.sequenceId), eq(sequenceClips.workspaceId, scope.workspaceId))
  const decisionScope = () => and(eq(sequenceDecisions.sequenceId, scope.sequenceId), eq(sequenceDecisions.workspaceId, scope.workspaceId))
  const exportScope = () => and(eq(sequenceExports.sequenceId, scope.sequenceId), eq(sequenceExports.workspaceId, scope.workspaceId))

  async function requireSequenceRow(): Promise<SequenceRow> {
    const [row] = await db.select().from(sequences).where(sequenceScope()).limit(1)
    if (!row) throw new Error(`Sequence ${scope.sequenceId} not found in workspace ${scope.workspaceId}`)
    return row
  }

  async function requireTrackRow(trackId: string): Promise<SequenceTrackRow> {
    const [row] = await db.select().from(sequenceTracks).where(and(trackScope(), eq(sequenceTracks.id, trackId))).limit(1)
    if (!row) throw new Error(`Track ${trackId} not found in sequence ${scope.sequenceId}`)
    return row
  }

  async function requireClipRow(clipId: string): Promise<SequenceClipRow> {
    const [row] = await db.select().from(sequenceClips).where(and(clipScope(), eq(sequenceClips.id, clipId))).limit(1)
    if (!row) throw new Error(`Clip ${clipId} not found in sequence ${scope.sequenceId}`)
    return row
  }

  async function touchSequence(): Promise<void> {
    await db.update(sequences).set({ updatedAt: new Date() }).where(sequenceScope())
  }

  async function clipWithMedia(row: SequenceClipRow): Promise<SequenceClip> {
    const media = resolveMedia ? await resolveMedia([row]) : undefined
    return mapClip(row, media?.get(row.id))
  }

  return {
    async getTimeline(): Promise<SequenceTimeline> {
      const sequenceRow = await requireSequenceRow()
      const [trackRows, clipRows] = await Promise.all([
        db.select().from(sequenceTracks).where(trackScope())
          .orderBy(asc(sequenceTracks.sortOrder), asc(sequenceTracks.createdAt)),
        db.select().from(sequenceClips).where(clipScope())
          .orderBy(asc(sequenceClips.startFrame), asc(sequenceClips.createdAt)),
      ])
      const media = resolveMedia ? await resolveMedia(clipRows) : undefined
      return {
        sequence: mapSequence(sequenceRow),
        tracks: trackRows.map(mapTrack),
        clips: clipRows.map((row) => mapClip(row, media?.get(row.id))),
      }
    },

    async getClip(clipId: string): Promise<SequenceClip> {
      return clipWithMedia(await requireClipRow(clipId))
    },

    async createTrack(input: NewSequenceTrack): Promise<SequenceTrack> {
      await requireSequenceRow()
      let sortOrder = input.sortOrder
      if (sortOrder === undefined) {
        const [aggregate] = await db
          .select({ maxSortOrder: sql<number | null>`max(${sequenceTracks.sortOrder})` })
          .from(sequenceTracks)
          .where(trackScope())
        sortOrder = (aggregate?.maxSortOrder ?? -1) + 1
      }
      const [row] = await db.insert(sequenceTracks).values({
        sequenceId: scope.sequenceId,
        workspaceId: scope.workspaceId,
        kind: input.kind,
        name: input.name,
        sortOrder,
      }).returning()
      if (!row) throw new Error('sequence_track insert returned no row')
      await touchSequence()
      return mapTrack(row)
    },

    async createClip(input: NewSequenceClip): Promise<SequenceClip> {
      assertFrame(input.startFrame, 'startFrame')
      assertClipDuration(input.durationFrames)
      if (input.sourceInFrame !== undefined) assertFrame(input.sourceInFrame, 'sourceInFrame')
      if (typeof input.sourceOutFrame === 'number') assertFrame(input.sourceOutFrame, 'sourceOutFrame')
      await requireTrackRow(input.trackId)
      const [row] = await db.insert(sequenceClips).values({
        sequenceId: scope.sequenceId,
        workspaceId: scope.workspaceId,
        trackId: input.trackId,
        label: input.label,
        startFrame: input.startFrame,
        durationFrames: input.durationFrames,
        sourceInFrame: input.sourceInFrame ?? 0,
        sourceOutFrame: input.sourceOutFrame ?? null,
        text: input.text ?? null,
        language: input.language ?? null,
        generationId: input.generationId ?? null,
        assetId: input.assetId ?? null,
        metadata: input.metadata ?? {},
        createdBy: scope.userId,
      }).returning()
      if (!row) throw new Error('sequence_clip insert returned no row')
      await touchSequence()
      return clipWithMedia(row)
    },

    async updateClip(clipId: string, patch: SequenceClipPatch): Promise<SequenceClip> {
      await requireClipRow(clipId)
      if (patch.trackId !== undefined) await requireTrackRow(patch.trackId)
      if (patch.startFrame !== undefined) assertFrame(patch.startFrame, 'startFrame')
      if (patch.durationFrames !== undefined) assertClipDuration(patch.durationFrames)
      if (patch.sourceInFrame !== undefined) assertFrame(patch.sourceInFrame, 'sourceInFrame')
      if (typeof patch.sourceOutFrame === 'number') assertFrame(patch.sourceOutFrame, 'sourceOutFrame')

      const updates: SQLiteUpdateSetSource<SequenceTables['sequenceClips']> = {
        updatedAt: new Date(),
        version: sql`${sequenceClips.version} + 1`,
      }
      if (patch.trackId !== undefined) updates.trackId = patch.trackId
      if (patch.label !== undefined) updates.label = patch.label
      if (patch.startFrame !== undefined) updates.startFrame = patch.startFrame
      if (patch.durationFrames !== undefined) updates.durationFrames = patch.durationFrames
      if (patch.sourceInFrame !== undefined) updates.sourceInFrame = patch.sourceInFrame
      if (patch.sourceOutFrame !== undefined) updates.sourceOutFrame = patch.sourceOutFrame
      if (patch.disabled !== undefined) updates.disabled = patch.disabled
      if (patch.text !== undefined) updates.text = patch.text
      if (patch.language !== undefined) updates.language = patch.language
      if (patch.metadata !== undefined) updates.metadata = patch.metadata

      const [row] = await db.update(sequenceClips).set(updates)
        .where(and(clipScope(), eq(sequenceClips.id, clipId)))
        .returning()
      if (!row) throw new Error(`Clip ${clipId} not found in sequence ${scope.sequenceId}`)
      await touchSequence()
      return clipWithMedia(row)
    },

    async deleteClip(clipId: string): Promise<void> {
      await requireClipRow(clipId)
      await db.delete(sequenceClips).where(and(clipScope(), eq(sequenceClips.id, clipId)))
      await touchSequence()
    },

    async updateSequenceDuration(durationFrames: number): Promise<SequenceMeta> {
      if (!Number.isInteger(durationFrames) || durationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
        throw new Error('durationFrames must be a positive integer')
      }
      await requireSequenceRow()
      // Disabled clips still occupy the timeline (they can be re-enabled), so
      // they count toward the shrink floor.
      const [aggregate] = await db
        .select({ maxEndFrame: sql<number | null>`max(${sequenceClips.startFrame} + ${sequenceClips.durationFrames})` })
        .from(sequenceClips)
        .where(clipScope())
      const maxEndFrame = aggregate?.maxEndFrame ?? 0
      if (durationFrames < maxEndFrame) {
        throw new Error(`Cannot set sequence duration to ${durationFrames} frames: the last clip ends at frame ${maxEndFrame}. Trim or delete clips first.`)
      }
      const [row] = await db.update(sequences)
        .set({ durationFrames, updatedAt: new Date() })
        .where(sequenceScope())
        .returning()
      if (!row) throw new Error(`Sequence ${scope.sequenceId} not found in workspace ${scope.workspaceId}`)
      return mapSequence(row)
    },

    async recordDecision(input: NewSequenceDecision): Promise<SequenceDecision> {
      await requireSequenceRow()
      if (typeof input.clipId === 'string') await requireClipRow(input.clipId)
      const [row] = await db.insert(sequenceDecisions).values({
        sequenceId: scope.sequenceId,
        workspaceId: scope.workspaceId,
        clipId: input.clipId ?? null,
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        accepted: input.accepted ?? null,
        metadata: input.metadata ?? {},
        createdBy: scope.userId,
      }).returning()
      if (!row) throw new Error('sequence_decision insert returned no row')
      await touchSequence()
      return mapDecision(row)
    },

    async createExport(format: SequenceExportFormat, metadata?: Record<string, unknown>): Promise<SequenceExportRecord> {
      await requireSequenceRow()
      const [row] = await db.insert(sequenceExports).values({
        sequenceId: scope.sequenceId,
        workspaceId: scope.workspaceId,
        format,
        metadata: metadata ?? {},
        createdBy: scope.userId,
      }).returning()
      if (!row) throw new Error('sequence_export insert returned no row')
      await touchSequence()
      return mapExport(row)
    },

    async listDecisions(limit = DEFAULT_LIST_LIMIT): Promise<SequenceDecision[]> {
      assertListLimit(limit)
      // created_at has one-second resolution (unixepoch); rowid breaks ties in
      // insertion order so the log reads newest-first deterministically.
      const rows = await db.select().from(sequenceDecisions)
        .where(decisionScope())
        .orderBy(desc(sequenceDecisions.createdAt), desc(sql`rowid`))
        .limit(limit)
      return rows.map(mapDecision)
    },

    async listExports(limit = DEFAULT_LIST_LIMIT): Promise<SequenceExportRecord[]> {
      assertListLimit(limit)
      const rows = await db.select().from(sequenceExports)
        .where(exportScope())
        .orderBy(desc(sequenceExports.createdAt), desc(sql`rowid`))
        .limit(limit)
      return rows.map(mapExport)
    },
  }
}

// ---------------------------------------------------------------------------
// Row → model mapping. Metadata columns are nullable with a `{}` default;
// SQL NULL and `{}` both mean "no metadata", so `?? {}` is a lossless
// representation conversion, not an error-hiding fallback. Nullable text
// columns map to the model's optional (`undefined`) fields the same way.
// ---------------------------------------------------------------------------

function mapSequence(row: SequenceRow): SequenceMeta {
  return {
    id: row.id,
    title: row.title,
    fps: row.fps,
    width: row.width,
    height: row.height,
    aspectRatio: row.aspectRatio,
    durationFrames: row.durationFrames,
    status: row.status,
    metadata: row.metadata ?? {},
  }
}

function mapTrack(row: SequenceTrackRow): SequenceTrack {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    sortOrder: row.sortOrder,
    locked: row.locked,
    muted: row.muted,
    metadata: row.metadata ?? {},
  }
}

function mapClip(row: SequenceClipRow, media: SequenceClipMedia | undefined): SequenceClip {
  return {
    id: row.id,
    trackId: row.trackId,
    label: row.label,
    startFrame: row.startFrame,
    durationFrames: row.durationFrames,
    sourceInFrame: row.sourceInFrame,
    sourceOutFrame: row.sourceOutFrame,
    disabled: row.disabled,
    text: row.text ?? undefined,
    language: row.language ?? undefined,
    generationId: row.generationId ?? undefined,
    assetId: row.assetId ?? undefined,
    media,
    metadata: row.metadata ?? {},
  }
}

function mapDecision(row: SequenceDecisionRow): SequenceDecision {
  return {
    id: row.id,
    clipId: row.clipId,
    kind: row.kind,
    instruction: row.instruction,
    reasoningSummary: row.reasoningSummary,
    accepted: row.accepted,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
  }
}

function mapExport(row: SequenceExportRow): SequenceExportRecord {
  return {
    id: row.id,
    format: row.format,
    status: row.status,
    resultUrl: row.resultUrl,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt,
  }
}

function assertFrame(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
}

function assertClipDuration(durationFrames: number): void {
  if (!Number.isInteger(durationFrames) || durationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error('durationFrames must be a positive integer')
  }
}

function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
}
