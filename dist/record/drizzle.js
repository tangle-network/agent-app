import {
  RECORD_KEY_SENTINEL,
  RECORD_PERIOD_SENTINEL,
  canonicalRecordJson,
  defaultRecordPeriodScope,
  detectRecordConflict,
  foldRecordEntries,
  recordEntryVisibleInPeriod,
  recordFail,
  recordOk,
  recordUlid,
  resolveWriteReviewState,
  validateRecordValue
} from "../chunk-I24YIKHO.js";

// src/record/drizzle/schema.ts
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
var RECORD_STORE_COLUMNS = /* @__PURE__ */ new Set([
  "id",
  "scopeId",
  "seq",
  "dimension",
  "period",
  "path",
  "itemKey",
  "valueJson",
  "affirmedEmpty",
  "reviewState",
  "conflict",
  "supersededById",
  "sourceKind",
  "sourceRef",
  "sourceLocator",
  "sourceQuote",
  "confidence",
  "reviewedAt",
  "reviewedBy",
  "createdAt"
]);
function buildRecordEntryTable(options) {
  const { tableName, scopeTable, sourceTable, reviewerTable } = options;
  const prefix = options.indexPrefix ?? tableName;
  const extraColumns = options.extraColumns ?? {};
  const collisions = Object.keys(extraColumns).filter((name) => RECORD_STORE_COLUMNS.has(name));
  if (collisions.length > 0) {
    throw new Error(
      `createRecordTable('${tableName}'): extraColumns may not redefine the store's own columns \u2014 ${collisions.sort().join(", ")}`
    );
  }
  const columns = {
    /** ULID minted by the store — an atomic supersede needs the replacement
     *  id before the insert, so this has no column default. */
    id: text("id").primaryKey(),
    scopeId: text("scope_id").notNull().references(() => scopeTable.id, { onDelete: "cascade" }),
    /** Per-scope monotonic write counter, assigned inside the insert
     *  statement. The fold's only ordering key. */
    seq: integer("seq").notNull(),
    /** Consumer-defined partition inside the scope; `''` when unused. */
    dimension: text("dimension").notNull().default(""),
    /** The period the assertion became true in; `0` when the consumer has no
     *  time dimension. */
    period: integer("period").notNull().default(0),
    /** The field this entry asserts. Validated against the consumer's schema
     *  map on every write. */
    path: text("path").notNull(),
    /** Which element of a collection the path belongs to; `''` when not
     *  applicable. */
    itemKey: text("item_key").notNull().default(""),
    /** Canonical JSON (sorted keys) of the validated value. */
    valueJson: text("value_json").notNull(),
    /** "There are none of these" — written against an affirmable path with
     *  `item_key = ''` and `value_json = 'null'`. */
    affirmedEmpty: integer("affirmed_empty", { mode: "boolean" }).notNull().default(false),
    reviewState: text("review_state").$type().notNull(),
    /** Set when this entry disagreed with a live head from a different source
     *  kind at write time — surfaced for a human to resolve. */
    conflict: integer("conflict", { mode: "boolean" }).notNull().default(false),
    /** Audit link to the accepted entry that replaced this one; NULL marks a
     *  live head. */
    supersededById: text("superseded_by_id"),
    /** Stamped by the server call site, never accepted from model output. */
    sourceKind: text("source_kind").notNull(),
    sourceRef: sourceTable ? text("source_ref").references(() => sourceTable.id, { onDelete: "set null" }) : text("source_ref"),
    /** JSON position inside the source. */
    sourceLocator: text("source_locator", { mode: "json" }).$type(),
    sourceQuote: text("source_quote"),
    confidence: real("confidence"),
    /** Epoch milliseconds. */
    reviewedAt: integer("reviewed_at"),
    reviewedBy: reviewerTable ? text("reviewed_by").references(() => reviewerTable.id, { onDelete: "set null" }) : text("reviewed_by"),
    /** Epoch milliseconds. Display only — `seq` orders the fold. */
    createdAt: integer("created_at").notNull().$defaultFn(() => Date.now())
  };
  const widened = columns;
  for (const [name, column] of Object.entries(extraColumns)) widened[name] = column;
  return sqliteTable(
    tableName,
    columns,
    (table) => [
      uniqueIndex(`${prefix}_scope_seq_uidx`).on(table.scopeId, table.seq),
      uniqueIndex(`${prefix}_live_head_uidx`).on(table.scopeId, table.dimension, table.path, table.itemKey, table.period).where(sql`review_state = 'accepted' AND superseded_by_id IS NULL`),
      index(`${prefix}_scope_period_idx`).on(table.scopeId, table.period),
      index(`${prefix}_scope_review_idx`).on(table.scopeId, table.reviewState),
      index(`${prefix}_scope_path_idx`).on(table.scopeId, table.path)
    ]
  );
}
function createRecordTable(options) {
  return buildRecordEntryTable(options);
}

