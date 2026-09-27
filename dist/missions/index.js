// src/missions/service.ts
var TERMINAL_STATUSES = /* @__PURE__ */ new Set([
  "succeeded",
  "failed",
  "aborted",
  "cancelled"
]);
function isMissionTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}
function isMissionStopRequested(mission) {
  return (mission.metadata ?? {}).stopRequested === true;
}
var MISSION_TRANSITIONS = {
  scheduled: /* @__PURE__ */ new Set(["running", "cancelled", "aborted"]),
  running: /* @__PURE__ */ new Set([
    "paused",
    "waiting_approval",
    "blocked",
    "succeeded",
    "failed",
    "aborted"
  ]),
  paused: /* @__PURE__ */ new Set(["running", "aborted", "cancelled"]),
  waiting_approval: /* @__PURE__ */ new Set(["running", "aborted", "cancelled"]),
  blocked: /* @__PURE__ */ new Set(["running", "aborted", "cancelled"]),
  succeeded: /* @__PURE__ */ new Set(),
  failed: /* @__PURE__ */ new Set(),
  aborted: /* @__PURE__ */ new Set(),
  cancelled: /* @__PURE__ */ new Set()
};
var STEP_TRANSITIONS = {
  pending: /* @__PURE__ */ new Set(["running", "waiting_approval", "failed"]),
  running: /* @__PURE__ */ new Set(["done", "failed", "waiting_approval"]),
  waiting_approval: /* @__PURE__ */ new Set(["running", "done", "failed"]),
  done: /* @__PURE__ */ new Set([]),
  failed: /* @__PURE__ */ new Set(["pending", "running"])
};
var ZERO_LEDGER = {
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  wallMs: 0,
  llmCalls: 0
};
function rejected(error) {
  return { succeeded: false, error, conflict: false };
}
function lostRace(id) {
  return { succeeded: false, error: `Mission ${id} changed concurrently`, conflict: true };
}
function createMissionService(options) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  async function appendEvent(mission, level, step, message, metadata = {}) {
    await store.appendEvent({
      missionId: mission.id,
      workspaceId: mission.workspaceId,
      level,
      step,
      message,
      metadata,
      at: now()
    });
  }
  async function transition(id, to, patch = {}, eventMeta = {}) {
    const mission = await store.load(id);
    if (!mission) return rejected(`Mission ${id} not found`);
    const from = mission.status;
    if (TERMINAL_STATUSES.has(from)) {
      return rejected(`Mission ${id} is terminal (${from}); cannot transition to ${to}`);
    }
    if (from === to) return { succeeded: true, value: mission };
    if (!MISSION_TRANSITIONS[from].has(to)) {
      return rejected(`Illegal mission transition ${from} -> ${to} for mission ${id}`);
    }
    const updated = await store.update(id, { status: from }, { status: to, ...patch });
    if (!updated) return lostRace(id);
    await appendEvent(updated, to === "failed" ? "error" : "info", `mission.${to}`, `Mission ${from} -> ${to}`, {
      from,
      to,
      ...eventMeta
    });
    return { succeeded: true, value: updated };
  }
  const createMission = async (input) => {
    const seen = /* @__PURE__ */ new Set();
    for (const step of input.plan) {
      if (seen.has(step.id)) {
        throw new Error(`Duplicate plan step id "${step.id}" \u2014 mission plan step ids must be unique`);
      }
      seen.add(step.id);
    }
    const scheduledAt = input.scheduledAt ?? null;
    const status = scheduledAt !== null ? "scheduled" : "running";
    const plan = input.plan.map((step) => ({
      id: step.id,
      intent: step.intent,
      kind: step.kind,
      status: step.status,
      attempts: step.attempts,
      ...step.sublabel === void 0 ? {} : { sublabel: step.sublabel },
      ...step.resultRef === void 0 ? {} : { resultRef: step.resultRef }
    }));
    const record = await store.insert(
      {
        id: input.id ?? generateId(),
        workspaceId: input.workspaceId,
        status,
        trigger: input.trigger,
        summary: input.title,
        plan,
        cursor: 0,
        cost: { ...ZERO_LEDGER },
        budgetUsd: input.budgetUsd ?? null,
        spentUsd: 0,
        pauseReason: null,
        engineRef: null,
        scheduledAt,
        startedAt: now(),
        completedAt: null,
        metadata: input.metadata ?? null
      },
      input.extras
    );
    await appendEvent(record, "info", "mission.created", `Mission "${input.title}" ${status}`, {
      status,
      stepCount: plan.length,
      budgetUsd: input.budgetUsd ?? null,
      scheduledAt
    });
    return record;
  };
  const getMission = (id) => store.load(id);
  const setEngineRef = async (id, engineRef) => {
    const mission = await store.load(id);
    if (!mission) return rejected(`Mission ${id} not found`);
    if (TERMINAL_STATUSES.has(mission.status) || isMissionStopRequested(mission)) {
      return rejected(`Mission ${id} is not writable in status ${mission.status}`);
    }
    if (mission.engineRef === engineRef) return { succeeded: true, value: mission };
    if (mission.engineRef !== null) {
      return rejected(`Mission ${id} is already bound to engine ${mission.engineRef}`);
    }
    const updated = await store.update(id, { engineRefIsNull: true }, { engineRef });
    if (!updated) return lostRace(id);
    await appendEvent(updated, "info", "mission.engine", `Engine bound: ${engineRef}`, { engineRef });
    return { succeeded: true, value: updated };
  };
  const mergeMetadata = async (id, patch) => {
    const mission = await store.load(id);
    if (!mission) return rejected(`Mission ${id} not found`);
    if (TERMINAL_STATUSES.has(mission.status) || isMissionStopRequested(mission)) {
      return rejected(`Mission ${id} is not writable in status ${mission.status}`);
    }
    const updated = await store.update(
      id,
      { metadata: mission.metadata },
      { metadata: { ...mission.metadata ?? {}, ...patch } }
    );
    if (!updated) return lostRace(id);
    return { succeeded: true, value: updated };
  };
  const setStepStatus = async (id, stepId, status, patch = {}) => {
    const mission = await store.load(id);
    if (!mission) return rejected(`Mission ${id} not found`);
    const plan = mission.plan;
    const index = plan.findIndex((step) => step.id === stepId);
    const current = index < 0 ? void 0 : plan[index];
    if (!current) return rejected(`Step ${stepId} not found in mission ${id}`);
    const sameStatus = current.status === status;
    if (!sameStatus && !STEP_TRANSITIONS[current.status].has(status)) {
      return rejected(`Illegal step transition ${current.status} -> ${status} for step ${stepId}`);
    }
    const sublabelChanges = patch.sublabel !== void 0 && patch.sublabel !== current.sublabel;
    const resultRefChanges = patch.resultRef !== void 0 && patch.resultRef !== current.resultRef;
    if (sameStatus && !sublabelChanges && !resultRefChanges) {
      return { succeeded: true, value: mission };
    }
    const nextStep = {
      ...current,
      status,
      attempts: status === "running" && !sameStatus ? current.attempts + 1 : current.attempts,
      ...patch.sublabel === void 0 ? {} : { sublabel: patch.sublabel },
      ...patch.resultRef === void 0 ? {} : { resultRef: patch.resultRef }
    };
    const nextPlan = plan.slice();
    nextPlan[index] = nextStep;
    const cost = patch.cost;
    const ledgerDelta = cost?.ledgerDelta;
    const base = mission.cost ?? { ...ZERO_LEDGER };
    const nextCost = cost === void 0 ? void 0 : {
      tokensIn: base.tokensIn + (ledgerDelta?.tokensIn ?? 0),
      tokensOut: base.tokensOut + (ledgerDelta?.tokensOut ?? 0),
      costUsd: base.costUsd + (ledgerDelta?.costUsd ?? cost.deltaUsd),
      wallMs: base.wallMs + (ledgerDelta?.wallMs ?? 0),
      llmCalls: base.llmCalls + (ledgerDelta?.llmCalls ?? 0)
    };
    const updated = await store.update(
      id,
      {
        status: mission.status,
        plan: mission.plan,
        metadata: mission.metadata,
        ...cost === void 0 ? {} : { cost: mission.cost }
      },
      {
        plan: nextPlan,
        ...cost === void 0 ? {} : { cost: nextCost, spentUsd: mission.spentUsd + cost.deltaUsd }
      }
    );
    if (!updated) return lostRace(id);
    await appendEvent(
      updated,
      status === "failed" ? "error" : "info",
      `mission.step.${status}`,
      patch.error ?? `Step ${stepId} (${current.intent}) -> ${status}`,
      {
        stepId,
        from: current.status,
        to: status,
        attempts: nextStep.attempts,
        ...patch.resultRef ? { resultRef: patch.resultRef } : {}
      }
    );
    if (cost !== void 0) {
      await appendEvent(updated, "info", "mission.cost", `Spent +$${cost.deltaUsd.toFixed(4)}`, {
        deltaUsd: cost.deltaUsd,
        spentUsd: updated.spentUsd,
        budgetUsd: updated.budgetUsd
      });
    }
    return { succeeded: true, value: updated };
  };
  const advanceCursor = async (id) => {
    const mission = await store.load(id);
    if (!mission) return rejected(`Mission ${id} not found`);
    const next = mission.cursor + 1;
    if (next > mission.plan.length) {
      return rejected(`Cursor ${mission.cursor} is already at the end of mission ${id}`);
    }
    const updated = await store.update(
      id,
      { status: mission.status, cursor: mission.cursor },
      { cursor: next }
    );
    if (!updated) return lostRace(id);
    await appendEvent(updated, "info", "mission.cursor", `Cursor ${mission.cursor} -> ${updated.cursor}`, {
      from: mission.cursor,
      to: updated.cursor
    });
    return { succeeded: true, value: updated };
  };
  const addCost = async (id, deltaUsd, ledgerDelta) => {
    const mission = await store.load(id);
    if (!mission) return rejected(`Mission ${id} not found`);
    const base = mission.cost ?? { ...ZERO_LEDGER };
    const nextCost = {
      tokensIn: base.tokensIn + (ledgerDelta?.tokensIn ?? 0),
      tokensOut: base.tokensOut + (ledgerDelta?.tokensOut ?? 0),
      costUsd: base.costUsd + (ledgerDelta?.costUsd ?? deltaUsd),
      wallMs: base.wallMs + (ledgerDelta?.wallMs ?? 0),
      llmCalls: base.llmCalls + (ledgerDelta?.llmCalls ?? 0)
    };
    const updated = await store.update(
      id,
      { cost: mission.cost },
      { cost: nextCost, spentUsd: mission.spentUsd + deltaUsd }
    );
    if (!updated) return lostRace(id);
    await appendEvent(updated, "info", "mission.cost", `Spent +$${deltaUsd.toFixed(4)}`, {
      deltaUsd,
      spentUsd: updated.spentUsd,
      budgetUsd: updated.budgetUsd
    });
    return { succeeded: true, value: updated };
  };
  const markWaitingApproval = async (id, stepId) => {
    const mission = await store.load(id);
    if (!mission) return rejected(`Mission ${id} not found`);
    if (!MISSION_TRANSITIONS[mission.status].has("waiting_approval")) {
      return rejected(`Illegal mission transition ${mission.status} -> waiting_approval for mission ${id}`);
    }
    const stepResult = await setStepStatus(id, stepId, "waiting_approval");
    if (!stepResult.succeeded) return stepResult;
    return transition(id, "waiting_approval", {}, { stepId });
  };
  return {
    createMission,
    getMission,
    setEngineRef,
    mergeMetadata,
    setStepStatus,
    advanceCursor,
    addCost,
    markWaitingApproval,
    pause: (id, reason) => transition(id, "paused", { pauseReason: reason }),
    resume: (id) => transition(id, "running", { pauseReason: null }),
    abort: (id) => transition(id, "aborted", { completedAt: now() }),
    complete: (id, input) => transition(id, input.ok ? "succeeded" : "failed", {
      completedAt: now(),
      ...input.summary === void 0 ? {} : { summary: input.summary }
    })
  };
}
function createInMemoryMissionStore() {
  const rows = /* @__PURE__ */ new Map();
  const events = [];
  return {
    async load(id) {
      const record = rows.get(id);
      return record ? structuredClone(record) : null;
    },
    async insert(record) {
      if (rows.has(record.id)) throw new Error(`Mission ${record.id} already exists`);
      rows.set(record.id, structuredClone(record));
      return structuredClone(record);
    },
    async update(id, guard, patch) {
      const current = rows.get(id);
      if (!current) return null;
      if (guard.status !== void 0 && current.status !== guard.status) return null;
      if (guard.cursor !== void 0 && current.cursor !== guard.cursor) return null;
      if (guard.plan !== void 0 && JSON.stringify(current.plan) !== JSON.stringify(guard.plan)) return null;
      if (guard.cost !== void 0 && JSON.stringify(current.cost) !== JSON.stringify(guard.cost)) return null;
      if (guard.metadata !== void 0 && JSON.stringify(current.metadata) !== JSON.stringify(guard.metadata)) {
        return null;
      }
      if (guard.engineRefIsNull && current.engineRef !== null) return null;
      const next = { ...current };
      if (patch.status !== void 0) next.status = patch.status;
      if (patch.pauseReason !== void 0) next.pauseReason = patch.pauseReason;
      if (patch.summary !== void 0) next.summary = patch.summary;
      if (patch.completedAt !== void 0) next.completedAt = patch.completedAt;
      if (patch.plan !== void 0) next.plan = patch.plan;
      if (patch.cursor !== void 0) next.cursor = patch.cursor;
      if (patch.cost !== void 0) next.cost = patch.cost;
      if (patch.spentUsd !== void 0) next.spentUsd = patch.spentUsd;
      if (patch.metadata !== void 0) next.metadata = patch.metadata;
      if (patch.engineRef !== void 0) next.engineRef = patch.engineRef;
      rows.set(id, structuredClone(next));
      return structuredClone(next);
    },
    async appendEvent(event) {
      events.push(structuredClone(event));
    },
    events() {
      return events.map((event) => structuredClone(event));
    },
    put(record) {
      rows.set(record.id, structuredClone(record));
    }
  };
}

