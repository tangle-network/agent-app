// src/trace/mission-flow.ts
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var str = (v) => typeof v === "string" && v.length > 0 ? v : void 0;
var rec = (v) => v && typeof v === "object" ? v : {};
var LIVE_DELEGATION_STATUSES = /* @__PURE__ */ new Set(["pending", "running"]);
function delegationActivityToFlowSpans(activity, turnStartMs, opts) {
  const spans = [];
  for (const run of activity) {
    const startedAt = Date.parse(run.startedAt);
    if (!Number.isFinite(startedAt)) continue;
    const startMs = startedAt - turnStartMs;
    const live = LIVE_DELEGATION_STATUSES.has(run.status);
    const endMs = run.durationMs !== void 0 ? startMs + run.durationMs : live && opts?.nowMs !== void 0 ? opts.nowMs - turnStartMs : startMs;
    spans.push({
      kind: "tool",
      name: `${run.tool} \u2014 ${run.detail}`,
      startMs,
      endMs: Math.max(endMs, startMs),
      ...run.durationMs === void 0 ? { approx: true } : {},
      meta: {
        taskId: run.taskId,
        status: run.status,
        ...run.costUsd !== void 0 ? { costUsd: run.costUsd } : {},
        ...run.iteration !== void 0 ? { iteration: run.iteration } : {},
        ...run.phase !== void 0 ? { phase: run.phase } : {},
        ...run.traceId !== void 0 ? { traceId: run.traceId } : {},
        ...run.spanId !== void 0 ? { spanId: run.spanId } : {}
      }
    });
  }
  return spans;
}
function loopTraceEventsToFlowSpans(events) {
  if (events.length === 0) return [];
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const started = ordered.find((e) => e.kind === "loop.started");
  const ended = ordered.find((e) => e.kind === "loop.ended");
  const origin = started?.timestamp ?? ordered[0].timestamp;
  const rootEnd = ended?.timestamp ?? ordered[ordered.length - 1].timestamp;
  const t = (epochMs) => epochMs - origin;
  const spans = [];
  const sp = rec(started?.payload);
  const ep = rec(ended?.payload);
  spans.push({
    kind: "pipeline",
    name: "loop",
    startMs: 0,
    endMs: t(rootEnd),
    meta: {
      runId: ordered[0].runId,
      ...str(sp.driver) !== void 0 ? { driver: str(sp.driver) } : {},
      ...num(ep.totalCostUsd) !== void 0 ? { costUsd: num(ep.totalCostUsd) } : {},
      ...num(ep.winnerIterationIndex) !== void 0 ? { winnerIterationIndex: num(ep.winnerIterationIndex) } : {},
      ...num(ep.iterations) !== void 0 ? { iterations: num(ep.iterations) } : {}
    }
  });
  const iterStart = /* @__PURE__ */ new Map();
  let round;
  const flushRound = (endEpochMs) => {
    if (!round) return;
    spans.push({
      kind: "pipeline",
      name: `loop \u25B8 round ${round.index} (${round.moveKind})`,
      startMs: round.startMs,
      endMs: t(endEpochMs),
      meta: round.meta
    });
    round = void 0;
  };
  for (const e of ordered) {
    const p = rec(e.payload);
    switch (e.kind) {
      case "loop.plan": {
        flushRound(e.timestamp);
        const index = num(p.roundIndex) ?? 0;
        round = {
          index,
          startMs: t(e.timestamp),
          moveKind: str(p.moveKind) ?? "unknown",
          meta: {
            roundIndex: index,
            moveKind: str(p.moveKind) ?? "unknown",
            width: num(p.plannedCount) ?? 0,
            ...str(p.rationale) !== void 0 ? { rationale: str(p.rationale) } : {},
            ...num(p.parentIndex) !== void 0 ? { parentIndex: num(p.parentIndex) } : {}
          }
        };
        break;
      }
      case "loop.iteration.started": {
        const idx = num(p.iterationIndex);
        if (idx !== void 0) iterStart.set(idx, e.timestamp);
        break;
      }
      case "loop.iteration.ended": {
        const idx = num(p.iterationIndex) ?? 0;
        const startEpoch = iterStart.get(idx) ?? e.timestamp;
        const error = str(p.error);
        const verdict = rec(p.verdict);
        const tokens = rec(p.tokenUsage);
        const roundLabel = round ? `round ${round.index} \u25B8 ` : "";
        spans.push({
          kind: "model",
          name: `loop \u25B8 ${roundLabel}iter ${idx} (${str(p.agentRunName) ?? "agent"})`,
          startMs: t(startEpoch),
          endMs: t(e.timestamp),
          meta: {
            iterationIndex: idx,
            ok: error === void 0,
            ...error !== void 0 ? { error } : {},
            ...num(p.costUsd) !== void 0 ? { costUsd: num(p.costUsd) } : {},
            ...typeof verdict.valid === "boolean" ? { verdictValid: verdict.valid } : {},
            ...num(verdict.score) !== void 0 ? { verdictScore: num(verdict.score) } : {},
            ...num(tokens.input) !== void 0 ? { inputTokens: num(tokens.input) } : {},
            ...num(tokens.output) !== void 0 ? { outputTokens: num(tokens.output) } : {}
          }
        });
        break;
      }
      case "loop.decision": {
        if (round) {
          const decision = str(p.decision);
          if (decision !== void 0) round.meta.decision = decision;
          flushRound(e.timestamp);
        }
        break;
      }
    }
  }
  flushRound(rootEnd);
  return spans;
}
function stepActivityFlowTrace(activity, opts) {
  let origin = opts?.startedAt;
  if (origin === void 0) {
    for (const run of activity) {
      const parsed = Date.parse(run.startedAt);
      if (Number.isFinite(parsed) && (origin === void 0 || parsed < origin)) origin = parsed;
    }
  }
  const spans = delegationActivityToFlowSpans(
    activity,
    origin ?? 0,
    opts?.nowMs !== void 0 ? { nowMs: opts.nowMs } : void 0
  );
  let costUsd;
  for (const span of spans) {
    const c = num(rec(span.meta).costUsd);
    if (c !== void 0) costUsd = (costUsd ?? 0) + c;
  }
  return {
    spans,
    totalMs: spans.reduce((max, s) => Math.max(max, s.endMs), 0),
    promptTokens: 0,
    completionTokens: 0,
    ...costUsd !== void 0 ? { costUsd } : {},
    toolCalls: spans.length
  };
}
function composeMissionFlowTrace(input) {
  const activity = input.activity ?? {};
  const startCandidates = [];
  if (input.startedAt !== void 0) startCandidates.push(input.startedAt);
  else {
    for (const step of input.steps) {
      if (step.startedAt !== void 0) startCandidates.push(step.startedAt);
    }
    for (const runs of Object.values(activity)) {
      for (const run of runs) {
        const parsed = Date.parse(run.startedAt);
        if (Number.isFinite(parsed)) startCandidates.push(parsed);
      }
    }
  }
  const origin = startCandidates.length > 0 ? Math.min(...startCandidates) : 0;
  const spans = [];
  let costUsd;
  let toolCalls = 0;
  let cursorMs = 0;
  for (const step of input.steps) {
    const inferred = step.startedAt === void 0;
    const startMs = inferred ? cursorMs : step.startedAt - origin;
    const runSpans = delegationActivityToFlowSpans(activity[step.id] ?? [], origin);
    const runExtent = runSpans.reduce((max, s) => Math.max(max, s.endMs), startMs);
    const endMs = Math.max(step.durationMs !== void 0 ? startMs + step.durationMs : startMs, runExtent);
    spans.push({
      kind: "pipeline",
      name: step.intent,
      startMs,
      endMs,
      ...inferred || step.durationMs === void 0 ? { approx: true } : {},
      meta: { stepId: step.id, ...step.status !== void 0 ? { status: step.status } : {} }
    });
    for (const span of runSpans) {
      spans.push({ ...span, name: `${step.intent} \u25B8 ${span.name}` });
      toolCalls++;
      const c = num(rec(span.meta).costUsd);
      if (c !== void 0) costUsd = (costUsd ?? 0) + c;
    }
    cursorMs = endMs;
  }
  return {
    spans,
    totalMs: spans.reduce((max, s) => Math.max(max, s.endMs), 0),
    promptTokens: 0,
    completionTokens: 0,
    ...costUsd !== void 0 ? { costUsd } : {},
    toolCalls
  };
}

export {
  delegationActivityToFlowSpans,
  loopTraceEventsToFlowSpans,
  stepActivityFlowTrace,
  composeMissionFlowTrace
};
//# sourceMappingURL=chunk-FBVLEGEG.js.map