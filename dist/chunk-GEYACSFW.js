import {
  unresolvedBlockingExceptions
} from "./chunk-ZVEEWGDK.js";

// src/work-product/queue.ts
var OPEN_STATUSES = /* @__PURE__ */ new Set(["draft", "blocked", "ready", "changes_requested"]);
function currentRecordPerScope(records) {
  const byScope = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (record.status === "superseded") continue;
    const held = byScope.get(record.scopeKey);
    if (!held) {
      byScope.set(record.scopeKey, record);
      continue;
    }
    const heldOpen = OPEN_STATUSES.has(held.status);
    const recordOpen = OPEN_STATUSES.has(record.status);
    if (recordOpen !== heldOpen) {
      if (recordOpen) byScope.set(record.scopeKey, record);
      continue;
    }
    if (record.version > held.version || record.version === held.version && record.updatedAt > held.updatedAt) {
      byScope.set(record.scopeKey, record);
    }
  }
  return byScope;
}
function stateOf(record, pendingAsk) {
  switch (record.status) {
    case "ready":
      return "ready_for_review";
    case "changes_requested":
      return "changes_requested";
    case "approved":
      return "approved";
    case "blocked":
      return pendingAsk ? "missing_info" : "blocked";
    case "draft":
      return pendingAsk ? "missing_info" : "working";
    // 'superseded' is filtered before this switch.
    default:
      return "working";
  }
}
function projectReviewQueue(inputs) {
  const asksByThread = /* @__PURE__ */ new Map();
  for (const ask of inputs.pendingAsks ?? []) {
    if (!asksByThread.has(ask.threadId)) asksByThread.set(ask.threadId, ask);
  }
  const items = [];
  const byScope = currentRecordPerScope(inputs.workProducts);
  for (const [scopeKey, record] of byScope) {
    const pendingAsk = record.threadId ? asksByThread.get(record.threadId) : void 0;
    const item = {
      scopeKey,
      state: stateOf(record, pendingAsk),
      threadId: record.threadId,
      workProduct: {
        id: record.id,
        version: record.version,
        title: record.artifact?.title ?? scopeKey,
        kind: record.artifact?.kind ?? ""
      },
      blockingExceptions: unresolvedBlockingExceptions(record.exceptions).length,
      failedChecks: record.checks.filter((check) => !check.passed).length,
      provenance: { profileHash: record.provenance.profileHash, servingModels: record.provenance.servingModels },
      updatedAt: record.updatedAt
    };
    if (pendingAsk) item.pendingAsk = { interactionId: pendingAsk.interactionId, title: pendingAsk.title };
    items.push(item);
  }
  for (const thread of inputs.threads ?? []) {
    if (byScope.has(thread.scopeKey)) continue;
    if (items.some((item) => item.scopeKey === thread.scopeKey)) continue;
    items.push({
      scopeKey: thread.scopeKey,
      state: "intake",
      threadId: thread.threadId,
      blockingExceptions: 0,
      failedChecks: 0,
      updatedAt: thread.updatedAt
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}
function parseReviewQueueItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw;
  const states = [
    "intake",
    "missing_info",
    "working",
    "ready_for_review",
    "changes_requested",
    "approved",
    "blocked"
  ];
  if (typeof record.scopeKey !== "string" || record.scopeKey.length === 0) return null;
  if (!states.includes(record.state)) return null;
  if (record.threadId !== null && typeof record.threadId !== "string") return null;
  if (typeof record.blockingExceptions !== "number" || typeof record.failedChecks !== "number") return null;
  if (typeof record.updatedAt !== "number") return null;
  const item = {
    scopeKey: record.scopeKey,
    state: record.state,
    threadId: record.threadId,
    blockingExceptions: record.blockingExceptions,
    failedChecks: record.failedChecks,
    updatedAt: record.updatedAt
  };
  const workProduct = record.workProduct;
  if (workProduct && typeof workProduct === "object") {
    if (typeof workProduct.id === "string" && typeof workProduct.version === "number" && typeof workProduct.title === "string" && typeof workProduct.kind === "string") {
      item.workProduct = {
        id: workProduct.id,
        version: workProduct.version,
        title: workProduct.title,
        kind: workProduct.kind
      };
    }
  }
  const pendingAsk = record.pendingAsk;
  if (pendingAsk && typeof pendingAsk === "object") {
    if (typeof pendingAsk.interactionId === "string" && typeof pendingAsk.title === "string") {
      item.pendingAsk = { interactionId: pendingAsk.interactionId, title: pendingAsk.title };
    }
  }
  const provenance = record.provenance;
  if (provenance && typeof provenance === "object") {
    if (typeof provenance.profileHash === "string" && Array.isArray(provenance.servingModels) && provenance.servingModels.every((model) => typeof model === "string")) {
      item.provenance = { profileHash: provenance.profileHash, servingModels: provenance.servingModels };
    }
  }
  return item;
}

export {
  projectReviewQueue,
  parseReviewQueueItem
};
//# sourceMappingURL=chunk-GEYACSFW.js.map