// src/missions/events.ts
var noopEventSink = { emit() {
} };
var MISSION_CONTROL_CHANNEL_ID = "missions";
var MISSION_EVENT_TYPES = /* @__PURE__ */ new Set([
  "mission.created",
  "mission.started",
  "step.started",
  "step.updated",
  "step.completed",
  "cost.updated",
  "mission.paused",
  "mission.waiting_approval",
  "mission.resumed",
  "mission.plan.updated",
  "mission.completed"
]);
function parseSessionStreamEnvelope(raw) {
  if (!raw || typeof raw !== "object") return null;
  const envelope = raw;
  if (typeof envelope.type !== "string") return null;
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  return asMissionStreamEvent({ ...data, type: envelope.type });
}
function asMissionStreamEvent(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const type = record.type;
  if (typeof type !== "string" || !MISSION_EVENT_TYPES.has(type)) return null;
  if (typeof record.missionId !== "string" || !record.missionId) return null;
  return value;
}
var STEP_RANK = {
  pending: 0,
  running: 1,
  waiting_approval: 2,
  // done and failed are both TERMINAL for a step; rank them equal-and-highest
  // so neither can be overwritten by the other or regressed to running.
  done: 3,
  failed: 3
};
var MISSION_RANK = {
  scheduled: 0,
  running: 1,
  paused: 2,
  waiting_approval: 2,
  succeeded: 3,
  aborted: 3,
  cancelled: 3,
  failed: 3
};
function maxStepStatus(current, next) {
  if (STEP_RANK[next] <= STEP_RANK[current]) return current;
  return next;
}
function maxMissionStatus(current, next) {
  if (MISSION_RANK[next] <= MISSION_RANK[current]) return current;
  return next;
}
function emptyMission(missionId) {
  return {
    missionId,
    status: "scheduled",
    steps: [],
    spentUsd: 0,
    lastEventAt: 0,
    lastControlAt: 0
  };
}
function stepStateFrom(step) {
  return { id: step.id, intent: step.intent, kind: step.kind, status: step.status };
}
function applyMissionEvent(prev, event) {
  const at = typeof event.at === "number" ? event.at : 0;
  const base = prev ?? emptyMission(event.missionId);
  const lastEventAt = Math.max(base.lastEventAt, at);
  const lastControlAt = base.lastControlAt ?? 0;
  switch (event.type) {
    case "mission.created": {
      const merged = event.steps.map((incoming) => {
        const existing = base.steps.find((s) => s.id === incoming.id);
        if (!existing) return stepStateFrom(incoming);
        return {
          ...existing,
          intent: incoming.intent,
          kind: incoming.kind,
          status: maxStepStatus(existing.status, incoming.status)
        };
      });
      for (const known of base.steps) {
        if (!merged.some((s) => s.id === known.id)) merged.push(known);
      }
      return {
        ...base,
        title: event.title || base.title,
        status: maxMissionStatus(base.status, event.status ?? base.status),
        capUsd: event.budgetUsd ?? base.capUsd,
        steps: merged,
        lastEventAt
      };
    }
    case "mission.started":
      return { ...base, status: maxMissionStatus(base.status, "running"), lastEventAt };
    case "step.started":
      return {
        ...base,
        steps: upsertStep(base.steps, event.stepId, (step) => ({
          ...step,
          status: maxStepStatus(step.status, "running")
        })),
        lastEventAt
      };
    case "step.updated":
      return {
        ...base,
        steps: upsertStep(base.steps, event.stepId, (step) => ({
          ...step,
          // A sublabel is a live counter ("7/15") — always take the latest; it
          // does not move status.
          ...event.sublabel !== void 0 ? { sublabel: event.sublabel } : {},
          // agentActivity is a full snapshot, replaced wholesale. Guarded by
          // `at` so a stale snapshot delivered late never erases newer rows;
          // an equal-`at` replay rewrites identical content (idempotent).
          ...event.agentActivity !== void 0 && at >= (step.agentActivityAt ?? 0) ? { agentActivity: event.agentActivity, agentActivityAt: at } : {}
        })),
        lastEventAt
      };
    case "step.completed":
      return {
        ...base,
        steps: upsertStep(base.steps, event.stepId, (step) => ({
          ...step,
          status: maxStepStatus(step.status, event.ok ? "done" : "failed"),
          ...event.reason !== void 0 ? { reason: event.reason } : {},
          ...event.durationMs !== void 0 ? { durationMs: event.durationMs } : {}
        })),
        lastEventAt
      };
    case "cost.updated":
      return {
        ...base,
        // spentUsd is cumulative and monotonically non-decreasing at the
        // source; clamp so an out-of-order older value never lowers the
        // displayed spend.
        spentUsd: Math.max(base.spentUsd, event.spentUsd),
        capUsd: event.capUsd ?? base.capUsd,
        lastEventAt
      };
    case "mission.paused":
      if (at <= lastControlAt) return { ...base, lastEventAt };
      return {
        ...base,
        status: maxMissionStatus(base.status, "paused"),
        ...event.reason !== void 0 ? { pauseReason: event.reason } : {},
        lastEventAt,
        lastControlAt: Math.max(lastControlAt, at)
      };
    case "mission.waiting_approval":
      if (at <= lastControlAt) return { ...base, lastEventAt };
      return {
        ...base,
        status: maxMissionStatus(base.status, "waiting_approval"),
        ...event.reason !== void 0 ? { pauseReason: event.reason } : {},
        lastEventAt,
        lastControlAt: Math.max(lastControlAt, at)
      };
    case "mission.resumed":
      if (at <= lastControlAt) return { ...base, lastEventAt };
      return {
        ...base,
        status: isTerminalStreamStatus(base.status) ? base.status : "running",
        pauseReason: void 0,
        lastEventAt,
        lastControlAt: Math.max(lastControlAt, at)
      };
    case "mission.plan.updated":
      return {
        ...base,
        title: event.title || base.title,
        capUsd: event.budgetUsd ?? base.capUsd,
        steps: event.steps.map((incoming) => {
          const existing = base.steps.find((s) => s.id === incoming.id);
          if (!existing) return stepStateFrom(incoming);
          return {
            ...stepStateFrom(incoming),
            status: maxStepStatus(existing.status, incoming.status),
            ...existing.sublabel !== void 0 ? { sublabel: existing.sublabel } : {},
            ...existing.reason !== void 0 ? { reason: existing.reason } : {},
            ...existing.durationMs !== void 0 ? { durationMs: existing.durationMs } : {},
            ...existing.agentActivity !== void 0 ? { agentActivity: existing.agentActivity } : {},
            ...existing.agentActivityAt !== void 0 ? { agentActivityAt: existing.agentActivityAt } : {}
          };
        }),
        lastEventAt
      };
    case "mission.completed":
      return {
        ...base,
        status: maxMissionStatus(base.status, event.status ?? (event.ok ? "succeeded" : "failed")),
        ...event.summary !== void 0 ? { summary: event.summary } : {},
        lastEventAt
      };
  }
}
function isTerminalStreamStatus(status) {
  return status === "succeeded" || status === "failed" || status === "aborted" || status === "cancelled";
}
function upsertStep(steps, stepId, patch) {
  const index = steps.findIndex((s) => s.id === stepId);
  const existing = index < 0 ? void 0 : steps[index];
  if (!existing) {
    const placeholder = {
      id: stepId,
      intent: "",
      kind: "",
      status: "pending"
    };
    return [...steps, patch(placeholder)];
  }
  const next = steps.slice();
  next[index] = patch(existing);
  return next;
}
function mergeMissionState(live, seed) {
  if (!live) return seed;
  const steps = [];
  for (const seededStep of seed.steps) {
    const current = live.steps.find((s) => s.id === seededStep.id);
    if (!current) {
      steps.push(seededStep);
      continue;
    }
    steps.push({
      ...seededStep,
      intent: current.intent || seededStep.intent,
      kind: current.kind || seededStep.kind,
      status: maxStepStatus(current.status, seededStep.status),
      ...current.sublabel !== void 0 ? { sublabel: current.sublabel } : seededStep.sublabel !== void 0 ? { sublabel: seededStep.sublabel } : {},
      ...current.reason !== void 0 ? { reason: current.reason } : seededStep.reason !== void 0 ? { reason: seededStep.reason } : {},
      ...current.durationMs !== void 0 ? { durationMs: current.durationMs } : seededStep.durationMs !== void 0 ? { durationMs: seededStep.durationMs } : {},
      // The newer snapshot wins by its stamped `at`; an unstamped lane (loader
      // seed copied from the settled artifact) only fills an empty live lane.
      ...mergeActivity(current, seededStep)
    });
  }
  for (const current of live.steps) {
    if (seed.steps.some((step) => step.id === current.id)) continue;
    if (hasStepProgressEvidence(current)) steps.push(current);
  }
  const status = mergeSeedMissionStatus(live.status, seed.status, live.lastControlAt ?? 0, seed.lastControlAt ?? 0);
  return {
    ...live,
    title: live.title ?? seed.title,
    status,
    steps,
    spentUsd: Math.max(live.spentUsd, seed.spentUsd),
    capUsd: live.capUsd ?? seed.capUsd,
    pauseReason: status === "running" || status === "scheduled" ? void 0 : seed.pauseReason ?? live.pauseReason,
    summary: live.summary ?? seed.summary,
    lastEventAt: Math.max(live.lastEventAt, seed.lastEventAt),
    lastControlAt: Math.max(live.lastControlAt ?? 0, seed.lastControlAt ?? 0)
  };
}
function hasStepProgressEvidence(step) {
  return step.status !== "pending" || step.sublabel !== void 0 || step.reason !== void 0 || step.durationMs !== void 0 || step.agentActivity !== void 0;
}
function mergeActivity(live, seeded) {
  const winner = (seeded.agentActivityAt ?? 0) > (live.agentActivityAt ?? 0) ? seeded : live;
  if (winner.agentActivity === void 0) {
    const fallback = winner === live ? seeded : live;
    if (fallback.agentActivity === void 0) return {};
    return {
      agentActivity: fallback.agentActivity,
      ...fallback.agentActivityAt !== void 0 ? { agentActivityAt: fallback.agentActivityAt } : {}
    };
  }
  return {
    agentActivity: winner.agentActivity,
    ...winner.agentActivityAt !== void 0 ? { agentActivityAt: winner.agentActivityAt } : {}
  };
}
function mergeSeedMissionStatus(liveStatus, seedStatus, liveControlAt, seedControlAt) {
  if (isTerminalStreamStatus(liveStatus)) return liveStatus;
  if (isTerminalStreamStatus(seedStatus)) return seedStatus;
  if ((seedStatus === "paused" || seedStatus === "waiting_approval") && liveControlAt > seedControlAt) {
    return liveStatus;
  }
  if (seedStatus === "running") return "running";
  if (seedStatus === "scheduled" && liveStatus !== "scheduled") return liveStatus;
  return maxMissionStatus(liveStatus, seedStatus);
}
function reduceMissionEvents(events, seed) {
  const next = new Map(seed ?? []);
  for (const event of events) {
    next.set(event.missionId, applyMissionEvent(next.get(event.missionId), event));
  }
  return next;
}

