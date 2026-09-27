import {
  composeMissionFlowTrace,
  delegationActivityToFlowSpans,
  loopTraceEventsToFlowSpans,
  stepActivityFlowTrace
} from "../chunk-FBVLEGEG.js";

// src/trace/mission-trace.ts
function createMissionTraceContext(missionId) {
  if (missionId !== void 0 && missionId !== "") {
    return {
      traceId: hex64(fnv1a64(`mission-trace:${missionId}`)) + hex64(fnv1a64(`mission-trace:2:${missionId}`)),
      rootSpanId: hex64(fnv1a64(`mission-root-span:${missionId}`))
    };
  }
  return { traceId: randomHex(16), rootSpanId: randomHex(8) };
}
function childSpanContext(parent, seed) {
  const parentSpanId = "rootSpanId" in parent ? parent.rootSpanId : parent.spanId;
  const spanId = seed !== void 0 && seed !== "" ? hex64(fnv1a64(`span:${parent.traceId}:${parentSpanId}:${seed}`)) : randomHex(8);
  return { traceId: parent.traceId, spanId, parentSpanId };
}
function traceEnv(ctx) {
  return {
    TRACE_ID: ctx.traceId,
    PARENT_SPAN_ID: "rootSpanId" in ctx ? ctx.rootSpanId : ctx.spanId
  };
}
var FNV_OFFSET = 0xcbf29ce484222325n;
var FNV_PRIME = 0x100000001b3n;
var MASK_64 = 0xffffffffffffffffn;
function fnv1a64(input) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = hash * FNV_PRIME & MASK_64;
  }
  return hash;
}
function hex64(value) {
  return value.toString(16).padStart(16, "0");
}
function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/trace/stage-timing.ts
var STAGE_TIMING_EVENT = "stage_timing";
var STAGE_TIMING_VERSION = 1;
var MAX_STAGE_LENGTH = 80;
var MAX_IDENTIFIER_LENGTH = 128;
var MAX_DETAIL_KEYS = 8;
var MAX_DETAIL_KEY_LENGTH = 64;
var MAX_DETAIL_STRING_LENGTH = 64;
var SENSITIVE_KEY = /(?:api|auth|access|refresh|session|private|secret|password|credential|cookie|bearer|token|ssn|ein|email|phone)[_-]?(?:key|token|secret)?/iu;
var CREDENTIAL_VALUE = /\b(?:bearer|basic|digest|token)\s+\S+|\bapi[-_ ]?key\s*[:=]\s*\S+/iu;
function boundedIdentifier(value) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_IDENTIFIER_LENGTH) : void 0;
}
function safeProperty(value, key) {
  try {
    return Reflect.get(value, key);
  } catch {
    return void 0;
  }
}
function isObject(value) {
  return value !== null && typeof value === "object";
}
function sanitizeDetail(detail) {
  try {
    if (!isObject(detail) || Array.isArray(detail)) return void 0;
    const entries = [];
    for (const [rawKey, value] of Object.entries(detail)) {
      if (entries.length >= MAX_DETAIL_KEYS) break;
      const normalizedKey = rawKey.trim();
      if (!normalizedKey || SENSITIVE_KEY.test(normalizedKey) || value === void 0) {
        continue;
      }
      const key = normalizedKey.slice(0, MAX_DETAIL_KEY_LENGTH);
      if (typeof value === "string") {
        if (CREDENTIAL_VALUE.test(value)) continue;
        entries.push([key, value.slice(0, MAX_DETAIL_STRING_LENGTH)]);
      } else if (typeof value === "number") {
        entries.push([key, Number.isFinite(value) ? value : null]);
      } else if (typeof value === "boolean" || value === null) {
        entries.push([key, value]);
      }
    }
    return entries.length > 0 ? Object.fromEntries(entries) : void 0;
  } catch {
    return void 0;
  }
}
function isStageTimingKind(value) {
  return value === "leaf" || value === "span";
}
function isStageTimingOutcome(value) {
  return value === "ok" || value === "error" || value === "timeout" || value === "skipped";
}
function buildStageTimingRecord(context, stage, startedAt, durationMs, input = {}) {
  try {
    const name = typeof stage === "string" ? stage.trim() : "";
    if (!name || !Number.isFinite(startedAt) || startedAt < 0 || !Number.isFinite(durationMs) || durationMs < 0 || !isObject(context) || !isObject(input)) {
      return null;
    }
    const rawKind = safeProperty(input, "kind");
    const rawOutcome = safeProperty(input, "outcome");
    const kind = rawKind === void 0 ? "leaf" : rawKind;
    const outcome = rawOutcome === void 0 ? "ok" : rawOutcome;
    if (!isStageTimingKind(kind) || !isStageTimingOutcome(outcome)) return null;
    const runId = boundedIdentifier(safeProperty(context, "runId"));
    if (!runId) return null;
    const record = {
      evt: STAGE_TIMING_EVENT,
      v: STAGE_TIMING_VERSION,
      stage: name.slice(0, MAX_STAGE_LENGTH),
      kind,
      startedAt: Math.round(startedAt),
      durationMs: Math.round(durationMs),
      outcome,
      runId
    };
    for (const key of [
      "workspaceId",
      "threadId",
      "sandboxId",
      "model",
      "harness",
      "path"
    ]) {
      const value = boundedIdentifier(safeProperty(context, key));
      if (value) record[key] = value;
    }
    const attempt = safeProperty(input, "attempt");
    if (typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 0) {
      record.attempt = attempt;
    }
    const detail = sanitizeDetail(safeProperty(input, "detail"));
    if (detail) record.detail = detail;
    return record;
  } catch {
    return null;
  }
}
function safePrimitiveText(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && typeof value !== "bigint" && typeof value !== "symbol") {
    return "";
  }
  try {
    return String(value);
  } catch {
    return "";
  }
}
function outcomeForError(error) {
  try {
    const objectLike = isObject(error) || typeof error === "function";
    const code = objectLike ? safePrimitiveText(safeProperty(error, "code")) : "";
    const message = objectLike ? safePrimitiveText(safeProperty(error, "message")) : safePrimitiveText(error);
    return /timeout|timed ?out|deadline/iu.test(`${code} ${message}`) ? "timeout" : "error";
  } catch {
    return "error";
  }
}
function safeClock(now) {
  try {
    const value = now();
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
  } catch {
    return void 0;
  }
}
function safeObject(value) {
  try {
    if (!isObject(value) || Array.isArray(value)) return {};
    return { ...value };
  } catch {
    return {};
  }
}
function mergeInputs(base, extra) {
  const baseObject = safeObject(base);
  const extraObject = safeObject(extra);
  const detail = {
    ...safeObject(baseObject.detail),
    ...safeObject(extraObject.detail)
  };
  return {
    ...baseObject,
    ...extraObject,
    detail
  };
}
function withOutcome(extra, outcome) {
  return { ...safeObject(extra), outcome };
}
function createStageTiming(options) {
  const now = options.now ?? (() => Date.now());
  const generatedRunId = () => {
    try {
      const value = (options.createRunId ?? (() => crypto.randomUUID()))();
      return boundedIdentifier(value) ?? crypto.randomUUID();
    } catch {
      try {
        return crypto.randomUUID();
      } catch {
        return "run-unknown";
      }
    }
  };
  const context = {
    ...options.context,
    runId: boundedIdentifier(options.context?.runId) ?? generatedRunId()
  };
  const emit = (stage, startedAt, durationMs, input = {}) => {
    try {
      const record = buildStageTimingRecord(context, stage, startedAt, durationMs, input);
      if (!record) return;
      const result = options.emit(record);
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => void 0);
      }
    } catch {
    }
  };
  const start = (stage, input = {}) => {
    const observedStart = safeClock(now);
    const startedAt = observedStart ?? 0;
    let emitted = false;
    const finish = (extra = {}) => {
      if (emitted) return;
      emitted = true;
      if (observedStart === void 0) return;
      const observedEnd = safeClock(now);
      if (observedEnd === void 0) return;
      try {
        emit(stage, observedStart, observedEnd - observedStart, mergeInputs(input, extra));
      } catch {
      }
    };
    return {
      startedAt,
      done: finish,
      fail(error, extra = {}) {
        let outcome = "error";
        try {
          outcome = outcomeForError(error);
        } catch {
        }
        finish(withOutcome(extra, outcome));
      }
    };
  };
  return {
    context,
    setContext(input) {
      try {
        Object.assign(context, input);
      } catch {
      }
    },
    recordDuration(stage, startedAt, durationMs, input = {}) {
      emit(stage, startedAt, durationMs, input);
    },
    start,
    async measure(stage, input, operation) {
      const handle = start(stage, input);
      try {
        const value = await operation();
        handle.done();
        return value;
      } catch (error) {
        handle.fail(error);
        throw error;
      }
    }
  };
}

