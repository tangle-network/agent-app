// src/plans/index.ts
var PLAN_SUBMITTED_EVENT = "plan.submitted";
var PLAN_STATUSES = /* @__PURE__ */ new Set([
  "preparing",
  "pending",
  "approved",
  "rejected",
  "superseded",
  "withdrawn"
]);
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function requiredString(record, key) {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}
function parsePlan(record, defaultStatus) {
  const planId = requiredString(record, "planId") ?? requiredString(record, "id");
  const revision = record.revision;
  const body = requiredString(record, "body");
  const submittedAt = requiredString(record, "submittedAt");
  const status = typeof record.status === "string" ? record.status : defaultStatus;
  if (!planId || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || !body || !submittedAt || !status || !PLAN_STATUSES.has(status)) {
    return null;
  }
  const common = {
    planId,
    revision,
    ...typeof record.title === "string" && record.title ? { title: record.title } : {},
    body,
    submittedAt,
    ...record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? { metadata: record.metadata } : {},
    ...typeof record.decidedBy === "string" && record.decidedBy ? { decidedBy: record.decidedBy } : {}
  };
  if (status === "preparing") return { ...common, status: "preparing" };
  if (status === "pending") return { ...common, status: "pending" };
  if (status === "approved") {
    const decidedAt = requiredString(record, "decidedAt");
    return decidedAt ? { ...common, status, decidedAt } : null;
  }
  if (status === "rejected") {
    const decidedAt = requiredString(record, "decidedAt");
    const feedback = requiredString(record, "feedback");
    return decidedAt && feedback ? { ...common, status, decidedAt, feedback } : null;
  }
  if (status === "superseded") {
    const supersededAt = requiredString(record, "supersededAt");
    const supersededByPlanId = requiredString(record, "supersededByPlanId");
    return supersededAt && supersededByPlanId ? { ...common, status, supersededAt, supersededByPlanId } : null;
  }
  const withdrawnAt = requiredString(record, "withdrawnAt");
  const withdrawnReason = requiredString(record, "withdrawnReason") ?? requiredString(record, "reason");
  return withdrawnAt && withdrawnReason ? { ...common, status: "withdrawn", withdrawnAt, withdrawnReason } : null;
}
function planPartKey(planId) {
  return `plan:${planId}`;
}
function planRevisionKey(planId, revision) {
  return `plan:${planId}:revision:${revision}`;
}
function planFollowUpTurnId(planId, outcome) {
  return `plan:${planId}:${outcome}`;
}
function canTransitionPlanStatus(from, to) {
  if (from === to) return true;
  if (from === "preparing") return to === "pending" || to === "superseded" || to === "withdrawn";
  if (from === "pending") return to === "approved" || to === "rejected" || to === "superseded" || to === "withdrawn";
  return false;
}
function planToPersistedPart(plan) {
  return { type: "plan", ...plan };
}
function persistedPartToPlan(part) {
  if (String(part.type ?? "") !== "plan") return null;
  return parsePlan(part);
}
function parsePlanSubmittedEvent(event) {
  const root = asRecord(event);
  if (!root || root.type !== PLAN_SUBMITTED_EVENT) {
    return { succeeded: false, error: "event is not plan.submitted" };
  }
  const plan = asRecord(asRecord(root.properties)?.plan) ?? asRecord(asRecord(root.data)?.plan);
  if (!plan) {
    return { succeeded: false, error: "plan.submitted event carried no plan" };
  }
  const parsed = parsePlan(plan, "pending");
  return parsed ? { succeeded: true, value: parsed } : { succeeded: false, error: "plan.submitted event carried a malformed plan" };
}

export {
  PLAN_SUBMITTED_EVENT,
  planPartKey,
  planRevisionKey,
  planFollowUpTurnId,
  canTransitionPlanStatus,
  planToPersistedPart,
  persistedPartToPlan,
  parsePlanSubmittedEvent
};
//# sourceMappingURL=chunk-YJMCRXQQ.js.map