// src/record/drizzle/store.ts
import { and, asc, eq, getTableColumns, getTableName, isNull, lte, sql as sql2 } from "drizzle-orm";
var DEFAULT_WRITE_ATTEMPTS = 3;
function createRecordStore(options) {
  const { db, table, policy } = options;
  const tableName = getTableName(table);
  const newId = options.newId ?? (() => recordUlid());
  const now = options.now ?? (() => Date.now());
  const attempts = options.maxWriteAttempts ?? DEFAULT_WRITE_ATTEMPTS;
  const storePeriodScope = options.periodScope ?? defaultRecordPeriodScope;
  const strategy = resolveAtomicStrategy(db);
  const affirmable = new Set(policy.affirmablePaths ?? []);
  const requireRef = new Set(policy.requireSourceRef ?? []);
  const requireQuote = new Set(policy.requireSourceQuote ?? []);
  const extraColumnNames = new Set(
    Object.keys(getTableColumns(table)).filter((name) => !RECORD_STORE_COLUMNS.has(name))
  );
  function liveHeadWhere(scopeId, key) {
    return and(
      eq(table.scopeId, scopeId),
      eq(table.dimension, key.dimension),
      eq(table.path, key.path),
      eq(table.itemKey, key.itemKey),
      eq(table.period, key.period),
      eq(table.reviewState, "accepted"),
      isNull(table.supersededById)
    );
  }
  async function loadLiveHead(scopeId, key) {
    const rows = await db.select().from(table).where(liveHeadWhere(scopeId, key)).limit(1);
    return rows[0];
  }
  function markHeadStatement(headId, replacementId, requireProposedId) {
    const guards = [eq(table.id, headId), eq(table.reviewState, "accepted"), isNull(table.supersededById)];
    if (requireProposedId !== void 0) {
      guards.push(
        sql2`EXISTS (SELECT 1 FROM ${sql2.identifier(tableName)} WHERE id = ${requireProposedId} AND review_state = 'proposed')`
      );
    }
    return db.update(table).set({ supersededById: replacementId }).where(and(...guards)).returning({ id: table.id });
  }
  async function loadEntry(scopeId, entryId) {
    const rows = await db.select().from(table).where(and(eq(table.id, entryId), eq(table.scopeId, scopeId))).limit(1);
    return rows[0];
  }
  async function write(input) {
    const validated = validateWrite(input);
    if (!validated.succeeded) return validated;
    const draft = validated.value;
    let lastError = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const head = await loadLiveHead(input.scopeId, draft.key);
        const conflict = detectRecordConflict(policy, head, draft);
        const reviewState = conflict ? "proposed" : draft.reviewState;
        const id = newId();
        const values = insertValues(input, draft, id, reviewState, conflict);
        if (reviewState === "accepted" && head !== void 0) {
          const paired = await runGuardedPair(
            db,
            strategy,
            markHeadStatement(head.id, id),
            db.insert(table).values(values).returning()
          );
          if (!paired.guardMatched) {
            if (paired.rolledBack) {
              lastError = `write: lost the head race on '${draft.key.path}' (head ${head.id} changed underneath)`;
              continue;
            }
            return recordFail(
              "supersede-race",
              `write: head ${head.id} on '${draft.key.path}' was not markable but the write committed \u2014 the live-head index is not enforcing`
            );
          }
          const row2 = firstRow(paired.mainRows);
          if (!row2) return recordFail("storage-failed", "write: insert returned no row");
          return recordOk({ entry: row2, conflict: false, supersededEntryId: head.id });
        }
        const inserted = await db.insert(table).values(values).returning();
        const row = firstRow(inserted);
        if (!row) return recordFail("storage-failed", "write: insert returned no row");
        return recordOk({ entry: row, conflict, supersededEntryId: null });
      } catch (error) {
        if (isUniqueViolation(error)) {
          lastError = `write: concurrent head write on '${draft.key.path}' \u2014 ${errorMessage(error)}`;
          continue;
        }
        return recordFail("storage-failed", `write: ${errorMessage(error)}`);
      }
    }
    return recordFail("supersede-race", `${lastError} (gave up after ${attempts} attempts)`);
  }
  async function review(input) {
    let existing;
    try {
      const rows = await db.select().from(table).where(and(eq(table.id, input.entryId), eq(table.scopeId, input.scopeId))).limit(1);
      existing = rows[0];
    } catch (error) {
      return recordFail("storage-failed", `review: ${errorMessage(error)}`);
    }
    if (!existing) {
      return recordFail("not-found", `review: entry '${input.entryId}' not found in scope '${input.scopeId}'`);
    }
    if (existing.reviewState !== "proposed") {
      return recordFail(
        "not-reviewable",
        `review: entry '${input.entryId}' is '${existing.reviewState}' \u2014 only proposed entries are reviewable`
      );
    }
    const reviewedAt = now();
    const reviewedBy = input.reviewedBy ?? null;
    if (input.action === "reject") {
      try {
        const updated = await db.update(table).set({ reviewState: "rejected", reviewedAt, reviewedBy }).where(and(eq(table.id, existing.id), eq(table.reviewState, "proposed"))).returning();
        const row = firstRow(updated);
        if (!row) {
          return recordFail("not-reviewable", `review: entry '${input.entryId}' was reviewed concurrently`);
        }
        return recordOk(row);
      } catch (error) {
        return recordFail("storage-failed", `review: ${errorMessage(error)}`);
      }
    }
    const key = {
      dimension: existing.dimension,
      path: existing.path,
      itemKey: existing.itemKey,
      period: existing.period
    };
    let lastError = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const head = await loadLiveHead(input.scopeId, key);
        const acceptStatement = db.update(table).set({ reviewState: "accepted", conflict: false, reviewedAt, reviewedBy }).where(and(eq(table.id, existing.id), eq(table.reviewState, "proposed"))).returning();
        if (head !== void 0) {
          const paired = await runGuardedPair(
            db,
            strategy,
            markHeadStatement(head.id, existing.id, existing.id),
            acceptStatement
          );
          if (!paired.guardMatched && paired.mainMatched) {
            return recordFail(
              "supersede-race",
              `review: head ${head.id} was not markable but the accept committed \u2014 the live-head index is not enforcing`
            );
          }
          if (paired.guardMatched && !paired.mainMatched && !paired.rolledBack) {
            return recordFail(
              "supersede-race",
              `review: head ${head.id} was marked superseded by '${input.entryId}' but the accept matched no row \u2014 the batch is not atomic`
            );
          }
          if (!paired.guardMatched || !paired.mainMatched) {
            const current = await loadEntry(input.scopeId, existing.id);
            if (current === void 0 || current.reviewState !== "proposed") {
              return recordFail("not-reviewable", `review: entry '${input.entryId}' was reviewed concurrently`);
            }
            lastError = `review: lost the head race accepting '${input.entryId}' (head ${head.id} changed underneath)`;
            continue;
          }
          const row2 = firstRow(paired.mainRows);
          if (!row2) return recordFail("not-reviewable", `review: entry '${input.entryId}' was reviewed concurrently`);
          return recordOk(row2);
        }
        const accepted = await acceptStatement;
        const row = firstRow(accepted);
        if (!row) return recordFail("not-reviewable", `review: entry '${input.entryId}' was reviewed concurrently`);
        return recordOk(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          lastError = `review: concurrent head write accepting '${input.entryId}' \u2014 ${errorMessage(error)}`;
          continue;
        }
        return recordFail("storage-failed", `review: ${errorMessage(error)}`);
      }
    }
    return recordFail("supersede-race", `${lastError} (gave up after ${attempts} attempts)`);
  }
  async function list(input) {
    if (input.period !== void 0 && !Number.isInteger(input.period)) {
      return recordFail("invalid-input", `list: period must be an integer, got ${String(input.period)}`);
    }
    try {
      const where = input.period === void 0 ? eq(table.scopeId, input.scopeId) : and(eq(table.scopeId, input.scopeId), lte(table.period, input.period));
      const rows = await db.select().from(table).where(where).orderBy(asc(table.seq));
      const visible = rows.filter((row) => {
        if (input.period !== void 0 && !recordEntryVisibleInPeriod(storePeriodScope(row.path), row.period, input.period)) return false;
        if (input.reviewState !== void 0) {
          if (row.reviewState !== input.reviewState) return false;
        } else if (!input.includeRejected && row.reviewState === "rejected") {
          return false;
        }
        if (!input.includeSuperseded && row.supersededById !== null) return false;
        return true;
      });
      return recordOk(visible);
    } catch (error) {
      return recordFail("storage-failed", `list: ${errorMessage(error)}`);
    }
  }
  async function loadHeads(scopeId, period) {
    return db.select().from(table).where(and(
      eq(table.scopeId, scopeId),
      eq(table.reviewState, "accepted"),
      isNull(table.supersededById),
      lte(table.period, period)
    )).orderBy(asc(table.seq));
  }
  async function heads(input) {
    const period = input.period ?? RECORD_PERIOD_SENTINEL;
    if (!Number.isInteger(period)) {
      return recordFail("invalid-input", `heads: period must be an integer, got ${String(period)}`);
    }
    try {
      const rows = await loadHeads(input.scopeId, period);
      return recordOk(rows.filter((row) => recordEntryVisibleInPeriod(storePeriodScope(row.path), row.period, period)));
    } catch (error) {
      return recordFail("storage-failed", `heads: ${errorMessage(error)}`);
    }
  }
  async function materialize(input) {
    const period = input.period ?? RECORD_PERIOD_SENTINEL;
    if (!Number.isInteger(period)) {
      return recordFail("invalid-input", `materialize: period must be an integer, got ${String(period)}`);
    }
    let loaded;
    try {
      loaded = await loadHeads(input.scopeId, period);
    } catch (error) {
      return recordFail("storage-failed", `materialize: ${errorMessage(error)}`);
    }
    const rules = input.rules.periodScope ? input.rules : { ...input.rules, periodScope: storePeriodScope };
    const folded = foldRecordEntries(loaded.map(toFoldable), { rules, period });
    if (!folded.succeeded) return folded;
    const periodScope = rules.periodScope ?? storePeriodScope;
    try {
      const proposed = await db.select({ path: table.path, period: table.period, conflict: table.conflict }).from(table).where(and(
        eq(table.scopeId, input.scopeId),
        eq(table.reviewState, "proposed"),
        lte(table.period, period)
      ));
      const visible = proposed.filter((row) => recordEntryVisibleInPeriod(periodScope(row.path), row.period, period));
      return recordOk({
        value: folded.value.value,
        entryCount: folded.value.entryCount,
        pendingProposed: visible.length,
        conflicts: visible.filter((row) => row.conflict).length
      });
    } catch (error) {
      return recordFail("storage-failed", `materialize: ${errorMessage(error)}`);
    }
  }
  function validateWrite(input) {
    const period = input.period ?? RECORD_PERIOD_SENTINEL;
    const minPeriod = policy.minPeriod ?? RECORD_PERIOD_SENTINEL;
    const maxPeriod = policy.maxPeriod ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(period) || period < minPeriod || period > maxPeriod) {
      return recordFail(
        "invalid-input",
        `write: period must be an integer in [${minPeriod}, ${maxPeriod}], got ${String(period)}`
      );
    }
    if (requireRef.has(input.sourceKind) && !input.sourceRef) {
      return recordFail("invalid-input", `write: source kind '${input.sourceKind}' requires a sourceRef ('${input.path}')`);
    }
    if (requireQuote.has(input.sourceKind) && !input.sourceQuote) {
      return recordFail("invalid-input", `write: source kind '${input.sourceKind}' requires a sourceQuote ('${input.path}')`);
    }
    const extras = input.extras ?? {};
    for (const key of Object.keys(extras)) {
      if (!extraColumnNames.has(key)) {
        return recordFail(
          "invalid-input",
          `write: extras key '${key}' has no column on '${tableName}' \u2014 declare it in createRecordTable's extraColumns`
        );
      }
    }
    for (const key of policy.requireExtras?.[input.sourceKind] ?? []) {
      const held = extras[key];
      if (held === void 0 || held === null || held === "") {
        return recordFail(
          "invalid-input",
          `write: source kind '${input.sourceKind}' requires extras.${key} ('${input.path}')`
        );
      }
    }
    if (input.confidence !== void 0 && input.confidence !== null && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      return recordFail("invalid-input", `write: confidence must be in [0, 1], got ${String(input.confidence)}`);
    }
    const state = resolveWriteReviewState(policy, input.sourceKind);
    if (!state.succeeded) return state;
    const dimension = canonicalize(policy.canonicalizeDimension, input.path, input.dimension ?? RECORD_KEY_SENTINEL, "dimension");
    if (!dimension.succeeded) return dimension;
    if (input.affirmedEmpty === true) {
      if (input.value !== void 0) {
        return recordFail("invalid-input", `write: an affirmedEmpty entry must not carry a value ('${input.path}')`);
      }
      if (!affirmable.has(input.path)) {
        return recordFail(
          "unknown-path",
          `write: '${input.path}' is not an affirmable path \u2014 affirmedEmpty targets a path declared in policy.affirmablePaths`
        );
      }
      if ((input.itemKey ?? RECORD_KEY_SENTINEL) !== RECORD_KEY_SENTINEL) {
        return recordFail(
          "invalid-input",
          `write: an affirmedEmpty entry uses the itemKey sentinel \u2014 it asserts that a whole path is empty ('${input.path}')`
        );
      }
      return recordOk({
        key: { dimension: dimension.value, path: input.path, itemKey: RECORD_KEY_SENTINEL, period },
        valueJson: "null",
        affirmedEmpty: true,
        reviewState: state.value,
        sourceKind: input.sourceKind
      });
    }
    const validator = policy.schemas[input.path];
    if (validator === void 0) {
      return recordFail("unknown-path", `write: unknown path '${input.path}' \u2014 not a key of the policy's schema map`);
    }
    if (input.value === void 0) {
      return recordFail("invalid-input", `write: a value is required unless affirmedEmpty is true ('${input.path}')`);
    }
    const parsed = validateRecordValue(validator, input.value);
    if (!parsed.succeeded) {
      return recordFail("invalid-value", `write: value for '${input.path}' failed validation \u2014 ${parsed.error}`);
    }
    const itemKey = canonicalize(policy.canonicalizeItemKey, input.path, input.itemKey ?? RECORD_KEY_SENTINEL, "itemKey");
    if (!itemKey.succeeded) return itemKey;
    return recordOk({
      key: { dimension: dimension.value, path: input.path, itemKey: itemKey.value, period },
      valueJson: canonicalRecordJson(parsed.value),
      affirmedEmpty: false,
      reviewState: state.value,
      sourceKind: input.sourceKind
    });
  }
  function insertValues(input, draft, id, reviewState, conflict) {
    return {
      // First, so a product column can never shadow a store-owned one even if
      // the guards above were bypassed.
      ...input.extras ?? {},
      id,
      scopeId: input.scopeId,
      // Assigned inside the statement: SQLite executes one statement
      // atomically, so MAX + 1 cannot race, and `(scope_id, seq)` unique
      // backstops it.
      seq: sql2`(SELECT COALESCE(MAX(seq), 0) + 1 FROM ${sql2.identifier(tableName)} WHERE scope_id = ${input.scopeId})`,
      dimension: draft.key.dimension,
      period: draft.key.period,
      path: draft.key.path,
      itemKey: draft.key.itemKey,
      valueJson: draft.valueJson,
      affirmedEmpty: draft.affirmedEmpty,
      reviewState,
      conflict,
      supersededById: null,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef ?? null,
      sourceLocator: input.sourceLocator ?? null,
      sourceQuote: input.sourceQuote ?? null,
      confidence: input.confidence ?? null,
      // A write that lands accepted by policy was not REVIEWED — nobody looked
      // at it. `createdAt` records when it landed; these two stay null until an
      // actual accept/reject.
      reviewedAt: null,
      reviewedBy: null
    };
  }
  return { atomicStrategy: strategy, write, review, list, heads, materialize };
}
function toFoldable(row) {
  return {
    id: row.id,
    seq: row.seq,
    dimension: row.dimension,
    period: row.period,
    path: row.path,
    itemKey: row.itemKey,
    valueJson: row.valueJson,
    affirmedEmpty: row.affirmedEmpty
  };
}
function canonicalize(canonicalizer, path, raw, column) {
  if (!canonicalizer) return recordOk(raw);
  const result = canonicalizer(path, raw);
  if (!result.succeeded) return recordFail("invalid-input", `write: '${path}' ${column} \u2014 ${result.error}`);
  return result;
}
function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] : void 0;
}
function resolveAtomicStrategy(db) {
  if (typeof db.batch === "function") return "batch";
  if (typeof db.run === "function") return "begin-immediate";
  throw new Error(
    "createRecordStore: the injected driver exposes neither batch() nor run() \u2014 an atomic supersede is impossible on it"
  );
}
async function runGuardedPair(db, strategy, guard, main) {
  if (strategy === "batch") {
    const batch = db.batch;
    if (typeof batch !== "function") {
      throw new Error("runGuardedPair: batch strategy resolved but the driver has no batch()");
    }
    const results = await batch.call(db, [guard, main]);
    const guardRows = results[0];
    const mainRows = Array.isArray(results[1]) ? results[1] : [];
    return {
      guardMatched: Array.isArray(guardRows) && guardRows.length === 1,
      mainMatched: mainRows.length > 0,
      rolledBack: false,
      mainRows
    };
  }
  await db.run(sql2`begin immediate`);
  try {
    const guardRows = await guard;
    if (!Array.isArray(guardRows) || guardRows.length !== 1) {
      await db.run(sql2`rollback`);
      return { guardMatched: false, mainMatched: false, rolledBack: true, mainRows: [] };
    }
    const mainRows = await main;
    if (!Array.isArray(mainRows) || mainRows.length === 0) {
      await db.run(sql2`rollback`);
      return { guardMatched: true, mainMatched: false, rolledBack: true, mainRows: [] };
    }
    await db.run(sql2`commit`);
    return { guardMatched: true, mainMatched: true, rolledBack: false, mainRows };
  } catch (error) {
    await rollbackQuietly(db);
    throw error;
  }
}
async function rollbackQuietly(db) {
  try {
    await db.run(sql2`rollback`);
  } catch {
  }
}
function errorMessage(error) {
  const parts = [];
  let cursor = error;
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth++) {
    parts.push(cursor.message);
    cursor = cursor.cause;
  }
  return parts.length > 0 ? parts.join(" \u2014 ") : String(error);
}
function isUniqueViolation(error) {
  let cursor = error;
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth++) {
    if (cursor.message.includes("UNIQUE constraint failed")) return true;
    cursor = cursor.cause;
  }
  return false;
}
export {
  RECORD_STORE_COLUMNS,
  createRecordStore,
  createRecordTable,
  resolveAtomicStrategy,
  toFoldable
};
//# sourceMappingURL=drizzle.js.map