// src/trace/index.ts
function timedEventsFromLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed._t === "number") out.push({ t: parsed._t, event: parsed });
    } catch {
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
function innerOf(e) {
  return (e.kind === "event" ? e.event : e) ?? {};
}
function buildFlowTrace(events, opts) {
  const spans = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls = 0;
  const first = events[0]?.t ?? 0;
  if (first > 0) {
    spans.push({ kind: "pipeline", name: "dispatch \u2192 first event", startMs: 0, endMs: first });
  }
  let segStart = null;
  let segEnd = 0;
  let segKinds = /* @__PURE__ */ new Set();
  let lastDeltaT = first;
  const openCalls = /* @__PURE__ */ new Map();
  const closeSegment = () => {
    if (segStart !== null) {
      spans.push({
        kind: "model",
        name: segKinds.has("reasoning") ? "model turn (reasoning + text)" : "model turn",
        startMs: segStart,
        endMs: segEnd,
        approx: true
      });
      segStart = null;
      segKinds = /* @__PURE__ */ new Set();
    }
  };
  for (const { t, event } of events) {
    const inner = innerOf(event);
    const type = String(event.kind === "tool_result" ? "tool_result" : inner.type ?? "");
    if (type === "text" || type === "reasoning") {
      if (segStart === null) segStart = t;
      segEnd = t;
      segKinds.add(type);
      lastDeltaT = t;
    } else if (type === "tool_call") {
      closeSegment();
      toolCalls++;
      const call = inner.call ?? inner;
      const id = String(call.toolCallId ?? `call_${toolCalls}`);
      openCalls.set(id, { name: String(call.toolName ?? "tool"), emitT: t, lastDeltaT });
    } else if (type === "tool_result") {
      const id = String(event.toolCallId ?? inner.toolCallId ?? "");
      const open = openCalls.get(id);
      if (open) {
        spans.push({
          kind: "tool",
          name: open.name,
          // Execution happens between the end of the model turn that emitted
          // the call and the result landing in the buffer.
          startMs: open.lastDeltaT,
          endMs: t,
          approx: true,
          meta: { ok: (event.outcome ?? inner.outcome)?.ok }
        });
        openCalls.delete(id);
      }
    } else if (type === "usage") {
      const u = inner.usage ?? {};
      promptTokens += u.promptTokens ?? 0;
      completionTokens += u.completionTokens ?? 0;
    }
  }
  closeSegment();
  const totalMs = events.length ? events[events.length - 1].t : 0;
  const trace = { spans, totalMs, promptTokens, completionTokens, toolCalls };
  const p = opts?.pricing;
  if (p && (p.prompt != null || p.completion != null)) {
    trace.costUsd = promptTokens * Number(p.prompt ?? 0) + completionTokens * Number(p.completion ?? 0);
  }
  return trace;
}
var fmtS = (ms) => `${(ms / 1e3).toFixed(1)}s`;
function renderWaterfall(trace, opts) {
  const width = opts?.width ?? 40;
  const scale = trace.totalMs > 0 ? width / trace.totalMs : 0;
  const lines = [];
  const spans = [...trace.spans].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    const offset = Math.round(s.startMs * scale);
    const len = Math.max(1, Math.round((s.endMs - s.startMs) * scale));
    const bar = " ".repeat(offset) + (s.kind === "tool" ? "\u2593" : s.kind === "pipeline" ? "\u2591" : "\u2588").repeat(len);
    const branch = i === spans.length - 1 ? "\u2514\u2500" : "\u251C\u2500";
    const dur = `${fmtS(s.endMs - s.startMs)}${s.approx ? "~" : ""}`;
    lines.push(`${fmtS(s.startMs).padStart(7)} ${branch} ${bar.padEnd(width + 2)} ${s.name} (${dur})`);
  }
  const cost = trace.costUsd != null ? `  $${trace.costUsd.toFixed(trace.costUsd < 0.01 ? 6 : 4)}` : "";
  lines.push(
    `${fmtS(trace.totalMs).padStart(7)} \u2500\u2500 total \xB7 ${trace.promptTokens}p + ${trace.completionTokens}c tok \xB7 ${trace.toolCalls} tool calls${cost}`
  );
  return lines.join("\n");
}
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { n: sorted.length, min: sorted[0] ?? 0, p50: q(0.5), p90: q(0.9), max: sorted[sorted.length - 1] ?? 0 };
}
function renderHistogram(values, opts) {
  if (!values.length) return "(no samples)";
  const buckets = opts?.buckets ?? 6;
  const width = opts?.width ?? 24;
  const fmt = opts?.format ?? ((v) => `${Math.round(v)}${opts?.unit ?? ""}`);
  const s = summarize(values);
  const lo = s.min;
  const hi = s.max === s.min ? s.min + 1 : s.max;
  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    counts[Math.min(buckets - 1, Math.floor((v - lo) / (hi - lo) * buckets))]++;
  }
  const maxCount = Math.max(...counts);
  const lines = [
    `n=${s.n}  min=${fmt(s.min)}  p50=${fmt(s.p50)}  p90=${fmt(s.p90)}  max=${fmt(s.max)}`
  ];
  for (let i = 0; i < buckets; i++) {
    const a = lo + (hi - lo) * i / buckets;
    const b = lo + (hi - lo) * (i + 1) / buckets;
    const bar = "\u2588".repeat(Math.max(counts[i] > 0 ? 1 : 0, Math.round(counts[i] / maxCount * width)));
    lines.push(`${fmt(a).padStart(8)}-${fmt(b).padEnd(8)} ${bar} ${counts[i]}`);
  }
  return lines.join("\n");
}
export {
  STAGE_TIMING_EVENT,
  STAGE_TIMING_VERSION,
  buildFlowTrace,
  buildStageTimingRecord,
  childSpanContext,
  composeMissionFlowTrace,
  createMissionTraceContext,
  createStageTiming,
  delegationActivityToFlowSpans,
  loopTraceEventsToFlowSpans,
  renderHistogram,
  renderWaterfall,
  stepActivityFlowTrace,
  summarize,
  timedEventsFromLines,
  traceEnv
};
//# sourceMappingURL=index.js.map