// src/missions/engine.ts
var MissionConcurrencyError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "MissionConcurrencyError";
  }
};
var RetryableStepError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryableStepError";
  }
};
var DEFAULT_EXTERNAL_ACTION_CAP = 5;
var DEFAULT_NON_FATAL_STEP_KINDS = ["optional", "best-effort"];
function stepGateProposalId(missionId, stepId) {
  return `mission-step-gate:${missionId}:${stepId}`;
}
function budgetGateProposalId(missionId, stepId) {
  return `mission-budget-gate:${missionId}:${stepId}`;
}
function volumeGateProposalId(missionId, stepId) {
  return `mission-volume-gate:${missionId}:${stepId}`;
}
function safeEmit(sink, event) {
  try {
    sink.emit(event);
  } catch {
  }
}
function unblocked(resolution) {
  return resolution === "approved" || resolution === "executed";
}
function terminalMissionEvent(missionId, status) {
  const terminal = status === "succeeded" || status === "failed" || status === "aborted" || status === "cancelled" ? status : "failed";
  return {
    type: "mission.completed",
    missionId,
    at: Date.now(),
    ok: terminal === "succeeded",
    status: terminal,
    ...terminal === "succeeded" ? {} : { summary: `Mission ${status}` }
  };
}
function createMissionEngine(options) {
  const { service, estimateStepCostUsd, gates } = options;
  const sink = options.sink ?? noopEventSink;
  const nonFatalStepKinds = new Set(options.nonFatalStepKinds ?? DEFAULT_NON_FATAL_STEP_KINDS);
  const externalActionCap = gates?.externalActionCap ?? DEFAULT_EXTERNAL_ACTION_CAP;
  function isFatalStepKind(kind) {
    return !nonFatalStepKinds.has(kind);
  }
  function rejectStep(failure) {
    if (failure.conflict) throw new MissionConcurrencyError(failure.error);
    return { kind: "failed", error: failure.error, fatal: true };
  }
  function isStepCurrentOrFuture(mission, stepId) {
    const index = mission.plan.findIndex((candidate) => candidate.id === stepId);
    return index >= mission.cursor;
  }
  const recordCost = async (missionId, deltaUsd, ledgerDelta) => {
    const recorded = await service.addCost(missionId, deltaUsd, ledgerDelta);
    if (!recorded.succeeded) return recorded;
    safeEmit(sink, {
      type: "cost.updated",
      missionId,
      at: Date.now(),
      spentUsd: recorded.value.spentUsd,
      capUsd: recorded.value.budgetUsd
    });
    return recorded;
  };
  const pauseMission = async (missionId, reason) => {
    const before = await service.getMission(missionId);
    const paused = await service.pause(missionId, reason);
    if (!paused.succeeded) return paused;
    if (before?.status !== "paused") {
      safeEmit(sink, {
        type: "mission.paused",
        missionId,
        at: Date.now(),
        reason: paused.value.pauseReason ?? reason
      });
    }
    return paused;
  };
  const runStep = async (missionId, stepId, dispatch) => {
    const mission = await service.getMission(missionId);
    if (!mission) throw new MissionConcurrencyError(`Mission ${missionId} not found mid-run`);
    const stepIndex = mission.plan.findIndex((candidate) => candidate.id === stepId);
    const step = stepIndex < 0 ? void 0 : mission.plan[stepIndex];
    if (!step) {
      return { kind: "skipped-cursor", reason: `Step ${stepId} is no longer in mission plan` };
    }
    if (isMissionStopRequested(mission)) {
      return { kind: "failed", error: mission.pauseReason ?? "Mission stop requested", fatal: true };
    }
    if (mission.status !== "running") {
      return { kind: "skipped-cursor", reason: mission.pauseReason ?? `Mission is ${mission.status}` };
    }
    if (step.status === "done" && step.resultRef) {
      if (stepIndex === mission.cursor) {
        const reconciled = await service.advanceCursor(missionId);
        if (!reconciled.succeeded) return rejectStep(reconciled);
      }
      safeEmit(sink, { type: "step.completed", missionId, at: Date.now(), stepId, ok: true });
      return { kind: "done", resultRef: step.resultRef, cached: true };
    }
    if (stepIndex < mission.cursor) {
      return { kind: "skipped-cursor", reason: `Step ${stepId} is behind cursor ${mission.cursor}` };
    }
    const startedAt = Date.now();
    if (step.status !== "running") {
      const running = await service.setStepStatus(missionId, stepId, "running");
      if (!running.succeeded) return rejectStep(running);
    }
    safeEmit(sink, { type: "step.started", missionId, at: startedAt, stepId });
    let dispatched;
    try {
      dispatched = await dispatch({ mission, step, stepIndex });
    } catch (error) {
      if (error instanceof RetryableStepError) throw error;
      const latest = await service.getMission(missionId);
      if (latest && !isMissionTerminal(latest.status) && !isMissionStopRequested(latest) && !isStepCurrentOrFuture(latest, stepId)) {
        return { kind: "skipped-cursor", reason: `Step ${stepId} is no longer active` };
      }
      const message = error instanceof Error ? error.message : "Sandbox dispatch failed";
      const failed = await service.setStepStatus(missionId, stepId, "failed", { error: message });
      if (!failed.succeeded) return rejectStep(failed);
      safeEmit(sink, {
        type: "step.completed",
        missionId,
        at: Date.now(),
        stepId,
        ok: false,
        reason: message,
        durationMs: Date.now() - startedAt
      });
      return { kind: "failed", error: message, fatal: isFatalStepKind(step.kind) };
    }
    const afterDispatch = await service.getMission(missionId);
    if (!afterDispatch) throw new MissionConcurrencyError(`Mission ${missionId} not found after dispatch`);
    if (isMissionTerminal(afterDispatch.status) || isMissionStopRequested(afterDispatch)) {
      return { kind: "failed", error: afterDispatch.pauseReason ?? "Mission stop requested", fatal: true };
    }
    if (afterDispatch.status !== "running") {
      return { kind: "skipped-cursor", reason: afterDispatch.pauseReason ?? `Mission is ${afterDispatch.status}` };
    }
    if (!isStepCurrentOrFuture(afterDispatch, stepId)) {
      return { kind: "skipped-cursor", reason: `Step ${stepId} is no longer active` };
    }
    if (dispatched.kind === "in_progress") {
      if (dispatched.sublabel !== void 0) {
        safeEmit(sink, { type: "step.updated", missionId, at: Date.now(), stepId, sublabel: dispatched.sublabel });
      }
      return {
        kind: "in_progress",
        sessionRef: dispatched.sessionRef,
        pollAfterMs: dispatched.pollAfterMs,
        ...dispatched.sublabel === void 0 ? {} : { sublabel: dispatched.sublabel }
      };
    }
    if (dispatched.sublabel !== void 0) {
      safeEmit(sink, { type: "step.updated", missionId, at: Date.now(), stepId, sublabel: dispatched.sublabel });
    }
    const deltaUsd = dispatched.cost?.deltaUsd ?? estimateStepCostUsd(step);
    const chargeable = deltaUsd > 0 || Boolean(dispatched.cost?.ledgerDelta);
    const spentBefore = afterDispatch.spentUsd;
    const done = await service.setStepStatus(missionId, stepId, "done", {
      resultRef: dispatched.resultRef,
      ...dispatched.sublabel === void 0 ? {} : { sublabel: dispatched.sublabel },
      ...chargeable ? {
        cost: {
          deltaUsd,
          ledgerDelta: {
            costUsd: deltaUsd,
            llmCalls: 1,
            ...dispatched.cost?.ledgerDelta ?? {}
          }
        }
      } : {}
    });
    if (!done.succeeded) return rejectStep(done);
    if (done.value.spentUsd !== spentBefore) {
      safeEmit(sink, {
        type: "cost.updated",
        missionId,
        at: Date.now(),
        spentUsd: done.value.spentUsd,
        capUsd: done.value.budgetUsd
      });
    }
    safeEmit(sink, {
      type: "step.completed",
      missionId,
      at: Date.now(),
      stepId,
      ok: true,
      durationMs: Date.now() - startedAt
    });
    const advanced = await service.advanceCursor(missionId);
    if (!advanced.succeeded) return rejectStep(advanced);
    return { kind: "done", resultRef: dispatched.resultRef, cached: false };
  };
  async function parkForApproval(mission, step, reason) {
    const waiting = await service.markWaitingApproval(mission.id, step.id);
    if (!waiting.succeeded) {
      if (waiting.conflict) throw new MissionConcurrencyError(waiting.error);
      return { kind: "halted", status: mission.status, reason: waiting.error };
    }
    safeEmit(sink, {
      type: "mission.waiting_approval",
      missionId: mission.id,
      at: Date.now(),
      reason
    });
    safeEmit(sink, {
      type: "mission.plan.updated",
      missionId: mission.id,
      at: Date.now(),
      title: waiting.value.summary ?? "Mission",
      steps: waiting.value.plan.map((candidate) => ({
        id: candidate.id,
        intent: candidate.intent,
        kind: candidate.kind,
        status: candidate.status
      })),
      budgetUsd: waiting.value.budgetUsd
    });
    return { kind: "halted", status: "waiting_approval", reason };
  }
  async function enforceBudget(mission, step) {
    const capUsd = mission.budgetUsd;
    if (capUsd === null) return { kind: "continue" };
    const estimatedCostUsd = estimateStepCostUsd(step);
    if (estimatedCostUsd <= 0) return { kind: "continue" };
    if (Math.round((mission.spentUsd + estimatedCostUsd) * 100) <= Math.round(capUsd * 100)) {
      return { kind: "continue" };
    }
    if (!gates) {
      const reason = `Budget cap reached before step ${step.id}: $${mission.spentUsd.toFixed(2)} spent of $${capUsd.toFixed(2)}, next step estimated $${estimatedCostUsd.toFixed(2)}`;
      const paused = await pauseMission(mission.id, reason);
      if (!paused.succeeded) {
        if (paused.conflict) throw new MissionConcurrencyError(paused.error);
        return { kind: "halted", status: mission.status, reason: paused.error };
      }
      return { kind: "halted", status: paused.value.status, reason };
    }
    const proposalId = budgetGateProposalId(mission.id, step.id);
    const resolution = await gates.approvals.findResolution(proposalId);
    if (unblocked(resolution)) return { kind: "continue" };
    if (resolution === null) {
      await gates.approvals.createProposal({
        id: proposalId,
        missionId: mission.id,
        stepId: step.id,
        gate: "budget",
        mission,
        step,
        budget: { spentUsd: mission.spentUsd, budgetUsd: capUsd, estimatedCostUsd }
      });
    }
    return parkForApproval(mission, step, `Budget approval required for step ${step.id}`);
  }
  async function enforceVolumeCap(mission, step) {
    if (!gates) return { kind: "continue" };
    const overrideId = volumeGateProposalId(mission.id, step.id);
    const override = await gates.approvals.findResolution(overrideId);
    if (unblocked(override)) return { kind: "continue" };
    const externalCount = await gates.approvals.countExternalActionProposals(mission.id);
    if (externalCount < externalActionCap) return { kind: "continue" };
    if (override === null) {
      await gates.approvals.createProposal({
        id: overrideId,
        missionId: mission.id,
        stepId: step.id,
        gate: "volume",
        mission,
        step,
        volume: { externalActionCount: externalCount, cap: externalActionCap }
      });
    }
    return parkForApproval(mission, step, `External action cap approval required for step ${step.id}`);
  }
  async function enforceStepGate(mission, step) {
    if (!gates) return { kind: "continue" };
    const classification = gates.classifyStep(step);
    if (!classification) return { kind: "continue" };
    if (classification.externalAction) {
      const volume = await enforceVolumeCap(mission, step);
      if (volume.kind === "halted") return volume;
    }
    const proposalId = stepGateProposalId(mission.id, step.id);
    const resolution = await gates.approvals.findResolution(proposalId);
    if (unblocked(resolution)) return { kind: "continue" };
    if (resolution === null) {
      await gates.approvals.createProposal({
        id: proposalId,
        missionId: mission.id,
        stepId: step.id,
        gate: "step",
        mission,
        step,
        classification
      });
    }
    return parkForApproval(mission, step, `Approval required for step ${step.id}`);
  }
  const runPlan = async (missionId, runStepFn, planOptions = {}) => {
    const mission = await service.getMission(missionId);
    if (!mission) return { kind: "not-found" };
    if (isMissionTerminal(mission.status)) {
      safeEmit(sink, terminalMissionEvent(missionId, mission.status));
      return { kind: "terminal", status: mission.status };
    }
    while (true) {
      const currentMission = await service.getMission(missionId);
      if (!currentMission) return { kind: "not-found" };
      if (isMissionTerminal(currentMission.status)) {
        safeEmit(sink, terminalMissionEvent(missionId, currentMission.status));
        return { kind: "terminal", status: currentMission.status };
      }
      if (isMissionStopRequested(currentMission)) {
        return {
          kind: "halted",
          status: currentMission.status,
          reason: currentMission.pauseReason ?? "Mission stop requested"
        };
      }
      if (currentMission.status !== "running") {
        return {
          kind: "halted",
          status: currentMission.status,
          reason: currentMission.pauseReason
        };
      }
      const index = currentMission.cursor;
      if (index >= currentMission.plan.length) break;
      const step = currentMission.plan[index];
      if (!step) break;
      const haltReason = await planOptions.beforeStep?.(currentMission, step);
      if (haltReason) {
        const paused = await pauseMission(missionId, haltReason);
        if (!paused.succeeded) throw new MissionConcurrencyError(paused.error);
        return { kind: "halted", status: paused.value.status, reason: paused.value.pauseReason ?? haltReason };
      }
      if (step.status !== "done") {
        const budget = await enforceBudget(currentMission, step);
        if (budget.kind === "halted") {
          return { kind: "halted", status: budget.status, reason: budget.reason };
        }
        const gate = await enforceStepGate(currentMission, step);
        if (gate.kind === "halted") {
          return { kind: "halted", status: gate.status, reason: gate.reason };
        }
      }
      const outcome = await runStepFn(step, index);
      if (outcome.kind === "failed" && outcome.fatal) {
        safeEmit(sink, {
          type: "mission.completed",
          missionId,
          at: Date.now(),
          ok: false,
          summary: `Step ${step.id} failed: ${outcome.error}`
        });
        return { kind: "failed", failedStepId: step.id, error: outcome.error };
      }
      if (outcome.kind === "failed" && !outcome.fatal) {
        const advanced = await service.advanceCursor(missionId);
        if (!advanced.succeeded) throw new MissionConcurrencyError(advanced.error);
      }
      if (outcome.kind === "in_progress") {
        return {
          kind: "in_progress",
          stepId: step.id,
          sessionRef: outcome.sessionRef,
          pollAfterMs: outcome.pollAfterMs,
          ...outcome.sublabel === void 0 ? {} : { sublabel: outcome.sublabel }
        };
      }
    }
    const finalMission = await service.getMission(missionId);
    const planLength = finalMission?.plan.length ?? 0;
    const summary = `Completed ${planLength} step${planLength === 1 ? "" : "s"}`;
    const completed = await service.complete(missionId, { ok: true, summary });
    if (!completed.succeeded) {
      const after = await service.getMission(missionId);
      if (after && isMissionTerminal(after.status)) {
        safeEmit(sink, terminalMissionEvent(missionId, after.status));
        return { kind: "terminal", status: after.status };
      }
      throw new MissionConcurrencyError(completed.error);
    }
    safeEmit(sink, { type: "mission.completed", missionId, at: Date.now(), ok: true, summary });
    return { kind: "completed", summary };
  };
  return { runStep, runPlan, recordCost, pauseMission };
}

