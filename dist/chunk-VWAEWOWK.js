import {
  emptyPayload,
  markComplete,
  payloadComplete,
  withAnswer
} from "./chunk-YZ6KQULN.js";
import {
  getQuestion,
  validateAnswer
} from "./chunk-JDEGS53O.js";

// src/intakes/drizzle/store.ts
import { eq } from "drizzle-orm";
var IntakeError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "IntakeError";
    this.code = code;
  }
};
function createScopedStore(opts) {
  const { db, graph, table, scopeColumn, scopeValue, insertScope } = opts;
  async function loadRow() {
    const [row] = await db.select().from(table).where(eq(scopeColumn, scopeValue)).limit(1);
    return row ?? null;
  }
  function toState(row) {
    if (!row) {
      return { payload: emptyPayload(graph), completed: false, completedAt: null };
    }
    const payload = normalizePayload(row.payload, row.graphId);
    const completedAt = toDate(row.completedAt);
    return {
      payload,
      completed: completedAt != null && payloadComplete(graph, payload),
      completedAt
    };
  }
  async function get() {
    return toState(await loadRow());
  }
  async function upsertPayload(payload, completedAt) {
    const existing = await loadRow();
    if (existing) {
      await db.update(table).set({ graphId: payload.graphId, payload, completedAt, updatedAt: /* @__PURE__ */ new Date() }).where(eq(scopeColumn, scopeValue));
      return;
    }
    await db.insert(table).values({
      ...insertScope,
      graphId: payload.graphId,
      payload,
      completedAt
    });
  }
  async function save(questionId, value) {
    const question = getQuestion(graph, questionId);
    if (!question) throw new IntakeError("unknown-question", `No question '${questionId}' in intake '${graph.id}'`);
    const validity = validateAnswer(question, value);
    if (!validity.ok) {
      throw new IntakeError("invalid-answer", `Answer to '${questionId}' rejected: ${validity.reason}`);
    }
    const current = await get();
    const next = withAnswer(current.payload, questionId, value);
    await upsertPayload(next, current.completedAt);
    return toState({ graphId: next.graphId, payload: next, completedAt: current.completedAt });
  }
  async function complete() {
    const current = await get();
    if (current.payload.graphId !== graph.id) {
      throw new IntakeError("stale-graph", `Intake payload was collected against '${current.payload.graphId}', not '${graph.id}'`);
    }
    if (!payloadComplete(graph, current.payload)) {
      throw new IntakeError("incomplete", `Intake '${graph.id}' has unanswered required questions`);
    }
    const completedPayload = markComplete(current.payload);
    const completedAt = new Date(completedPayload.completedAt);
    await upsertPayload(completedPayload, completedAt);
    return { payload: completedPayload, completed: true, completedAt };
  }
  return { get, save, complete };
}
function createUserIntakeStore(opts) {
  return createScopedStore({
    db: opts.db,
    graph: opts.graph,
    table: opts.table,
    scopeColumn: opts.table.userId,
    scopeValue: opts.userId,
    insertScope: { userId: opts.userId }
  });
}
function createProjectIntakeStore(opts) {
  return createScopedStore({
    db: opts.db,
    graph: opts.graph,
    table: opts.table,
    scopeColumn: opts.table.workspaceId,
    scopeValue: opts.workspaceId,
    insertScope: { workspaceId: opts.workspaceId }
  });
}
function normalizePayload(raw, graphId) {
  if (raw && typeof raw === "object" && "answers" in raw) {
    const candidate = raw;
    return {
      graphId: candidate.graphId ?? graphId,
      answers: candidate.answers ?? {},
      ...candidate.completedAt ? { completedAt: candidate.completedAt } : {}
    };
  }
  return { graphId, answers: {} };
}
function toDate(value) {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(Number(value) * (Number(value) < 1e12 ? 1e3 : 1));
}

export {
  IntakeError,
  createUserIntakeStore,
  createProjectIntakeStore
};
//# sourceMappingURL=chunk-VWAEWOWK.js.map