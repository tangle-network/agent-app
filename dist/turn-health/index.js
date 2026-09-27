// src/turn-health/classify.ts
var ARTIFACT_PART_KINDS = /* @__PURE__ */ new Set(["file", "image", "work-product", "plan", "interaction"]);
var KNOWN_NON_OUTPUT_PART_KINDS = /* @__PURE__ */ new Set([
  "reasoning",
  "step-start",
  "step-finish",
  "source",
  "source-url",
  "data"
]);
var SAMPLE_CHARS = 120;
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function isUnparseableJson(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}
var SETTLED_TOOL_STATUSES = /* @__PURE__ */ new Set(["completed", "complete", "success", "done"]);
function classifyTurnOutcome(input) {
  const reasons = [];
  if (input.failed) {
    reasons.push({
      kind: "turn_failed",
      reason: nonEmptyString(input.failureReason) ?? "unspecified"
    });
  }
  const parts = Array.isArray(input.parts) ? input.parts : [];
  let hasVisibleText = nonEmptyString(input.finalText) !== null;
  let artifactCount = 0;
  let toolCalls = 0;
  const opaqueTypes = [];
  let interpretedParts = 0;
  for (const raw of parts) {
    const part = asRecord(raw);
    if (!part) continue;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text") {
      interpretedParts += 1;
      if (nonEmptyString(part.text) !== null) hasVisibleText = true;
      continue;
    }
    if (ARTIFACT_PART_KINDS.has(type)) {
      interpretedParts += 1;
      artifactCount += 1;
      continue;
    }
    if (KNOWN_NON_OUTPUT_PART_KINDS.has(type)) {
      interpretedParts += 1;
      continue;
    }
    if (type !== "tool") {
      opaqueTypes.push(type || "(missing type)");
      continue;
    }
    interpretedParts += 1;
    toolCalls += 1;
    const tool = nonEmptyString(part.tool) ?? "unknown";
    const state = asRecord(part.state);
    const status = typeof state?.status === "string" ? state.status : "unknown";
    const toolInput = state?.input;
    const inputRecord = asRecord(toolInput);
    const rejection = nonEmptyString(inputRecord?.error) ?? nonEmptyString(state?.error);
    if (rejection) {
      reasons.push({
        kind: "tool_call_rejected",
        // The payload names the tool the model MEANT to call; the part's own
        // `tool` is the harness's placeholder for a rejected call.
        tool: nonEmptyString(inputRecord?.tool) ?? tool,
        error: rejection.slice(0, 200)
      });
      continue;
    }
    if (typeof toolInput === "string" && isUnparseableJson(toolInput)) {
      reasons.push({
        kind: "malformed_tool_call",
        tool,
        inputLength: toolInput.length,
        sample: toolInput.slice(0, SAMPLE_CHARS)
      });
      continue;
    }
    if (!SETTLED_TOOL_STATUSES.has(status)) {
      reasons.push({ kind: "tool_call_no_effect", tool, status });
    }
  }
  const partsReadable = opaqueTypes.length === 0;
  const uniqueOpaque = [...new Set(opaqueTypes)];
  const unreadable = opaqueTypes.length > 0 && interpretedParts === 0 && !hasVisibleText;
  if (unreadable) {
    reasons.push({ kind: "unreadable_turn", partTypes: uniqueOpaque });
    return {
      healthy: false,
      severity: "warning",
      reasons,
      toolCalls,
      unreadable: true,
      partsReadable: false,
      opaquePartTypes: uniqueOpaque,
      // Structurally 0 here — `unreadable` is only reached when
      // `interpretedParts === 0`. Carried rather than hardcoded so the field
      // has one source on every return path.
      interpretedParts
    };
  }
  if (input.gated) {
    reasons.push({ kind: "answered_without_model" });
  } else if (!input.failed && !hasVisibleText && artifactCount === 0) {
    reasons.push({
      kind: "empty_completion",
      outputTokens: input.outputTokens ?? null,
      partCount: parts.length,
      ...input.durationMs !== void 0 ? { durationMs: input.durationMs } : {}
    });
  }
  return {
    healthy: reasons.length === 0,
    severity: severityOf(reasons),
    reasons,
    toolCalls,
    unreadable: false,
    partsReadable,
    opaquePartTypes: uniqueOpaque,
    interpretedParts
  };
}
function severityOf(reasons) {
  if (reasons.length === 0) return null;
  const critical = reasons.some(
    (r) => r.kind === "empty_completion" || r.kind === "turn_failed" || r.kind === "tool_call_rejected"
  );
  return critical ? "critical" : "warning";
}
function describeReason(reason) {
  switch (reason.kind) {
    case "empty_completion":
      return `completed with NO output (${reason.partCount} parts, outputTokens=${reason.outputTokens ?? "unknown"})`;
    case "malformed_tool_call":
      return `tool \`${reason.tool}\` arguments did not parse (${reason.inputLength} chars): ${reason.sample}`;
    case "tool_call_no_effect":
      return `tool \`${reason.tool}\` left no effect (status=${reason.status})`;
    case "turn_failed":
      return `turn failed: ${reason.reason}`;
    case "tool_call_rejected":
      return `tool \`${reason.tool}\` was REJECTED but settled as completed: ${reason.error}`;
    case "answered_without_model":
      return "answered by a pre-producer gate \u2014 the model never ran";
    case "unreadable_turn":
      return `turn could not be read: every part had an uninterpretable type (${reason.partTypes.join(
        ", "
      )})`;
  }
}

