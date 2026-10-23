import type { SequenceMeta } from './model'

/** A persisted sequence's public fields, independent of its database driver. */
export type SequenceMetaRow = Omit<SequenceMeta, 'metadata'> & {
  metadata: Record<string, unknown> | null
}

/** Project persisted sequence fields without importing the optional Drizzle peer. */
export function sequenceMetaFromRow(row: SequenceMetaRow): SequenceMeta {
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
