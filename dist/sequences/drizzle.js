import {
  MIN_SEQUENCE_CLIP_FRAMES
} from "../chunk-BVKQKGRK.js";

// src/sequences/schema.ts
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
var hexId = () => text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`);
var jsonMetadata = () => text("metadata", { mode: "json" }).$type().default({});
var createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
var updatedAt = () => integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
function createSequenceTables(opts) {
  const { workspaceTable, userTable, generationTable, assetTable } = opts;
  const sequences = sqliteTable("sequence", {
    id: hexId(),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    fps: integer("fps").notNull().default(30),
    width: integer("width").notNull().default(1080),
    height: integer("height").notNull().default(1920),
    aspectRatio: text("aspect_ratio").notNull().default("9:16"),
    durationFrames: integer("duration_frames").notNull().default(900),
    status: text("status", { enum: ["draft", "active", "exporting", "archived"] }).notNull().default("draft"),
    metadata: jsonMetadata(),
    createdBy: text("created_by").notNull().references(() => userTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  }, (table) => [
    index("idx_sequence_workspace_status").on(table.workspaceId, table.status),
    index("idx_sequence_workspace_updated").on(table.workspaceId, table.updatedAt)
  ]);
  const sequenceTracks = sqliteTable("sequence_track", {
    id: hexId(),
    sequenceId: text("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["video", "audio", "caption", "reference", "agent"] }).notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    muted: integer("muted", { mode: "boolean" }).notNull().default(false),
    metadata: jsonMetadata(),
    createdAt: createdAt()
  }, (table) => [
    index("idx_sequence_track_sequence_order").on(table.sequenceId, table.sortOrder),
    index("idx_sequence_track_workspace").on(table.workspaceId)
  ]);
  const sequenceClips = sqliteTable("sequence_clip", {
    id: hexId(),
    sequenceId: text("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
    trackId: text("track_id").notNull().references(() => sequenceTracks.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    assetId: assetTable ? text("asset_id").references(() => assetTable.id, { onDelete: "set null" }) : text("asset_id"),
    generationId: generationTable ? text("generation_id").references(() => generationTable.id, { onDelete: "set null" }) : text("generation_id"),
    label: text("label").notNull(),
    startFrame: integer("start_frame").notNull().default(0),
    durationFrames: integer("duration_frames").notNull(),
    sourceInFrame: integer("source_in_frame").notNull().default(0),
    sourceOutFrame: integer("source_out_frame"),
    version: integer("version").notNull().default(1),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    text: text("text"),
    language: text("language"),
    metadata: jsonMetadata(),
    createdBy: text("created_by").notNull().references(() => userTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt()
  }, (table) => [
    index("idx_sequence_clip_sequence_start").on(table.sequenceId, table.startFrame),
    index("idx_sequence_clip_track_start").on(table.trackId, table.startFrame),
    index("idx_sequence_clip_generation").on(table.generationId),
    index("idx_sequence_clip_workspace").on(table.workspaceId)
  ]);
  const sequenceDecisions = sqliteTable("sequence_decision", {
    id: hexId(),
    sequenceId: text("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
    clipId: text("clip_id").references(() => sequenceClips.id, { onDelete: "set null" }),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["human_edit", "agent_proposal", "agent_edit", "export", "note"] }).notNull(),
    instruction: text("instruction").notNull(),
    reasoningSummary: text("reasoning_summary"),
    accepted: integer("accepted", { mode: "boolean" }),
    metadata: jsonMetadata(),
    createdBy: text("created_by").notNull().references(() => userTable.id),
    createdAt: createdAt()
  }, (table) => [
    index("idx_sequence_decision_sequence").on(table.sequenceId, table.createdAt),
    index("idx_sequence_decision_workspace").on(table.workspaceId)
  ]);
  const sequenceExports = sqliteTable("sequence_export", {
    id: hexId(),
    workspaceId: text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }),
    sequenceId: text("sequence_id").notNull().references(() => sequences.id, { onDelete: "cascade" }),
    format: text("format", { enum: ["mp4", "otio", "xml", "edl", "vtt", "srt", "contact_sheet"] }).notNull(),
    status: text("status", { enum: ["queued", "processing", "completed", "failed", "cancelled"] }).notNull().default("queued"),
    resultUrl: text("result_url"),
    metadata: jsonMetadata(),
    createdBy: text("created_by").notNull().references(() => userTable.id),
    createdAt: createdAt(),
    completedAt: integer("completed_at", { mode: "timestamp" })
  }, (table) => [
    index("idx_sequence_export_sequence").on(table.sequenceId, table.createdAt),
    index("idx_sequence_export_workspace_status").on(table.workspaceId, table.status)
  ]);
  return { sequences, sequenceTracks, sequenceClips, sequenceDecisions, sequenceExports };
}

// src/sequences/drizzle-store.ts
import { and, asc, desc, eq, sql as sql2 } from "drizzle-orm";
var DEFAULT_LIST_LIMIT = 50;
function createDrizzleSequenceStore(options) {
  const { db, tables, scope, resolveMedia } = options;
  const { sequences, sequenceTracks, sequenceClips, sequenceDecisions, sequenceExports } = tables;
  const sequenceScope = () => and(eq(sequences.id, scope.sequenceId), eq(sequences.workspaceId, scope.workspaceId));
  const trackScope = () => and(eq(sequenceTracks.sequenceId, scope.sequenceId), eq(sequenceTracks.workspaceId, scope.workspaceId));
  const clipScope = () => and(eq(sequenceClips.sequenceId, scope.sequenceId), eq(sequenceClips.workspaceId, scope.workspaceId));
  const decisionScope = () => and(eq(sequenceDecisions.sequenceId, scope.sequenceId), eq(sequenceDecisions.workspaceId, scope.workspaceId));
  const exportScope = () => and(eq(sequenceExports.sequenceId, scope.sequenceId), eq(sequenceExports.workspaceId, scope.workspaceId));
  async function requireSequenceRow() {
    const [row] = await db.select().from(sequences).where(sequenceScope()).limit(1);
    if (!row) throw new Error(`Sequence ${scope.sequenceId} not found in workspace ${scope.workspaceId}`);
    return row;
  }
  async function requireTrackRow(trackId) {
    const [row] = await db.select().from(sequenceTracks).where(and(trackScope(), eq(sequenceTracks.id, trackId))).limit(1);
    if (!row) throw new Error(`Track ${trackId} not found in sequence ${scope.sequenceId}`);
    return row;
  }
  async function requireClipRow(clipId) {
    const [row] = await db.select().from(sequenceClips).where(and(clipScope(), eq(sequenceClips.id, clipId))).limit(1);
    if (!row) throw new Error(`Clip ${clipId} not found in sequence ${scope.sequenceId}`);
    return row;
  }
  async function touchSequence() {
    await db.update(sequences).set({ updatedAt: /* @__PURE__ */ new Date() }).where(sequenceScope());
  }
  async function clipWithMedia(row) {
    const media = resolveMedia ? await resolveMedia([row]) : void 0;
    return mapClip(row, media?.get(row.id));
  }
  return {
    async getTimeline() {
      const sequenceRow = await requireSequenceRow();
      const [trackRows, clipRows] = await Promise.all([
        db.select().from(sequenceTracks).where(trackScope()).orderBy(asc(sequenceTracks.sortOrder), asc(sequenceTracks.createdAt)),
        db.select().from(sequenceClips).where(clipScope()).orderBy(asc(sequenceClips.startFrame), asc(sequenceClips.createdAt))
      ]);
      const media = resolveMedia ? await resolveMedia(clipRows) : void 0;
      return {
        sequence: mapSequence(sequenceRow),
        tracks: trackRows.map(mapTrack),
        clips: clipRows.map((row) => mapClip(row, media?.get(row.id)))
      };
    },
    async getClip(clipId) {
      return clipWithMedia(await requireClipRow(clipId));
    },
    async createTrack(input) {
      await requireSequenceRow();
      let sortOrder = input.sortOrder;
      if (sortOrder === void 0) {
        const [aggregate] = await db.select({ maxSortOrder: sql2`max(${sequenceTracks.sortOrder})` }).from(sequenceTracks).where(trackScope());
        sortOrder = (aggregate?.maxSortOrder ?? -1) + 1;
      }
      const [row] = await db.insert(sequenceTracks).values({
        sequenceId: scope.sequenceId,
        workspaceId: scope.workspaceId,
        kind: input.kind,
        name: input.name,
        sortOrder
      }).returning();
      if (!row) throw new Error("sequence_track insert returned no row");
      await touchSequence();
      return mapTrack(row);
    },
    async createClip(input) {
      assertFrame(input.startFrame, "startFrame");
      assertClipDuration(input.durationFrames);
      if (input.sourceInFrame !== void 0) assertFrame(input.sourceInFrame, "sourceInFrame");
      if (typeof input.sourceOutFrame === "number") assertFrame(input.sourceOutFrame, "sourceOutFrame");
      await requireTrackRow(input.trackId);
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
        createdBy: scope.userId
      }).returning();
      if (!row) throw new Error("sequence_clip insert returned no row");
      await touchSequence();
      return clipWithMedia(row);
    },
    async updateClip(clipId, patch) {
      await requireClipRow(clipId);
      if (patch.trackId !== void 0) await requireTrackRow(patch.trackId);
      if (patch.startFrame !== void 0) assertFrame(patch.startFrame, "startFrame");
      if (patch.durationFrames !== void 0) assertClipDuration(patch.durationFrames);
      if (patch.sourceInFrame !== void 0) assertFrame(patch.sourceInFrame, "sourceInFrame");
      if (typeof patch.sourceOutFrame === "number") assertFrame(patch.sourceOutFrame, "sourceOutFrame");
      const updates = {
        updatedAt: /* @__PURE__ */ new Date(),
        version: sql2`${sequenceClips.version} + 1`
      };
      if (patch.trackId !== void 0) updates.trackId = patch.trackId;
      if (patch.label !== void 0) updates.label = patch.label;
      if (patch.startFrame !== void 0) updates.startFrame = patch.startFrame;
      if (patch.durationFrames !== void 0) updates.durationFrames = patch.durationFrames;
      if (patch.sourceInFrame !== void 0) updates.sourceInFrame = patch.sourceInFrame;
      if (patch.sourceOutFrame !== void 0) updates.sourceOutFrame = patch.sourceOutFrame;
      if (patch.disabled !== void 0) updates.disabled = patch.disabled;
      if (patch.text !== void 0) updates.text = patch.text;
      if (patch.language !== void 0) updates.language = patch.language;
      if (patch.metadata !== void 0) updates.metadata = patch.metadata;
      const [row] = await db.update(sequenceClips).set(updates).where(and(clipScope(), eq(sequenceClips.id, clipId))).returning();
      if (!row) throw new Error(`Clip ${clipId} not found in sequence ${scope.sequenceId}`);
      await touchSequence();
      return clipWithMedia(row);
    },
    async deleteClip(clipId) {
      await requireClipRow(clipId);
      await db.delete(sequenceClips).where(and(clipScope(), eq(sequenceClips.id, clipId)));
      await touchSequence();
    },
    async updateSequenceDuration(durationFrames) {
      if (!Number.isInteger(durationFrames) || durationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
        throw new Error("durationFrames must be a positive integer");
      }
      await requireSequenceRow();
      const [aggregate] = await db.select({ maxEndFrame: sql2`max(${sequenceClips.startFrame} + ${sequenceClips.durationFrames})` }).from(sequenceClips).where(clipScope());
      const maxEndFrame = aggregate?.maxEndFrame ?? 0;
      if (durationFrames < maxEndFrame) {
        throw new Error(`Cannot set sequence duration to ${durationFrames} frames: the last clip ends at frame ${maxEndFrame}. Trim or delete clips first.`);
      }
      const [row] = await db.update(sequences).set({ durationFrames, updatedAt: /* @__PURE__ */ new Date() }).where(sequenceScope()).returning();
      if (!row) throw new Error(`Sequence ${scope.sequenceId} not found in workspace ${scope.workspaceId}`);
      return mapSequence(row);
    },
    async recordDecision(input) {
      await requireSequenceRow();
      if (typeof input.clipId === "string") await requireClipRow(input.clipId);
      const [row] = await db.insert(sequenceDecisions).values({
        sequenceId: scope.sequenceId,
        workspaceId: scope.workspaceId,
        clipId: input.clipId ?? null,
        kind: input.kind,
        instruction: input.instruction,
        reasoningSummary: input.reasoningSummary ?? null,
        accepted: input.accepted ?? null,
        metadata: input.metadata ?? {},
        createdBy: scope.userId
      }).returning();
      if (!row) throw new Error("sequence_decision insert returned no row");
      await touchSequence();
      return mapDecision(row);
    },
    async createExport(format, metadata) {
      await requireSequenceRow();
      const [row] = await db.insert(sequenceExports).values({
        sequenceId: scope.sequenceId,
        workspaceId: scope.workspaceId,
        format,
        metadata: metadata ?? {},
        createdBy: scope.userId
      }).returning();
      if (!row) throw new Error("sequence_export insert returned no row");
      await touchSequence();
      return mapExport(row);
    },
    async listDecisions(limit = DEFAULT_LIST_LIMIT) {
      assertListLimit(limit);
      const rows = await db.select().from(sequenceDecisions).where(decisionScope()).orderBy(desc(sequenceDecisions.createdAt), desc(sql2`rowid`)).limit(limit);
      return rows.map(mapDecision);
    },
    async listExports(limit = DEFAULT_LIST_LIMIT) {
      assertListLimit(limit);
      const rows = await db.select().from(sequenceExports).where(exportScope()).orderBy(desc(sequenceExports.createdAt), desc(sql2`rowid`)).limit(limit);
      return rows.map(mapExport);
    }
  };
}
function mapSequence(row) {
  return {
    id: row.id,
    title: row.title,
    fps: row.fps,
    width: row.width,
    height: row.height,
    aspectRatio: row.aspectRatio,
    durationFrames: row.durationFrames,
    status: row.status,
    metadata: row.metadata ?? {}
  };
}
function mapTrack(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    sortOrder: row.sortOrder,
    locked: row.locked,
    muted: row.muted,
    metadata: row.metadata ?? {}
  };
}
function mapClip(row, media) {
  return {
    id: row.id,
    trackId: row.trackId,
    label: row.label,
    startFrame: row.startFrame,
    durationFrames: row.durationFrames,
    sourceInFrame: row.sourceInFrame,
    sourceOutFrame: row.sourceOutFrame,
    disabled: row.disabled,
    text: row.text ?? void 0,
    language: row.language ?? void 0,
    generationId: row.generationId ?? void 0,
    assetId: row.assetId ?? void 0,
    media,
    metadata: row.metadata ?? {}
  };
}
function mapDecision(row) {
  return {
    id: row.id,
    clipId: row.clipId,
    kind: row.kind,
    instruction: row.instruction,
    reasoningSummary: row.reasoningSummary,
    accepted: row.accepted,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt
  };
}
function mapExport(row) {
  return {
    id: row.id,
    format: row.format,
    status: row.status,
    resultUrl: row.resultUrl,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt
  };
}
function assertFrame(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}
function assertClipDuration(durationFrames) {
  if (!Number.isInteger(durationFrames) || durationFrames < MIN_SEQUENCE_CLIP_FRAMES) {
    throw new Error("durationFrames must be a positive integer");
  }
}
function assertListLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
}
export {
  createDrizzleSequenceStore,
  createSequenceTables
};
//# sourceMappingURL=drizzle.js.map