import {
  canTransitionInteractionStatus,
  persistedPartToInteraction
} from "./chunk-M3K2HVQD.js";
import {
  canTransitionPlanStatus,
  persistedPartToPlan,
  planPartKey,
  planToPersistedPart
} from "./chunk-YJMCRXQQ.js";

// src/stream/stream-normalizer.ts
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function resolveToolId(part) {
  return String(
    part.id ?? part.callID ?? part.callId ?? part.toolUseId ?? part.toolCallId ?? part.tool ?? part.name ?? `tool-${Date.now()}`
  );
}
function resolveToolName(part) {
  return String(part.tool ?? part.name ?? "tool");
}
function normalizeTime(value) {
  const record = asRecord(value);
  if (!record) return void 0;
  const start = Number(record.start ?? record.startedAt ?? record.started_at);
  const end = Number(record.end ?? record.completedAt ?? record.completed_at);
  if (!Number.isFinite(start) && !Number.isFinite(end)) return void 0;
  return {
    start: Number.isFinite(start) ? start : void 0,
    end: Number.isFinite(end) ? end : void 0
  };
}
var TOOL_EXIT_KEYS = ["exitCode", "exit"];
function toolExitCode(...values) {
  for (const value of values) {
    const record = asRecord(value);
    if (!record) continue;
    for (const key of TOOL_EXIT_KEYS) {
      const exitCode = record[key];
      if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
    }
  }
  return void 0;
}
function toolExitError(output, exitCode) {
  if (exitCode === void 0 || exitCode === 0) return void 0;
  return asString(asRecord(output)?.stderr) ?? `Command exited with code ${exitCode}.`;
}
function normalizeToolEvent(event) {
  if (event.type === "tool_call" || event.type === "tool.call") {
    const data = event.data ?? {};
    return {
      type: "message.part.updated",
      data: {
        part: {
          type: "tool",
          id: data.id ?? data.callId ?? data.callID ?? data.name,
          tool: data.name ?? data.tool ?? "tool",
          input: data.arguments ?? data.input,
          status: "running"
        }
      }
    };
  }
  if (event.type === "tool_result" || event.type === "tool.result") {
    const data = event.data ?? {};
    const state = asRecord(data.state);
    const output = data.output;
    const exitCode = toolExitCode(output, data, data.metadata, state, state?.metadata);
    const error = asString(data.error ?? state?.error) ?? toolExitError(output, exitCode);
    const terminalError = data.status === "error" || data.status === "failed" || state?.status === "error" || state?.status === "failed" || Boolean(error) || exitCode !== void 0 && exitCode !== 0;
    return {
      type: "message.part.updated",
      data: {
        part: {
          type: "tool",
          id: data.id ?? data.callId ?? data.callID ?? data.name,
          tool: data.name ?? data.tool ?? "tool",
          output,
          error,
          status: terminalError ? "error" : "completed"
        }
      }
    };
  }
  return event;
}
function normalizePersistedPart(rawPart) {
  const type = String(rawPart.type ?? "");
  if (type === "text") {
    const id = asString(rawPart.id) ?? asString(rawPart.partId);
    return {
      type: "text",
      text: asString(rawPart.text) ?? asString(rawPart.content) ?? "",
      // id: per-segment identity from the harness; absent on legacy parts,
      // which collapse to a single keyed segment. Never invented here.
      ...id ? { id } : {}
    };
  }
  if (type === "reasoning") {
    const id = asString(rawPart.id) ?? asString(rawPart.partId);
    return {
      type: "reasoning",
      text: asString(rawPart.text) ?? asString(rawPart.content) ?? "",
      time: normalizeTime(rawPart.time),
      ...id ? { id } : {}
    };
  }
  if (type === "file" || type === "image") {
    const id = asString(rawPart.id) ?? asString(rawPart.partId);
    return {
      type,
      ...id ? { id } : {},
      ...asString(rawPart.filename) ? { filename: asString(rawPart.filename) } : {},
      // `name`: the durable attachment display name `promoteAgentFilePart`
      // writes. Coexists with `filename` (legacy raw-harness shape) — kept
      // separate rather than unified so neither producer's shape is lossy.
      ...asString(rawPart.name) ? { name: asString(rawPart.name) } : {},
      ...asString(rawPart.mediaType) ? { mediaType: asString(rawPart.mediaType) } : {},
      ...asString(rawPart.url) ? { url: asString(rawPart.url) } : {},
      ...asString(rawPart.path) ? { path: asString(rawPart.path) } : {},
      ...type === "file" && asString(rawPart.content) ? { content: asString(rawPart.content) } : {},
      ...typeof rawPart.size === "number" && Number.isFinite(rawPart.size) ? { size: rawPart.size } : {}
    };
  }
  if (type === "step-start") {
    return { type: "step-start" };
  }
  if (type === "step-finish") {
    const tokens = asRecord(rawPart.tokens);
    const cost = Number(rawPart.cost);
    return {
      type: "step-finish",
      ...asString(rawPart.reason) ? { reason: asString(rawPart.reason) } : {},
      ...tokens ? { tokens } : {},
      ...Number.isFinite(cost) ? { cost } : {}
    };
  }
  if (type === "subtask") {
    const id = asString(rawPart.id) ?? asString(rawPart.partId);
    return {
      type: "subtask",
      prompt: asString(rawPart.prompt) ?? "",
      description: asString(rawPart.description) ?? "",
      agent: asString(rawPart.agent) ?? "",
      ...id ? { id } : {}
    };
  }
  if (type === "interaction") {
    return persistedPartToInteraction(rawPart) ? rawPart : null;
  }
  if (type === "plan") {
    const plan = persistedPartToPlan(rawPart);
    return plan ? { ...rawPart, ...planToPersistedPart(plan) } : null;
  }
  if (type === "notice") {
    return rawPart;
  }
  if (type === "tool") {
    const state = asRecord(rawPart.state);
    const output = state?.output ?? rawPart.output;
    const exitCode = toolExitCode(output, state, state?.metadata, rawPart, rawPart.metadata);
    const error = asString(state?.error ?? rawPart.error) ?? toolExitError(output, exitCode);
    const terminalError = state?.status === "error" || state?.status === "failed" || rawPart.status === "error" || rawPart.status === "failed" || Boolean(error) || exitCode !== void 0 && exitCode !== 0;
    const status = terminalError ? "error" : state?.status === "completed" || rawPart.status === "completed" ? "completed" : output !== void 0 ? "completed" : "running";
    return {
      type: "tool",
      id: resolveToolId(rawPart),
      tool: resolveToolName(rawPart),
      callID: rawPart.callID != null || rawPart.callId != null ? String(rawPart.callID ?? rawPart.callId) : void 0,
      state: {
        status,
        input: state?.input ?? rawPart.input,
        output,
        error,
        metadata: asRecord(state?.metadata) ?? asRecord(rawPart.metadata),
        time: normalizeTime(state?.time ?? rawPart.time)
      }
    };
  }
  return null;
}
function attachmentPartKey(path) {
  return `attachment:${path}`;
}
function getPartKey(part) {
  const type = String(part.type ?? "unknown");
  if (type === "tool") {
    return `tool:${resolveToolId(part)}`;
  }
  if (type === "plan") return planPartKey(String(part.planId ?? ""));
  if ((type === "file" || type === "image") && asString(part.path)) {
    return attachmentPartKey(String(part.path));
  }
  const lane = type && type !== "unknown" ? type : "text";
  return `${lane}:${String(part.id ?? part.partId ?? part.index ?? "current")}`;
}
function overlayDefined(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== void 0) out[key] = value;
  }
  return out;
}
function mergePersistedPart(existing, incoming, delta) {
  const type = String(incoming.type ?? "");
  if (!existing) {
    if (type === "text" && delta) {
      return { type: "text", text: delta };
    }
    return incoming;
  }
  if (type === "text" && String(existing.type ?? "") === "text") {
    const existingText = String(existing.text ?? "");
    const incomingText = String(incoming.text ?? "");
    return {
      ...existing,
      ...incoming,
      // An empty snapshot never erases accumulated text (matches reasoning).
      text: delta ? `${existingText}${delta}` : incomingText || existingText
    };
  }
  if (type === "reasoning" && String(existing.type ?? "") === "reasoning") {
    const existingText = String(existing.text ?? "");
    const incomingText = String(incoming.text ?? "");
    return {
      ...existing,
      ...incoming,
      text: delta && incomingText === existingText ? `${existingText}${delta}` : incomingText || existingText,
      time: incoming.time ?? existing.time
    };
  }
  if (type === "tool" && String(existing.type ?? "") === "tool") {
    const existingState = asRecord(existing.state) ?? {};
    const incomingState = asRecord(incoming.state) ?? {};
    const mergedState = overlayDefined(existingState, incomingState);
    const existingStatus = String(existingState.status ?? "");
    if ((existingStatus === "completed" || existingStatus === "error") && String(incomingState.status ?? "") === "running") {
      mergedState.status = existingStatus;
    }
    return {
      ...overlayDefined(existing, incoming),
      state: mergedState
    };
  }
  if (type === "interaction" && String(existing.type ?? "") === "interaction") {
    const merged = overlayDefined(existing, incoming);
    const existingStatus = existing.status;
    const incomingStatus = incoming.status;
    if (existingStatus && incomingStatus && existingStatus !== incomingStatus && !canTransitionInteractionStatus(existingStatus, incomingStatus)) {
      merged.status = existingStatus;
    }
    if (incoming.answers === void 0 && existing.answers !== void 0) {
      merged.answers = existing.answers;
    }
    return merged;
  }
  if (type === "plan" && String(existing.type ?? "") === "plan") {
    const existingRevision = Number(existing.revision);
    const incomingRevision = Number(incoming.revision);
    if (Number.isInteger(existingRevision) && Number.isInteger(incomingRevision)) {
      if (incomingRevision < existingRevision) return existing;
      if (incomingRevision > existingRevision) return incoming;
    }
    const merged = overlayDefined(existing, incoming);
    const existingStatus = existing.status;
    const incomingStatus = incoming.status;
    if (existingStatus && incomingStatus && existingStatus !== incomingStatus && !canTransitionPlanStatus(existingStatus, incomingStatus)) {
      merged.status = existingStatus;
    }
    return merged;
  }
  return incoming;
}
var MISSING_TOOL_TERMINAL_ERROR = "Tool did not report a terminal result before the assistant turn completed.";
var MISSING_TOOL_TERMINAL_REASON = "missing-tool-terminal";
function terminalizeDanglingToolPart(part) {
  if (String(part.type ?? "") !== "tool") return part;
  const state = asRecord(part.state) ?? {};
  if (String(state.status ?? part.status ?? "") !== "running") return part;
  const metadata = asRecord(state.metadata) ?? {};
  return {
    ...part,
    state: {
      ...state,
      status: "error",
      error: asString(state.error ?? part.error) ?? MISSING_TOOL_TERMINAL_ERROR,
      metadata: {
        ...metadata,
        terminalized: true,
        terminalReason: MISSING_TOOL_TERMINAL_REASON
      }
    }
  };
}
function terminalizeDanglingToolParts(parts) {
  return parts.map(terminalizeDanglingToolPart);
}
function finalizePendingInteractionParts(parts, outcome) {
  return parts.map((part) => {
    if (String(part.type ?? "") !== "interaction") return part;
    if (String(part.status ?? "") !== "pending") return part;
    return { ...part, status: outcome };
  });
}
function collapseRedundantTextParts(parts) {
  const hasNonEmptyText = parts.some(
    (part) => String(part.type ?? "") === "text" && String(part.text ?? "").trim().length > 0
  );
  const collapsed = [];
  for (const part of parts) {
    if (String(part.type ?? "") !== "text") {
      collapsed.push(part);
      continue;
    }
    const text = String(part.text ?? "");
    if (hasNonEmptyText && text.trim().length === 0) continue;
    const previous = collapsed[collapsed.length - 1];
    if (previous && String(previous.type ?? "") === "text" && String(previous.text ?? "") === text) continue;
    collapsed.push(part);
  }
  return collapsed;
}
function assembleAssistantParts(partOrder, partMap, finalText) {
  const parts = partOrder.map((key) => partMap.get(key)).filter((part) => Boolean(part));
  const textParts = parts.filter((part) => String(part.type ?? "") === "text");
  if (textParts.length === 0) {
    if (finalText.trim()) {
      parts.push({ type: "text", text: finalText });
    }
    return parts;
  }
  if (!textParts.some((part) => asString(part.id))) {
    return parts.map((part) => {
      if (String(part.type ?? "") !== "text") return part;
      return {
        ...part,
        text: finalText || String(part.text ?? "")
      };
    });
  }
  const joined = textParts.map((part) => String(part.text ?? "")).join("");
  if (finalText === joined || finalText.trimEnd() === joined.trimEnd()) {
    return parts;
  }
  if (finalText.startsWith(joined)) {
    return [...parts, { type: "text", text: finalText.slice(joined.length) }];
  }
  const lastTextPart = textParts[textParts.length - 1];
  return parts.filter((part) => String(part.type ?? "") !== "text" || part === lastTextPart).map((part) => part === lastTextPart ? { ...part, text: finalText } : part);
}
function finalizeAssistantParts(partOrder, partMap, finalText) {
  return collapseRedundantTextParts(terminalizeDanglingToolParts(
    assembleAssistantParts(partOrder, partMap, finalText)
  ));
}
function draftAssistantParts(partOrder, partMap, finalText) {
  return collapseRedundantTextParts(assembleAssistantParts(partOrder, partMap, finalText));
}
function partStatus(part) {
  const state = asRecord(part?.state);
  return String(state?.status ?? part?.status ?? "");
}
function terminalizeDanglingAssistantToolUpdates(partOrder, partMap, finalText) {
  const finalizedParts = finalizeAssistantParts(partOrder, partMap, finalText);
  const updates = [];
  for (const part of finalizedParts) {
    if (String(part.type ?? "") !== "tool") continue;
    const key = getPartKey(part);
    const existing = partMap.get(key);
    if (partStatus(existing) !== "running" || partStatus(part) === "running") continue;
    partMap.set(key, mergePersistedPart(existing, part));
    updates.push(part);
  }
  return updates;
}
function encodeEvent(encoder, event) {
  return encoder.encode(`${JSON.stringify(event)}
`);
}

export {
  asRecord,
  asString,
  resolveToolId,
  resolveToolName,
  normalizeTime,
  normalizeToolEvent,
  normalizePersistedPart,
  attachmentPartKey,
  getPartKey,
  mergePersistedPart,
  MISSING_TOOL_TERMINAL_ERROR,
  MISSING_TOOL_TERMINAL_REASON,
  terminalizeDanglingToolPart,
  terminalizeDanglingToolParts,
  finalizePendingInteractionParts,
  collapseRedundantTextParts,
  finalizeAssistantParts,
  draftAssistantParts,
  terminalizeDanglingAssistantToolUpdates,
  encodeEvent
};
//# sourceMappingURL=chunk-ZMMIQOFI.js.map