// src/missions/plan-parse.ts
var DEFAULT_MISSION_STEP_KINDS = [
  "research",
  "generate",
  "analyze",
  "write",
  "best-effort"
];
function parseMissionBlocks(fullContent, options = {}) {
  const kinds = new Set(options.kinds ?? DEFAULT_MISSION_STEP_KINDS);
  const missionRegex = /:::mission\s*\n([\s\S]*?)\n\s*:::/g;
  const missions = [];
  let match;
  while ((match = missionRegex.exec(fullContent)) !== null) {
    const body = match[1];
    if (body === void 0) continue;
    const parsed = parseMissionBody(body, kinds);
    if (parsed) missions.push(parsed);
  }
  return missions;
}
function parseMissionBody(body, kinds) {
  let title = null;
  const steps = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const titleMatch = /^title\s*:\s*(.+)$/i.exec(line);
    if (titleMatch?.[1] !== void 0) {
      if (title === null) title = titleMatch[1].trim();
      continue;
    }
    const stepMatch = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*:\s*([A-Za-z-]+)\s*\|\s*(.+)$/.exec(line);
    if (!stepMatch) continue;
    const id = stepMatch[1]?.trim();
    const kind = stepMatch[2]?.trim().toLowerCase();
    const intent = stepMatch[3]?.trim();
    if (!id || !kind || !intent) continue;
    if (!kinds.has(kind)) continue;
    steps.push({ id, kind, intent });
  }
  if (!title || steps.length === 0) return null;
  return { title, steps };
}
function buildAgentMissionPlan(steps) {
  if (steps.length === 0) throw new Error("mission plan must have at least one step");
  const seen = /* @__PURE__ */ new Set();
  for (const step of steps) {
    if (seen.has(step.id)) {
      throw new Error(`duplicate mission step id "${step.id}" \u2014 step ids must be unique`);
    }
    seen.add(step.id);
  }
  return steps.map((step) => ({
    id: step.id,
    intent: step.intent,
    kind: step.kind,
    status: "pending",
    attempts: 0
  }));
}

