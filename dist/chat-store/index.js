import {
  runSqliteStatements
} from "../chunk-Q4ZER4HI.js";
import {
  DEFAULT_ATTACHMENT_PROMPT_HEADER,
  attachmentInputToPart,
  attachmentKindForMime,
  attachmentPartsFromMessageParts,
  buildAttachmentPromptBlock,
  historyContentWithAttachments,
  isChatAttachmentPart,
  isChatInteractionPart,
  isChatMentionPart,
  isChatPlanPart,
  isChatStepFinishPart,
  isChatTextPart,
  isChatToolPart,
  isChatWorkProductPart,
  mentionInputToPart,
  mentionPartsFromMessageParts,
  toChatMessageParts
} from "../chunk-4PZE7XAM.js";
import "../chunk-ZVEEWGDK.js";
import "../chunk-X47R2IVO.js";
import "../chunk-TXD5HXLE.js";
import {
  attachmentPartKey
} from "../chunk-ZMMIQOFI.js";
import "../chunk-M3K2HVQD.js";
import "../chunk-YJMCRXQQ.js";

// src/chat-store/core.ts
var BULK_DELETE_MAX_THREADS = 200;
var ChatStoreInputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ChatStoreInputError";
  }
};
function threadTitleFromMessage(message) {
  const firstLine = message.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!firstLine) return "New Thread";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}\u2026` : firstLine;
}

// src/chat-store/schema.ts
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
var hexId = () => text("id").primaryKey().default(sql`(lower(hex(randomblob(16))))`);
var createdAt = () => integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
var updatedAt = () => integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
function createChatTables(options = {}) {
  const { workspaceTable, tablePrefix = "" } = options;
  const threadExtras = options.threadExtraColumns ?? {};
  const messageExtras = options.messageExtraColumns ?? {};
  const extraIndexes = (build, table) => build?.(table) ?? [];
  const threads = sqliteTable(`${tablePrefix}thread`, {
    id: hexId(),
    workspaceId: workspaceTable ? text("workspace_id").notNull().references(() => workspaceTable.id, { onDelete: "cascade" }) : text("workspace_id").notNull(),
    title: text("title").notNull(),
    category: text("category"),
    isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...threadExtras
  }, (table) => [
    index(`idx_${tablePrefix}thread_workspace`).on(table.workspaceId),
    // Supports the store's list ordering (updatedAt desc within a workspace).
    index(`idx_${tablePrefix}thread_workspace_updated`).on(table.workspaceId, table.updatedAt),
    ...extraIndexes(options.threadExtraIndexes, table)
  ]);
  const messages = sqliteTable(`${tablePrefix}message`, {
    id: hexId(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
    content: text("content").notNull(),
    parts: text("parts", { mode: "json" }).$type().default([]),
    toolName: text("tool_name"),
    model: text("model"),
    requestedModel: text("requested_model"),
    servedModel: text("served_model"),
    servedProvider: text("served_provider"),
    servedSource: text("served_model_source"),
    // Usage receipt, flattened from the harness's `step-finish` shape
    // (`tokens {input, output, reasoning, cache{read, write}}` + `cost`).
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: real("cost_usd"),
    createdAt: createdAt(),
    ...messageExtras
  }, (table) => [
    index(`idx_${tablePrefix}message_thread`).on(table.threadId),
    index(`idx_${tablePrefix}message_thread_created`).on(table.threadId, table.createdAt),
    ...extraIndexes(options.messageExtraIndexes, table)
  ]);
  return { threads, messages };
}

// src/chat-store/store.ts
import { and, asc, desc, eq, gte, inArray, lt, sql as sql2 } from "drizzle-orm";
function clampLimit(limit, fallback, max) {
  const value = Number.isFinite(limit) ? Math.trunc(limit) : fallback;
  return Math.min(Math.max(value, 1), max);
}
function clampOffset(offset) {
  const value = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  return Math.max(value, 0);
}
function createChatStore(db, tables) {
  const threads = tables.threads;
  const messages = tables.messages;
  return {
    async listThreads(input) {
      const limit = clampLimit(input.limit, 50, 200);
      const offset = clampOffset(input.offset);
      const scope = eq(threads.workspaceId, input.workspaceId);
      const [list, [countRow]] = await Promise.all([
        db.select().from(threads).where(scope).orderBy(desc(threads.updatedAt), asc(threads.id)).limit(limit).offset(offset),
        db.select({ total: sql2`count(*)` }).from(threads).where(scope)
      ]);
      return { threads: list, total: countRow?.total ?? 0, limit, offset };
    },
    async getThread(threadId) {
      const [row] = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
      return row ?? null;
    },
    async createThread(input) {
      const title = threadTitleFromMessage(input.title ?? input.firstMessage ?? "");
      const values = {
        ...input.id !== void 0 ? { id: input.id } : {},
        workspaceId: input.workspaceId,
        title,
        ...input.category !== void 0 ? { category: input.category } : {},
        ...input.isPinned !== void 0 ? { isPinned: input.isPinned } : {},
        ...input.extras ?? {}
      };
      const [row] = await db.insert(threads).values(values).returning();
      if (!row) throw new Error("thread insert returned no row");
      return row;
    },
    async renameThread(threadId, title) {
      const trimmed = title.trim();
      if (!trimmed) throw new ChatStoreInputError("Missing title");
      const [row] = await db.update(threads).set({ title: trimmed, updatedAt: /* @__PURE__ */ new Date() }).where(eq(threads.id, threadId)).returning();
      return row ?? null;
    },
    async pinThread(threadId, isPinned) {
      const [row] = await db.update(threads).set({ isPinned, updatedAt: /* @__PURE__ */ new Date() }).where(eq(threads.id, threadId)).returning();
      return row ?? null;
    },
    async deleteThread(threadId, options) {
      const [existing] = await db.select({ id: threads.id, workspaceId: threads.workspaceId }).from(threads).where(eq(threads.id, threadId)).limit(1);
      if (!existing) return false;
      if (options?.assertAccess) await options.assertAccess(existing.workspaceId);
      await runSqliteStatements(db, [
        db.delete(messages).where(eq(messages.threadId, threadId)),
        db.delete(threads).where(eq(threads.id, threadId))
      ]);
      return true;
    },
    async bulkDeleteThreads(input) {
      const { ids, workspaceId, assertAccess } = input;
      if (typeof assertAccess !== "function") throw new ChatStoreInputError("Missing assertAccess");
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) {
        throw new ChatStoreInputError("Missing ids");
      }
      if (ids.length > BULK_DELETE_MAX_THREADS) {
        throw new ChatStoreInputError(`Too many ids (max ${BULK_DELETE_MAX_THREADS})`);
      }
      if (workspaceId !== void 0 && !workspaceId.trim()) {
        throw new ChatStoreInputError("Invalid workspaceId");
      }
      const scope = workspaceId ? and(inArray(threads.id, ids), eq(threads.workspaceId, workspaceId)) : inArray(threads.id, ids);
      const rows = await db.select({ id: threads.id, workspaceId: threads.workspaceId }).from(threads).where(scope);
      if (rows.length === 0) return { deleted: 0 };
      const workspaceIds = [...new Set(rows.map((row) => row.workspaceId))].sort();
      for (const workspaceId2 of workspaceIds) {
        await assertAccess(workspaceId2);
      }
      const foundIds = rows.map((row) => row.id);
      await runSqliteStatements(db, [
        db.delete(messages).where(inArray(messages.threadId, foundIds)),
        db.delete(threads).where(inArray(threads.id, foundIds))
      ]);
      return { deleted: foundIds.length };
    },
    async bulkDeleteThreadsByUpdatedAt(input) {
      const { workspaceId, updatedBefore, updatedAfter, where, assertAccess } = input;
      if (typeof assertAccess !== "function") throw new ChatStoreInputError("Missing assertAccess");
      if (!workspaceId.trim()) throw new ChatStoreInputError("Missing workspaceId");
      if (updatedBefore === void 0 && updatedAfter === void 0) {
        throw new ChatStoreInputError("Missing updatedAt boundary");
      }
      for (const boundary of [updatedBefore, updatedAfter]) {
        if (boundary !== void 0 && Number.isNaN(boundary.getTime())) {
          throw new ChatStoreInputError("Invalid updatedAt boundary");
        }
      }
      const conditions = [eq(threads.workspaceId, workspaceId)];
      if (updatedBefore) conditions.push(lt(threads.updatedAt, updatedBefore));
      if (updatedAfter) conditions.push(gte(threads.updatedAt, updatedAfter));
      if (where) conditions.push(where);
      const scope = and(...conditions);
      const [countRow] = await db.select({ total: sql2`count(*)` }).from(threads).where(scope);
      const deleted = Number(countRow?.total ?? 0);
      if (deleted === 0) return { deleted: 0 };
      await assertAccess(workspaceId);
      const matchingThreads = db.select({ id: threads.id }).from(threads).where(scope);
      await runSqliteStatements(db, [
        db.delete(messages).where(inArray(messages.threadId, matchingThreads)),
        db.delete(threads).where(scope)
      ]);
      return { deleted };
    },
    async listMessages(threadId, options) {
      const query = db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.createdAt), sql2`rowid`).$dynamic();
      if (options?.limit !== void 0) query.limit(clampLimit(options.limit, 1, 1e3));
      if (options?.offset !== void 0) query.offset(clampOffset(options.offset));
      return await query;
    },
    async appendMessage(input) {
      const values = {
        ...input.id !== void 0 ? { id: input.id } : {},
        threadId: input.threadId,
        role: input.role,
        content: input.content,
        ...input.parts !== void 0 ? { parts: input.parts } : {},
        ...input.toolName !== void 0 ? { toolName: input.toolName } : {},
        ...input.model !== void 0 ? { model: input.model } : {},
        ...input.requestedModel !== void 0 ? { requestedModel: input.requestedModel } : {},
        ...input.servedModel !== void 0 ? { servedModel: input.servedModel } : {},
        ...input.servedProvider !== void 0 ? { servedProvider: input.servedProvider } : {},
        ...input.servedSource !== void 0 ? { servedSource: input.servedSource } : {},
        ...input.inputTokens !== void 0 ? { inputTokens: input.inputTokens } : {},
        ...input.outputTokens !== void 0 ? { outputTokens: input.outputTokens } : {},
        ...input.reasoningTokens !== void 0 ? { reasoningTokens: input.reasoningTokens } : {},
        ...input.cacheReadTokens !== void 0 ? { cacheReadTokens: input.cacheReadTokens } : {},
        ...input.cacheWriteTokens !== void 0 ? { cacheWriteTokens: input.cacheWriteTokens } : {},
        ...input.costUsd !== void 0 ? { costUsd: input.costUsd } : {},
        ...input.extras ?? {}
      };
      const [insertResult] = await runSqliteStatements(db, [
        db.insert(messages).values(values).returning(),
        db.update(threads).set({ updatedAt: /* @__PURE__ */ new Date() }).where(eq(threads.id, input.threadId))
      ]);
      const row = insertResult?.[0];
      if (!row) throw new Error("message insert returned no row");
      return row;
    },
    async updateMessage(id, patch) {
      const values = {
        ...patch.content !== void 0 ? { content: patch.content } : {},
        ...patch.parts !== void 0 ? { parts: patch.parts } : {},
        ...patch.toolName !== void 0 ? { toolName: patch.toolName } : {},
        ...patch.model !== void 0 ? { model: patch.model } : {},
        ...patch.requestedModel !== void 0 ? { requestedModel: patch.requestedModel } : {},
        ...patch.servedModel !== void 0 ? { servedModel: patch.servedModel } : {},
        ...patch.servedProvider !== void 0 ? { servedProvider: patch.servedProvider } : {},
        ...patch.servedSource !== void 0 ? { servedSource: patch.servedSource } : {},
        ...patch.inputTokens !== void 0 ? { inputTokens: patch.inputTokens } : {},
        ...patch.outputTokens !== void 0 ? { outputTokens: patch.outputTokens } : {},
        ...patch.reasoningTokens !== void 0 ? { reasoningTokens: patch.reasoningTokens } : {},
        ...patch.cacheReadTokens !== void 0 ? { cacheReadTokens: patch.cacheReadTokens } : {},
        ...patch.cacheWriteTokens !== void 0 ? { cacheWriteTokens: patch.cacheWriteTokens } : {},
        ...patch.costUsd !== void 0 ? { costUsd: patch.costUsd } : {},
        ...patch.extras ?? {}
      };
      if (Object.keys(values).length === 0) {
        const [current] = await db.select().from(messages).where(eq(messages.id, id));
        return current ?? null;
      }
      const [updateResult] = await runSqliteStatements(db, [
        db.update(messages).set(values).where(eq(messages.id, id)).returning(),
        db.update(threads).set({ updatedAt: /* @__PURE__ */ new Date() }).where(eq(threads.id, sql2`(select ${messages.threadId} from ${messages} where ${messages.id} = ${id})`))
      ]);
      return updateResult?.[0] ?? null;
    },
    async deleteMessage(id) {
      const deleted = await db.delete(messages).where(eq(messages.id, id)).returning();
      return deleted.length > 0;
    }
  };
}
export {
  BULK_DELETE_MAX_THREADS,
  ChatStoreInputError,
  DEFAULT_ATTACHMENT_PROMPT_HEADER,
  attachmentInputToPart,
  attachmentKindForMime,
  attachmentPartKey,
  attachmentPartsFromMessageParts,
  buildAttachmentPromptBlock,
  createChatStore,
  createChatTables,
  historyContentWithAttachments,
  isChatAttachmentPart,
  isChatInteractionPart,
  isChatMentionPart,
  isChatPlanPart,
  isChatStepFinishPart,
  isChatTextPart,
  isChatToolPart,
  isChatWorkProductPart,
  mentionInputToPart,
  mentionPartsFromMessageParts,
  threadTitleFromMessage,
  toChatMessageParts
};
//# sourceMappingURL=index.js.map