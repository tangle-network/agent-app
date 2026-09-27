// src/stream/turn-identity.ts
function normalizeClientTurnId(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") throw new Error("turnId must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("turnId must not be blank");
  if (trimmed.length > 160) throw new Error("turnId is too long");
  if (!/^[A-Za-z0-9:_-]+$/.test(trimmed)) {
    throw new Error("turnId contains unsupported characters");
  }
  return trimmed;
}
function buildUserTextParts(text, turnId) {
  const part = { type: "text", text };
  if (turnId) part.turnId = turnId;
  return [part];
}
function messageHasTurnId(message, turnId) {
  for (const part of message.parts ?? []) {
    if (part && typeof part === "object" && String(part.turnId ?? "") === turnId) {
      return true;
    }
  }
  return false;
}
function resolveChatTurn(input) {
  const { existingMessages, userContent, turnId } = input;
  const reusableIndex = findReusableUserMessageIndex(
    existingMessages,
    userContent,
    turnId,
    input.hasRunningTurn === true
  );
  if (reusableIndex >= 0) {
    const reusedId = existingMessages[reusableIndex]?.id;
    return {
      turnIndex: countUserMessages(existingMessages.slice(0, reusableIndex)),
      shouldInsertUserMessage: false,
      priorMessages: existingMessages.slice(0, reusableIndex),
      userParts: buildUserTextParts(userContent, turnId),
      ...typeof reusedId === "string" && reusedId ? { reusedUserMessageId: reusedId } : {}
    };
  }
  return {
    turnIndex: countUserMessages(existingMessages),
    shouldInsertUserMessage: true,
    priorMessages: existingMessages,
    userParts: buildUserTextParts(userContent, turnId)
  };
}
function findReusableUserMessageIndex(messages, userContent, turnId, hasRunningTurn) {
  if (turnId) {
    for (let index2 = messages.length - 1; index2 >= 0; index2 -= 1) {
      const message = messages[index2];
      if (message?.role === "user" && messageHasTurnId(message, turnId)) return index2;
    }
    return -1;
  }
  let index = messages.length - 1;
  if (hasRunningTurn) {
    while (index >= 0 && messages[index]?.role === "assistant") index -= 1;
  }
  const latest = index >= 0 ? messages[index] : void 0;
  if (latest?.role === "user" && latest.content === userContent) return index;
  return -1;
}
function countUserMessages(messages) {
  return messages.filter((message) => message.role === "user").length;
}

// src/stream/turn-observation.ts
function parseTurnObservation(value) {
  if (value === void 0) return {
    schema: "turn-observation-v1",
    streamId: null,
    lastSeq: 0,
    outcome: null,
    replayStatus: null,
    eventCount: 0
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid turn observation");
  const v = value;
  if (v.schema !== "turn-observation-v1" || !(v.streamId === null || typeof v.streamId === "string" && /^[A-Za-z0-9_-]+$/.test(v.streamId)) || !Number.isSafeInteger(v.lastSeq) || Number(v.lastSeq) < 0 || !Number.isSafeInteger(v.eventCount) || Number(v.eventCount) < 0 || !(v.outcome === null || v.outcome === "completed" || v.outcome === "failed") || !(v.replayStatus === null || typeof v.replayStatus === "string") || v.streamId === null && Number(v.lastSeq) > 0) throw new TypeError("Invalid turn observation");
  return {
    schema: "turn-observation-v1",
    streamId: v.streamId,
    lastSeq: Number(v.lastSeq),
    outcome: v.outcome,
    replayStatus: v.replayStatus,
    eventCount: Number(v.eventCount)
  };
}
function observeTurnEvent(previous, raw) {
  const checkpoint = parseTurnObservation(previous);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Turn frame must be an object");
  const outer = raw;
  const inner = outer.kind === "event" ? outer.event : outer;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw new TypeError("Invalid turn event envelope");
  const event = inner;
  if (typeof event.type !== "string" || !event.type) throw new TypeError("Turn frame requires a type");
  if (event.type === "turn") {
    if (typeof event.turnId !== "string" || !/^[A-Za-z0-9_-]+$/.test(event.turnId)) throw new TypeError("Invalid stream identity");
    if (checkpoint.streamId !== null && checkpoint.streamId !== event.turnId) throw new Error("Replay stream identity changed");
    checkpoint.streamId = event.turnId;
  }
  const seq = outer.seq;
  if (seq !== void 0 && seq !== -1) {
    if (!Number.isSafeInteger(seq) || Number(seq) < 1) throw new TypeError("Invalid replay ordinal");
    if (checkpoint.streamId === null) throw new Error("Replay ordinal arrived before stream identity");
    if (Number(seq) <= checkpoint.lastSeq) return { checkpoint, accepted: false, event };
    if (Number(seq) !== checkpoint.lastSeq + 1) throw new Error("Replay has a gap; retain the checkpoint and inspect durable history");
    checkpoint.lastSeq = Number(seq);
  } else if (seq === -1 && event.type !== "turn_status") {
    throw new TypeError("Only a turn-status sentinel may have ordinal -1");
  }
  if (event.type === "error" || event.type === "session.run.failed") checkpoint.outcome = "failed";
  if (event.type === "session.run.completed" && checkpoint.outcome !== "failed") checkpoint.outcome = "completed";
  if (event.type === "turn_status") {
    if (typeof event.status !== "string") throw new TypeError("Turn status requires a value");
    checkpoint.replayStatus = event.status;
    if (["error", "failed", "aborted", "cancelled"].includes(event.status)) checkpoint.outcome = "failed";
    if (["complete", "completed"].includes(event.status) && checkpoint.outcome !== "failed") checkpoint.outcome = "completed";
  }
  checkpoint.eventCount += 1;
  return { checkpoint, accepted: true, event };
}
async function consumeTurnStream(body, options) {
  const maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new RangeError("Frame byte limit must be positive");
  let state = parseTurnObservation(options.checkpoint);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let frameBytes = 0;
  async function accept(line) {
    if (!line.trim()) return;
    const update = observeTurnEvent(state, JSON.parse(line));
    if (update.accepted) await options.commit(update);
    state = update.checkpoint;
  }
  for await (const chunk of body) {
    let start = 0;
    for (let end = 0; end < chunk.length; end += 1) {
      if (chunk[end] !== 10) continue;
      frameBytes += end - start;
      if (frameBytes > maxFrameBytes) throw new RangeError("Turn frame exceeds byte limit");
      pending += decoder.decode(chunk.subarray(start, end + 1), { stream: true });
      await accept(pending);
      pending = "";
      frameBytes = 0;
      start = end + 1;
    }
    frameBytes += chunk.length - start;
    if (frameBytes > maxFrameBytes) throw new RangeError("Turn frame exceeds byte limit");
    pending += decoder.decode(chunk.subarray(start), { stream: true });
  }
  pending += decoder.decode();
  await accept(pending);
  return state;
}

export {
  normalizeClientTurnId,
  buildUserTextParts,
  messageHasTurnId,
  resolveChatTurn,
  parseTurnObservation,
  observeTurnEvent,
  consumeTurnStream
};
//# sourceMappingURL=chunk-3NM4GCAY.js.map