// src/missions/agent-activity.ts
function stepAgentActivity(step) {
  const value = step.agentActivity;
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry;
    if (typeof record.taskId !== "string" || typeof record.tool !== "string" || typeof record.status !== "string" || typeof record.detail !== "string" || typeof record.startedAt !== "string") {
      continue;
    }
    items.push({
      taskId: record.taskId,
      tool: record.tool,
      status: record.status,
      detail: record.detail,
      startedAt: record.startedAt,
      ...typeof record.costUsd === "number" && Number.isFinite(record.costUsd) ? { costUsd: record.costUsd } : {},
      ...typeof record.durationMs === "number" && Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {},
      ...typeof record.iteration === "number" && Number.isFinite(record.iteration) ? { iteration: record.iteration } : {},
      ...typeof record.phase === "string" ? { phase: record.phase } : {},
      ...typeof record.traceId === "string" ? { traceId: record.traceId } : {},
      ...typeof record.spanId === "string" ? { spanId: record.spanId } : {}
    });
  }
  return items;
}
export {
  DEFAULT_MISSION_STEP_KINDS,
  MISSION_CONTROL_CHANNEL_ID,
  MissionConcurrencyError,
  RetryableStepError,
  applyMissionEvent,
  asMissionStreamEvent,
  budgetGateProposalId,
  buildAgentMissionPlan,
  createInMemoryMissionStore,
  createMissionEngine,
  createMissionService,
  isMissionStopRequested,
  isMissionTerminal,
  mergeMissionState,
  noopEventSink,
  parseMissionBlocks,
  parseSessionStreamEnvelope,
  reduceMissionEvents,
  stepAgentActivity,
  stepGateProposalId,
  volumeGateProposalId
};
//# sourceMappingURL=index.js.map