// src/turn-health/sink.ts
function turnAlert(input) {
  const kinds = [...new Set(input.reasons.map((r) => r.kind))].sort();
  return {
    product: input.product,
    severity: input.severity,
    // Keyed by product + reason kinds ONLY. A blank-completion storm across
    // 200 turns is one incident, not 200 pages.
    key: `turn:${input.product}:${kinds.join("+")}`,
    title: `${input.product}: turn completed but delivered nothing (${kinds.join(", ")})`,
    details: input.reasons.map(describeReason),
    data: {
      kinds,
      ...input.threadId ? { threadId: input.threadId } : {},
      ...input.turnId ? { turnId: input.turnId } : {},
      ...input.model ? { model: input.model } : {}
    },
    at: input.at ?? Date.now()
  };
}
function createWebhookAlertSink(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async deliver(alert) {
      const icon = alert.severity === "critical" ? ":rotating_light:" : ":warning:";
      const lines = [
        `${icon} *${alert.title}*`,
        ...alert.details.map((d) => `\u2022 ${d}`),
        `_${new Date(alert.at).toISOString()}_`
      ];
      const response = await fetchImpl(options.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: lines.join("\n") })
      });
      if (!response.ok) {
        throw new Error(`alert webhook responded ${response.status}`);
      }
    }
  };
}
function createSlackBotAlertSink(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async deliver(alert) {
      const icon = alert.severity === "critical" ? ":rotating_light:" : ":warning:";
      const lines = [
        `${icon} *${alert.title}*`,
        ...alert.details.map((d) => `\u2022 ${d}`),
        `_${new Date(alert.at).toISOString()}_`
      ];
      const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${options.botToken}`
        },
        body: JSON.stringify({ channel: options.channel, text: lines.join("\n") })
      });
      if (!response.ok) throw new Error(`slack chat.postMessage responded ${response.status}`);
      const body = await response.text?.() ?? "";
      if (body && !/"ok"\s*:\s*true/.test(body)) {
        throw new Error(`slack rejected the alert: ${body.slice(0, 200)}`);
      }
    }
  };
}
function createConsoleAlertSink(log = console.error) {
  return {
    async deliver(alert) {
      log(
        `[turn-health] ${alert.severity.toUpperCase()} ${alert.title} :: ${alert.details.join(" | ")}`
      );
    }
  };
}
function createMultiAlertSink(sinks) {
  return {
    async deliver(alert) {
      const settled = await Promise.allSettled(sinks.map((s) => s.deliver(alert)));
      const failures = settled.filter((r) => r.status === "rejected");
      if (failures.length === sinks.length && sinks.length > 0) {
        throw new Error("every alert sink failed");
      }
    }
  };
}
function createMemoryThrottleStore() {
  const seen = /* @__PURE__ */ new Map();
  return {
    async lastSentAt(key) {
      return seen.get(key) ?? null;
    },
    async markSent(key, at) {
      seen.set(key, at);
    }
  };
}
function createThrottledAlertSink(inner, options) {
  const store = options.store ?? createMemoryThrottleStore();
  return {
    async deliver(alert) {
      const last = await store.lastSentAt(alert.key);
      if (last !== null && alert.at - last < options.windowMs) return;
      await inner.deliver(alert);
      await store.markSent(alert.key, alert.at);
    }
  };
}
function createGuardedAlertSink(inner, onError = (e) => console.error("[turn-health] alert delivery failed", e)) {
  return {
    async deliver(alert) {
      try {
        await inner.deliver(alert);
      } catch (error) {
        onError(error);
      }
    }
  };
}

// src/turn-health/lifecycle.ts
function errorText(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
function createTurnHealthLifecycle(options) {
  const sink = createGuardedAlertSink(options.sink);
  return {
    async onTurnComplete(info) {
      const verdict = classifyTurnOutcome({
        finalText: info.finalText,
        outputTokens: info.usage?.outputTokens ?? null,
        durationMs: info.durationMs,
        ...info.gated ? { gated: true } : {}
      });
      options.onVerdict?.({
        product: options.product,
        healthy: verdict.healthy,
        kinds: verdict.reasons.map((r) => r.kind),
        durationMs: info.durationMs
      });
      if (verdict.healthy || verdict.severity === null) return;
      if (!options.alertOnGatedTurn && verdict.reasons.every((r) => r.kind === "answered_without_model")) {
        return;
      }
      await sink.deliver(
        turnAlert({
          product: options.product,
          severity: verdict.severity,
          reasons: verdict.reasons,
          ...info.threadId ? { threadId: info.threadId } : {},
          ...info.executionId ? { turnId: info.executionId } : {}
        })
      );
    },
    async onTurnError(info) {
      const verdict = classifyTurnOutcome({
        failed: true,
        failureReason: errorText(info.error),
        durationMs: info.durationMs
      });
      options.onVerdict?.({
        product: options.product,
        healthy: false,
        kinds: verdict.reasons.map((r) => r.kind),
        durationMs: info.durationMs
      });
      await sink.deliver(
        turnAlert({
          product: options.product,
          severity: "critical",
          reasons: verdict.reasons,
          ...info.threadId ? { threadId: info.threadId } : {},
          ...info.executionId ? { turnId: info.executionId } : {}
        })
      );
    }
  };
}

// src/turn-health/sweep.ts
async function decodeRowParts(decode, row) {
  if (!decode) return row.parts;
  try {
    const decoded = await decode(row.parts, row);
    return decoded ?? row.parts;
  } catch {
    return row.parts;
  }
}
function parseParts(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
var HOUR_MS = 36e5;
var D1_MAX_LIKE_PATTERN_LENGTH = 50;
var SHELL_ERROR_REPLY_PREFIXES = [
  "The sandbox model stream stopped before a clean completion.",
  "The sandbox agent returned an error before producing a visible answer."
];
async function sweepSilentFailures(options) {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 15 * 6e4;
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * HOUR_MS;
  const lookbackMs = options.lookbackMs ?? 24 * HOUR_MS;
  const limit = options.limit ?? 500;
  const emptyRateThreshold = options.emptyRateThreshold ?? 0.05;
  const minTurnsForRate = options.minTurnsForRate ?? 10;
  const minTurnsForToolSurface = options.minTurnsForToolSurface ?? 10;
  const blindThreshold = 0.5;
  const [unanswered, turns] = await Promise.all([
    options.source.findUnansweredThreads({ minAgeMs, maxAgeMs, now }),
    options.source.listRecentAssistantTurns({ sinceMs: now - lookbackMs, now, limit })
  ]);
  const alerts = [];
  const pendingUserMessages = unanswered.reduce((sum, t) => sum + t.pendingMessages, 0);
  const oldestUnansweredMs = unanswered.reduce((max, t) => Math.max(max, t.oldestAgeMs), 0);
  if (unanswered.length > 0) {
    const hours = (oldestUnansweredMs / HOUR_MS).toFixed(1);
    alerts.push({
      product: options.product,
      // A day of total silence is not a warning.
      severity: oldestUnansweredMs >= 24 * HOUR_MS ? "critical" : "warning",
      key: `sweep:${options.product}:unanswered_threads`,
      title: `${options.product}: ${pendingUserMessages} user message(s) unanswered across ${unanswered.length} thread(s)`,
      details: [
        `oldest unanswered message: ${hours}h`,
        ...unanswered.slice(0, 5).map(
          (t) => `thread ${t.threadId}: ${t.pendingMessages} pending, oldest ${(t.oldestAgeMs / HOUR_MS).toFixed(1)}h`
        )
      ],
      data: {
        unansweredThreads: unanswered.length,
        pendingUserMessages,
        oldestUnansweredMs
      },
      at: now
    });
  }
  let emptyCompletions = 0;
  let malformedToolCalls = 0;
  let toolCallsWithoutEffect = 0;
  let rejectedToolCalls = 0;
  let unhealthyTurns = 0;
  let turnsWithToolCalls = 0;
  let toolCalls = 0;
  let unreadableTurns = 0;
  let toolReadableTurns = 0;
  let opaquePartsTurns = 0;
  let noPartsTurns = 0;
  const opaqueTypes = /* @__PURE__ */ new Set();
  const malformedSamples = [];
  const rejectedSamples = [];
  for (const row of turns) {
    const verdict = classifyTurnOutcome({
      finalText: row.content,
      parts: parseParts(await decodeRowParts(options.decodeParts, row)),
      outputTokens: row.outputTokens ?? null
    });
    toolCalls += verdict.toolCalls;
    if (verdict.toolCalls > 0) turnsWithToolCalls += 1;
    if (verdict.partsReadable && verdict.interpretedParts > 0) toolReadableTurns += 1;
    else if (verdict.partsReadable) noPartsTurns += 1;
    else {
      opaquePartsTurns += 1;
      for (const t of verdict.opaquePartTypes) opaqueTypes.add(t);
    }
    if (verdict.unreadable) {
      unreadableTurns += 1;
      continue;
    }
    if (verdict.healthy) continue;
    unhealthyTurns += 1;
    for (const reason of verdict.reasons) {
      if (reason.kind === "empty_completion") emptyCompletions += 1;
      if (reason.kind === "malformed_tool_call") {
        malformedToolCalls += 1;
        if (malformedSamples.length < 3) malformedSamples.push(reason);
      }
      if (reason.kind === "tool_call_no_effect") toolCallsWithoutEffect += 1;
      if (reason.kind === "tool_call_rejected") {
        rejectedToolCalls += 1;
        if (rejectedSamples.length < 3) rejectedSamples.push(reason);
      }
    }
  }
  const readableTurns = turns.length - unreadableTurns;
  if (malformedToolCalls > 0) {
    alerts.push({
      product: options.product,
      severity: "critical",
      key: `sweep:${options.product}:malformed_tool_call`,
      title: `${options.product}: ${malformedToolCalls} tool call(s) had unparseable arguments \u2014 deliverables silently dropped`,
      details: malformedSamples.map(describeReason),
      data: { malformedToolCalls, turnsJudged: turns.length },
      at: now
    });
  }
  if (rejectedToolCalls > 0) {
    alerts.push({
      product: options.product,
      severity: "critical",
      key: `sweep:${options.product}:tool_call_rejected`,
      title: `${options.product}: ${rejectedToolCalls} tool call(s) were REJECTED but settled as completed \u2014 deliverables silently dropped`,
      details: rejectedSamples.map(describeReason),
      data: { rejectedToolCalls, turnsJudged: readableTurns },
      at: now
    });
  }
  if (readableTurns >= minTurnsForRate) {
    const rate = emptyCompletions / readableTurns;
    if (rate > emptyRateThreshold) {
      alerts.push({
        product: options.product,
        severity: "critical",
        key: `sweep:${options.product}:empty_completion_rate`,
        title: `${options.product}: ${(rate * 100).toFixed(1)}% of turns completed with no output`,
        details: [
          `${emptyCompletions} of ${readableTurns} readable settled turns delivered nothing`,
          `threshold ${(emptyRateThreshold * 100).toFixed(1)}%`
        ],
        data: { emptyCompletions, turnsJudged: readableTurns, rate },
        at: now
      });
    }
  }
  if (options.expectsToolCalls && toolReadableTurns >= minTurnsForToolSurface && toolCalls === 0) {
    alerts.push({
      product: options.product,
      severity: "critical",
      key: `sweep:${options.product}:dead_tool_surface`,
      title: `${options.product}: ZERO tool calls across ${toolReadableTurns} turns \u2014 the tool surface is dead`,
      details: [
        `${toolReadableTurns} assistant turns with readable parts in the lookback, none of which called a tool`,
        "the product declares its deliverable comes from tool calls, so it has answered without doing anything",
        ...opaquePartsTurns > 0 ? [`${opaquePartsTurns} further turn(s) had unreadable parts and were not judged`] : [],
        ...noPartsTurns > 0 ? [`${noPartsTurns} further turn(s) persisted no parts at all and were not judged`] : []
      ],
      data: {
        turnsJudged: toolReadableTurns,
        toolCalls: 0,
        turnsWithToolCalls: 0,
        turnsNotJudged: opaquePartsTurns + noPartsTurns,
        opaquePartsTurns,
        noPartsTurns
      },
      at: now
    });
  }
  if (options.expectsToolCalls && toolReadableTurns < minTurnsForToolSurface && opaquePartsTurns + noPartsTurns > 0) {
    alerts.push({
      product: options.product,
      severity: "warning",
      key: `sweep:${options.product}:tool_surface_unmeasurable`,
      title: `${options.product}: tool surface could not be certified \u2014 only ${toolReadableTurns} of ${turns.length} turns carried readable parts`,
      details: [
        ...noPartsTurns > 0 ? [`${noPartsTurns} turn(s) persisted no parts at all \u2014 nothing to read a tool call from`] : [],
        ...opaquePartsTurns > 0 ? [
          `${opaquePartsTurns} turn(s) stored parts this sweep cannot interpret (${[...opaqueTypes].join(", ") || "unnamed"}) \u2014 supply \`decodeParts\` to make them readable`
        ] : [],
        "this is NOT a dead tool surface finding; it is the absence of evidence either way"
      ],
      data: {
        toolReadableTurns,
        noPartsTurns,
        opaquePartsTurns,
        turnsSeen: turns.length,
        opaqueTypes: [...opaqueTypes]
      },
      at: now
    });
  }
  if (opaquePartsTurns > 0 && opaquePartsTurns >= turns.length * blindThreshold) {
    alerts.push({
      product: options.product,
      severity: "warning",
      key: `sweep:${options.product}:detector_blind`,
      title: `${options.product}: ${opaquePartsTurns} of ${turns.length} turns have unreadable parts \u2014 this sweep cannot certify them`,
      details: [
        `uninterpretable part types: ${[...opaqueTypes].join(", ") || "(none named)"}`,
        "these rows are excluded from every verdict above; treat them as UNMEASURED, not healthy"
      ],
      data: {
        opaquePartsTurns,
        unreadableTurns,
        turnsSeen: turns.length,
        opaqueTypes: [...opaqueTypes]
      },
      at: now
    });
  }
  for (const alert of alerts) await options.sink.deliver(alert);
  return {
    product: options.product,
    unansweredThreads: unanswered.length,
    pendingUserMessages,
    oldestUnansweredMs,
    turnsJudged: turns.length,
    unhealthyTurns,
    emptyCompletions,
    malformedToolCalls,
    toolCallsWithoutEffect,
    rejectedToolCalls,
    turnsWithToolCalls,
    toolCalls,
    unreadableTurns,
    opaquePartsTurns,
    noPartsTurns,
    toolReadableTurns,
    alerts
  };
}
function createD1TurnHealthSource(db, options = {}) {
  const message = safeIdentifier(options.messageTable ?? "message");
  const thread = safeIdentifier(options.threadTable ?? "thread");
  const errorPrefixes = [...options.errorReplyPrefixes ?? SHELL_ERROR_REPLY_PREFIXES].map(
    (p) => p.slice(0, D1_MAX_LIKE_PATTERN_LENGTH - 1)
  );
  return {
    async findUnansweredThreads({ minAgeMs, maxAgeMs, now }) {
      const cutoffSeconds = Math.floor((now - minAgeMs) / 1e3);
      const floorSeconds = Math.floor((now - maxAgeMs) / 1e3);
      const errorClause = errorPrefixes.map((_, i) => ` AND a.content NOT LIKE ?${i + 3} || '%'`).join("");
      const { results } = await db.prepare(
        `SELECT m.thread_id AS threadId,
                  COUNT(*) AS pendingMessages,
                  MIN(m.created_at) AS oldestCreatedAt
             FROM ${message} m
            WHERE m.role = 'user'
              AND m.created_at <= ?1
              AND m.created_at >= ?2
              AND m.created_at > COALESCE(
                    (SELECT MAX(a.created_at)
                       FROM ${message} a
                      WHERE a.thread_id = m.thread_id
                        AND a.role = 'assistant'
                        AND length(trim(a.content)) > 0${errorClause}), 0)
            GROUP BY m.thread_id
            ORDER BY oldestCreatedAt ASC`
      ).bind(cutoffSeconds, floorSeconds, ...errorPrefixes).all();
      return results.map((row) => ({
        threadId: row.threadId,
        pendingMessages: Number(row.pendingMessages),
        oldestAgeMs: now - Number(row.oldestCreatedAt) * 1e3
      }));
    },
    async listRecentAssistantTurns({ sinceMs, limit }) {
      const sinceSeconds = Math.floor(sinceMs / 1e3);
      const { results } = await db.prepare(
        `SELECT id, thread_id AS threadId, content, parts,
                  output_tokens AS outputTokens, model, created_at AS createdAt
             FROM ${message}
            WHERE role = 'assistant' AND created_at >= ?1
            ORDER BY created_at DESC
            LIMIT ?2`
      ).bind(sinceSeconds, limit).all();
      return results.map((row) => ({
        id: String(row.id),
        threadId: String(row.threadId),
        content: typeof row.content === "string" ? row.content : "",
        parts: row.parts,
        outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
        model: row.model ?? null,
        createdAt: Number(row.createdAt) * 1e3
      }));
    }
  };
  function safeIdentifier(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`unsafe table identifier: ${name}`);
    }
    return name;
  }
}
export {
  SHELL_ERROR_REPLY_PREFIXES,
  classifyTurnOutcome,
  createConsoleAlertSink,
  createD1TurnHealthSource,
  createGuardedAlertSink,
  createMemoryThrottleStore,
  createMultiAlertSink,
  createSlackBotAlertSink,
  createThrottledAlertSink,
  createTurnHealthLifecycle,
  createWebhookAlertSink,
  describeReason,
  sweepSilentFailures,
  turnAlert
};
//# sourceMappingURL=index.js.map