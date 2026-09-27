import {
  redactErrorMessage
} from "../chunk-MH74DY2I.js";
import {
  createSandboxFileIndexRoute
} from "../chunk-FQYAJYPW.js";
import {
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_COUNT,
  MACRO_ENABLED_OOXML_SNIFFED_MIMES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_BINARY_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  OOXML_PRESENTATION_MACRO_ENABLED_MIME,
  OOXML_PRESENTATION_MIME,
  OOXML_SNIFFED_MIMES,
  OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_WORD_MIME,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage,
  checkAttachmentType,
  sanitizeAttachmentFileName,
  sniffBinary
} from "../chunk-NU7QSZBR.js";
import {
  DEFAULT_STALE_TURN_LOCK_GRACE_MS,
  DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS,
  reconcileStaleTurnLock
} from "../chunk-CCVWR33L.js";
import {
  ModelFailoverExhaustedError,
  buildModelChain,
  isUpstreamUnavailable,
  readHttpStatusHint,
  runWithModelFailover
} from "../chunk-DEXBRUZR.js";
import {
  flattenHistory,
  readSandboxBinaryBytes,
  statSandboxFileSize
} from "../chunk-J42REVQJ.js";
import "../chunk-MCYJON3F.js";
import "../chunk-LWSJK546.js";
import "../chunk-FZOGDD2E.js";
import "../chunk-6A7MYOUI.js";
import "../chunk-TX6S7XXU.js";
import "../chunk-UGWQLQDS.js";
import "../chunk-S5SRJJQG.js";
import {
  ProtectedModelSettlementError
} from "../chunk-KHRIPDW5.js";
import "../chunk-JML7WKWU.js";
import {
  assistantRowIdForTurn,
  createAssistantDraftWriter,
  createChatTurnRoutes,
  isDraftContentEvent,
  rowIdOf,
  storeSupportsDraftPersistence,
  streamChatRouteAsSandboxEvents
} from "../chunk-V4YGTOCS.js";
import "../chunk-ZSSCVT6H.js";
import "../chunk-EA4UVS4T.js";
import {
  attachmentInputToPart,
  attachmentKindForMime,
  toChatMessageParts
} from "../chunk-4PZE7XAM.js";
import "../chunk-ZVEEWGDK.js";
import {
  ChatTurnInputError,
  DISPATCH_MAX_MEDIA_PARTS,
  DISPATCH_MAX_PARTS,
  DISPATCH_REQUEST_MAX_BYTES,
  DISPATCH_STRUCTURAL_RESERVE_BYTES,
  INLINE_PARTS_MAX_BYTES,
  MENTION_MAX_COUNT,
  assertPromptPartsWithinCap,
  base64WireLen,
  buildMentionPromptBlock,
  chatTurnRequestInit,
  fileMentionsToParts,
  formatBytes,
  mediaTypeForMentionPath,
  mentionKindForPath,
  parseChatTurnParts,
  parseFileMentions,
  promptPartsByteSize,
  validateSandboxMentionPath
} from "../chunk-X47R2IVO.js";
import {
  isWorkspaceFileExportable
} from "../chunk-TXD5HXLE.js";
import "../chunk-3NM4GCAY.js";
import {
  asRecord,
  asString,
  collapseRedundantTextParts,
  draftAssistantParts,
  finalizeAssistantParts,
  finalizePendingInteractionParts,
  getPartKey,
  mergePersistedPart,
  normalizePersistedPart,
  normalizeToolEvent,
  terminalizeDanglingAssistantToolUpdates
} from "../chunk-ZMMIQOFI.js";
import {
  cancelStatusFor,
  interactionPartKey,
  interactionToPersistedPart,
  isRenderableInteractionKind,
  noticePart,
  noticePartKey,
  parseInteractionCancel,
  parseInteractionRequest
} from "../chunk-M3K2HVQD.js";
import {
  parsePlanSubmittedEvent,
  planToPersistedPart
} from "../chunk-YJMCRXQQ.js";
import {
  coalesceDeltas,
  createBufferedTurnTap
} from "../chunk-HXTJXODG.js";

// src/chat-routes/model-failover-stream.ts
var TERMINAL_FAILURE_TYPES = /* @__PURE__ */ new Set(["error", "session.run.failed"]);
var NON_COMMITTING_PART_TYPES = /* @__PURE__ */ new Set(["step-start", "step-finish"]);
function isCommittingSandboxEvent(event) {
  const record2 = asRecord(event);
  if (!record2) return false;
  const type = asString(record2.type) ?? "";
  if (!type) return false;
  if (type === "message.part.updated") {
    const part = asRecord(asRecord(record2.data)?.part);
    const partType = asString(part?.type) ?? "";
    if (NON_COMMITTING_PART_TYPES.has(partType)) return false;
    if (partType === "text" || partType === "reasoning") {
      const text = asString(part?.text) ?? asString(part?.content) ?? "";
      return text.length > 0;
    }
    return true;
  }
  if (type === "start" || type === "execution.started" || type === "status" || type === "model-processing" || type === "model.processing" || type === "session.created" || type === "session.updated" || type === "session.idle" || type === "step-start" || type === "step-finish" || type === "turn" || type === "warning") {
    return false;
  }
  return true;
}
function summarizeFailoverReason(reason) {
  const collapsed = reason.replace(/\s+/g, " ").trim();
  if (!collapsed) return "upstream unavailable";
  if (/<!doctype html|<html[\s>]/i.test(collapsed)) {
    const status = readHttpStatusHint(collapsed);
    return status ? `HTTP ${status}` : "upstream returned an error page";
  }
  const LIMIT = 160;
  if (collapsed.length <= LIMIT) return collapsed;
  const clipped = collapsed.slice(0, LIMIT);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > LIMIT - 30 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}\u2026`;
}
function isLiveLifecycleEvent(event) {
  const type = asString(asRecord(event)?.type) ?? "";
  return type === "start" || type === "execution.started" || type === "status" || type === "model-processing" || type === "model.processing" || type === "session.created" || type === "session.updated" || type === "session.idle";
}
function classifyTerminalFailure(event) {
  const record2 = asRecord(event);
  if (!record2) return null;
  const type = asString(record2.type) ?? "";
  if (!TERMINAL_FAILURE_TYPES.has(type)) return null;
  const data = asRecord(record2.data);
  const outage = isUpstreamUnavailable(data) || isUpstreamUnavailable(record2);
  const reason = asString(data?.message) ?? asString(data?.error) ?? asString(data?.reason) ?? asString(record2.message) ?? `sandbox stream reported ${type}`;
  const code = asString(data?.errorCode) ?? asString(data?.code);
  return { outage, reason, ...code ? { code } : {} };
}
var DEFAULT_MODEL_STREAM_OPEN_TIMEOUT_MS = 12e4;
var DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS = 6e4;
var ModelFailoverTimeoutError = class extends ModelFailoverExhaustedError {
  code;
  model;
  timeoutMs;
  constructor(input) {
    super(input.attempts);
    this.name = "ModelFailoverTimeoutError";
    this.code = input.code;
    this.model = input.model;
    this.timeoutMs = input.timeoutMs;
    this.message = input.code === "model_stream_open_timeout" ? `Opening the model event source for ${input.model} exceeded ${input.timeoutMs}ms.` : `Model ${input.model} produced no first answer-bearing event within ${input.timeoutMs}ms.`;
  }
};
function resolveTimeoutMs(value, fallback, label) {
  if (value === void 0) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite number greater than 0`);
  }
  return Math.max(1, Math.trunc(value));
}
var TIMED_OUT = /* @__PURE__ */ Symbol("model-attempt-timed-out");
function deadlineAfter(timeoutMs) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  return {
    promise,
    clear: () => {
      if (timer !== void 0) {
        clearTimeout(timer);
        timer = void 0;
      }
    }
  };
}
function isEmptyTerminalReceipt(event) {
  const record2 = asRecord(event);
  if (!record2) return false;
  const type = asString(record2.type) ?? "";
  if (type !== "result" && type !== "done") return false;
  const data = asRecord(record2.data);
  const text = asString(data?.finalText) ?? asString(data?.text) ?? "";
  return text.trim().length === 0;
}
var MAX_EMPTY_TURN_RETRIES = 3;
function resolveEmptyTurnRetries(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const truncated = Math.trunc(value);
  if (truncated <= 0) return 0;
  return Math.min(truncated, MAX_EMPTY_TURN_RETRIES);
}
async function closeIterator(iterator, log) {
  try {
    await iterator.return?.();
  } catch (err) {
    log?.("[chat-routes] abandoning a failed model stream threw", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
function streamWithModelFailover(options) {
  const committing = options.isCommitting ?? isCommittingSandboxEvent;
  const emptyTurnRetries = resolveEmptyTurnRetries(options.emptyTurnRetries);
  const openTimeoutMs = resolveTimeoutMs(
    options.openTimeoutMs,
    DEFAULT_MODEL_STREAM_OPEN_TIMEOUT_MS,
    "openTimeoutMs"
  );
  const firstResponseTimeoutMs = resolveTimeoutMs(
    options.firstResponseTimeoutMs,
    DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS,
    "firstResponseTimeoutMs"
  );
  const liveLifecycle = options.liveLifecycleEvents === true;
  const progress = createProgressQueue();
  let serving;
  let trail = [];
  let fellBack = false;
  let attemptIndex = 0;
  let finalTimeout;
  const drainOnce = async (model) => {
    attemptIndex += 1;
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    const opening = Promise.resolve().then(() => options.open({
      model,
      attempt: attemptIndex,
      signal: controller.signal
    }));
    const openDeadline = deadlineAfter(openTimeoutMs);
    let opened;
    try {
      opened = await Promise.race([opening, openDeadline.promise]);
    } catch (err) {
      openDeadline.clear();
      abort();
      throw err;
    }
    if (opened === TIMED_OUT) {
      openDeadline.clear();
      abort();
      void opening.then(
        (lateSource) => {
          try {
            void closeIterator(lateSource[Symbol.asyncIterator](), options.log);
          } catch (err) {
            options.log?.("[chat-routes] closing a late model stream threw", {
              error: err instanceof Error ? err.message : String(err)
            });
          }
        },
        (err) => {
          options.log?.("[chat-routes] abandoned model stream open rejected after timeout", {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      );
      return {
        outcome: {
          committed: false,
          error: `Opening the model event source for ${model} exceeded ${openTimeoutMs}ms`,
          errorCode: "model_stream_open_timeout",
          timeoutCode: "model_stream_open_timeout"
        },
        empty: false
      };
    }
    const source = opened;
    let iterator;
    try {
      iterator = source[Symbol.asyncIterator]();
    } catch (err) {
      openDeadline.clear();
      abort();
      throw err;
    }
    const buffered = [];
    let next;
    try {
      next = await Promise.race([
        Promise.resolve(iterator.next()),
        openDeadline.promise
      ]);
    } catch (err) {
      openDeadline.clear();
      abort();
      void closeIterator(iterator, options.log);
      throw err;
    }
    openDeadline.clear();
    if (next === TIMED_OUT) {
      abort();
      void closeIterator(iterator, options.log);
      return {
        outcome: {
          committed: false,
          error: `Starting the model event source for ${model} exceeded ${openTimeoutMs}ms`,
          errorCode: "model_stream_open_timeout",
          timeoutCode: "model_stream_open_timeout"
        },
        empty: false
      };
    }
    if (next.done) {
      abort();
      return { outcome: { committed: true, buffered, iterator: null, abort }, empty: true };
    }
    const firstResponseDeadline = deadlineAfter(firstResponseTimeoutMs);
    for (; ; ) {
      const event = next.value;
      let failure;
      let commits = false;
      try {
        failure = classifyTerminalFailure(event);
        commits = !failure && committing(event);
      } catch (err) {
        firstResponseDeadline.clear();
        abort();
        void closeIterator(iterator, options.log);
        throw err;
      }
      if (failure?.outage) {
        firstResponseDeadline.clear();
        abort();
        void closeIterator(iterator, options.log);
        return {
          outcome: {
            committed: false,
            error: failure.reason,
            ...failure.code ? { errorCode: failure.code } : {}
          },
          empty: false
        };
      }
      if (liveLifecycle && !failure && !commits && isLiveLifecycleEvent(event)) {
        progress.push(event);
      } else {
        buffered.push(event);
      }
      if (failure) {
        firstResponseDeadline.clear();
        return { outcome: { committed: true, buffered, iterator, abort }, empty: false };
      }
      if (commits) {
        firstResponseDeadline.clear();
        return { outcome: { committed: true, buffered, iterator, abort }, empty: isEmptyTerminalReceipt(event) };
      }
      try {
        next = await Promise.race([
          Promise.resolve(iterator.next()),
          firstResponseDeadline.promise
        ]);
      } catch (err) {
        firstResponseDeadline.clear();
        abort();
        void closeIterator(iterator, options.log);
        throw err;
      }
      if (next === TIMED_OUT) {
        firstResponseDeadline.clear();
        abort();
        void closeIterator(iterator, options.log);
        return {
          outcome: {
            committed: false,
            error: `Model ${model} produced no first answer-bearing event within ${firstResponseTimeoutMs}ms`,
            errorCode: "provider_first_response_timeout",
            timeoutCode: "provider_first_response_timeout"
          },
          empty: false
        };
      }
      if (next.done) {
        firstResponseDeadline.clear();
        abort();
        return { outcome: { committed: true, buffered, iterator: null, abort }, empty: true };
      }
    }
  };
  const probe = async (model) => {
    finalTimeout = void 0;
    for (let retry = 0; ; retry += 1) {
      const pass = await drainOnce(model);
      if (!pass.empty || retry >= emptyTurnRetries) {
        if (!pass.outcome.committed && pass.outcome.timeoutCode) {
          finalTimeout = {
            code: pass.outcome.timeoutCode,
            model,
            timeoutMs: pass.outcome.timeoutCode === "model_stream_open_timeout" ? openTimeoutMs : firstResponseTimeoutMs
          };
        } else {
          finalTimeout = void 0;
        }
        return pass.outcome;
      }
      const iterator = pass.outcome.committed ? pass.outcome.iterator : null;
      if (pass.outcome.committed) pass.outcome.abort();
      if (iterator) void closeIterator(iterator, options.log);
      const info = { model, retry: retry + 1, remaining: emptyTurnRetries - retry - 1 };
      options.log?.("[chat-routes] turn completed with no assistant text; re-running the same model", {
        ...info
      });
      options.onEmptyTurnRetry?.(info);
    }
  };
  const events = (async function* () {
    let handle;
    const settled = runWithModelFailover({
      models: options.models,
      run: probe,
      // The probe has already classified the raw payload with
      // `isUpstreamUnavailable`; this reads its verdict rather than
      // re-classifying a wrapper object, so the two can never disagree.
      isUnavailableResult: (result) => result.committed === false,
      onFallback: (attempt, nextModel) => {
        const info = {
          from: attempt.model,
          to: nextModel,
          reason: attempt.reason ?? "upstream unavailable"
        };
        options.log?.("[chat-routes] model upstream unavailable; falling over", { ...info });
        options.onFallback?.(info);
      }
    }).finally(() => progress.close());
    settled.catch(() => void 0);
    for (; ; ) {
      const item = await progress.pull();
      if (item === PROGRESS_CLOSED) break;
      yield item;
    }
    try {
      const outcome = await settled;
      serving = outcome.model;
      trail = outcome.attempts;
      fellBack = outcome.usedFallback;
      handle = outcome.value;
    } catch (err) {
      const attempts = err?.attempts;
      if (Array.isArray(attempts)) trail = attempts;
      if (err instanceof ModelFailoverExhaustedError && finalTimeout) {
        throw new ModelFailoverTimeoutError({
          attempts: trail,
          ...finalTimeout
        });
      }
      throw err;
    }
    for (const event of handle.buffered) yield event;
    const live = handle.iterator;
    if (!live) {
      handle.abort();
      return;
    }
    try {
      for (; ; ) {
        const next = await live.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      handle.abort();
      await closeIterator(live, options.log);
    }
  })();
  return {
    events,
    servingModel: () => serving,
    attempts: () => trail,
    usedFallback: () => fellBack
  };
}
var PROGRESS_CLOSED = /* @__PURE__ */ Symbol("progress-closed");
function createProgressQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  const deliver = (value) => {
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else items.push(value);
  };
  return {
    push(event) {
      if (closed) return;
      deliver(event);
    },
    close() {
      if (closed) return;
      closed = true;
      deliver(PROGRESS_CLOSED);
    },
    pull() {
      if (items.length > 0) return Promise.resolve(items.shift());
      if (closed) return Promise.resolve(PROGRESS_CLOSED);
      return new Promise((resolve) => waiters.push(resolve));
    }
  };
}

// src/chat-routes/sandbox-turn-usage.ts
function addStepFinishUsage(part, usage) {
  const tokens = asRecord(part.tokens);
  if (tokens) {
    const cache = asRecord(tokens.cache);
    const add = (current, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return current;
      return (current ?? 0) + n;
    };
    usage.inputTokens = add(usage.inputTokens, tokens.input);
    usage.outputTokens = add(usage.outputTokens, tokens.output);
    usage.reasoningTokens = add(usage.reasoningTokens, tokens.reasoning);
    if (cache) {
      usage.cacheReadTokens = add(usage.cacheReadTokens, cache.read);
      usage.cacheWriteTokens = add(usage.cacheWriteTokens, cache.write);
    }
  }
  const cost = Number(part.cost);
  if (Number.isFinite(cost)) usage.costUsd = (usage.costUsd ?? 0) + cost;
}

// src/chat-routes/sandbox-producer.ts
function textDelta(tracker, key, part, rawDelta) {
  const explicit = typeof rawDelta === "string" ? rawDelta : void 0;
  const previous = tracker.seen.get(key) ?? "";
  if (explicit !== void 0) {
    tracker.seen.set(key, previous + explicit);
    return explicit;
  }
  const snapshot = asString(part.text) ?? asString(part.content) ?? "";
  if (!snapshot) return "";
  if (snapshot.startsWith(previous)) {
    tracker.seen.set(key, snapshot);
    return snapshot.slice(previous.length);
  }
  tracker.seen.set(key, snapshot);
  return snapshot;
}
function parseEffectiveBackend(data) {
  const backend = asRecord(data.effectiveBackend);
  if (!backend) return void 0;
  const provider = asString(backend.provider);
  const model = asString(backend.model);
  const rawSource = asString(backend.source);
  const source = rawSource === "request" || rawSource === "environment" || rawSource === "profile" ? rawSource : void 0;
  if (!provider && !model && !source) return void 0;
  return {
    ...model ? { servedModel: model } : {},
    ...provider ? { servedProvider: provider } : {},
    ...source ? { servedSource: source } : {}
  };
}
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function extractReportedTurnUsage(data) {
  const tokenUsage = asRecord(data?.tokenUsage);
  if (!tokenUsage) return null;
  const inputTokens = toFiniteNumber(tokenUsage.inputTokens);
  const outputTokens = toFiniteNumber(tokenUsage.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  const reported = { inputTokens, outputTokens };
  const reasoningTokens = toFiniteNumber(tokenUsage.reasoningTokens);
  if (reasoningTokens !== null) reported.reasoningTokens = reasoningTokens;
  const cacheReadTokens = toFiniteNumber(tokenUsage.cacheReadInputTokens);
  if (cacheReadTokens !== null) reported.cacheReadTokens = cacheReadTokens;
  const cacheWriteTokens = toFiniteNumber(tokenUsage.cacheCreationInputTokens);
  if (cacheWriteTokens !== null) reported.cacheWriteTokens = cacheWriteTokens;
  const costUsd = toFiniteNumber(data?.totalCostUsd) ?? toFiniteNumber(tokenUsage.cost);
  if (costUsd !== null) reported.costUsd = costUsd;
  return reported;
}
function extractUsageSnapshot(value) {
  const inputTokens = toFiniteNumber(value?.promptTokens);
  const outputTokens = toFiniteNumber(value?.completionTokens);
  if (inputTokens === null || outputTokens === null || inputTokens < 0 || outputTokens < 0) return null;
  const reported = { inputTokens, outputTokens };
  const reasoningTokens = toFiniteNumber(value?.reasoningTokens);
  if (reasoningTokens !== null && reasoningTokens >= 0) reported.reasoningTokens = reasoningTokens;
  const costUsd = toFiniteNumber(value?.providerCostUsd);
  if (costUsd !== null && costUsd >= 0) reported.costUsd = costUsd;
  return reported;
}
function applyTerminalUsage(reported, usage) {
  usage.inputTokens = reported.inputTokens;
  usage.outputTokens = reported.outputTokens;
  if (reported.reasoningTokens !== void 0) usage.reasoningTokens = reported.reasoningTokens;
  if (reported.cacheReadTokens !== void 0) usage.cacheReadTokens = reported.cacheReadTokens;
  if (reported.cacheWriteTokens !== void 0) usage.cacheWriteTokens = reported.cacheWriteTokens;
  if (reported.costUsd !== void 0) usage.costUsd = reported.costUsd;
}
function sandboxStreamErrorMessage(data) {
  const record2 = asRecord(data);
  const message = asString(record2?.message) ?? asString(record2?.error);
  if (message) return message;
  try {
    return JSON.stringify(data) || "Sandbox stream returned an error event without details.";
  } catch {
    return "Sandbox stream returned an error event without details.";
  }
}
function toProducerWireEvent(event) {
  return event;
}
function sandboxStreamFailureDiagnostic(error) {
  const streamMessage = error?.streamMessage;
  const message = typeof streamMessage === "string" ? streamMessage : error instanceof Error ? error.message : "Sandbox stream failed";
  const diagnostics = asRecord(error?.diagnostics);
  let diagnosticText;
  if (diagnostics) {
    try {
      diagnosticText = JSON.stringify(diagnostics);
    } catch {
      diagnosticText = "[unserializable diagnostics]";
    }
  }
  const userMessage = [
    "The sandbox model stream stopped before a clean completion.",
    `Error: ${message}`,
    "Please retry. If it repeats, send these support details to the team."
  ].join("\n\n");
  const failureNote = diagnosticText ? `sandbox-stream: ${message}; ${diagnosticText}` : `sandbox-stream: ${message}`;
  const code = error instanceof ModelFailoverTimeoutError ? error.code : "sandbox.stream_failed";
  return { userMessage, failureNote, code };
}
function createSandboxChatProducer(options) {
  const log = options.log ?? ((message, meta) => console.error(message, meta ?? ""));
  const renderable = options.isRenderableInteraction ?? isRenderableInteractionKind;
  if (options.openEvents && !options.model) {
    throw new Error(
      "createSandboxChatProducer: `openEvents` requires `model` \u2014 failover must know which model it is running"
    );
  }
  if (!options.openEvents && !options.events) {
    throw new Error("createSandboxChatProducer: pass `openEvents` (failover-capable) or `events`");
  }
  if (!options.openEvents && resolveEmptyTurnRetries(options.emptyTurnRetries) > 0) {
    throw new Error(
      "createSandboxChatProducer: `emptyTurnRetries` requires `openEvents` \u2014 a fixed `events` stream cannot be re-opened"
    );
  }
  const chain = options.model ? buildModelChain(options.model, options.modelFailover === false ? [] : options.fallbackModels ?? []) : [];
  const pendingModelNotices = [];
  let modelNoticeCount = 0;
  let failover;
  let source;
  if (options.openEvents) {
    failover = streamWithModelFailover({
      models: chain,
      open: options.openEvents,
      log,
      ...options.openTimeoutMs !== void 0 ? { openTimeoutMs: options.openTimeoutMs } : {},
      ...options.firstResponseTimeoutMs !== void 0 ? { firstResponseTimeoutMs: options.firstResponseTimeoutMs } : {},
      ...options.emptyTurnRetries !== void 0 ? { emptyTurnRetries: options.emptyTurnRetries } : {},
      ...options.onEmptyTurnRetry ? { onEmptyTurnRetry: options.onEmptyTurnRetry } : {},
      ...options.liveLifecycleEvents !== void 0 ? { liveLifecycleEvents: options.liveLifecycleEvents } : {},
      onFallback: (info) => {
        modelNoticeCount += 1;
        pendingModelNotices.push({
          id: `model-fallback-${modelNoticeCount}`,
          // Named models on both sides: a quality regression after a downgrade
          // must be attributable to the model that actually answered. The
          // REASON is condensed — a real edge 5xx arrives as Cloudflare's HTML
          // error page, and the raw text put `<!DOCTYPE html><!--[if lt IE 7]>…`
          // into the customer's transcript. The verbatim text is still on
          // `modelFailover.attempts[].reason` for the operator.
          text: `${info.from} was unavailable (${summarizeFailoverReason(info.reason)}) \u2014 answered with ${info.to} instead.`
        });
        options.onModelFallback?.(info);
      }
    });
    source = failover.events;
  } else {
    source = options.events;
  }
  const servingModel = () => failover?.servingModel() ?? options.model;
  let effectiveBackend;
  let substitutionNoticeQueued = false;
  const servedModel = () => effectiveBackend?.servedModel ?? servingModel();
  const captureEffectiveBackend = (data) => {
    if (!data) return;
    const parsed = parseEffectiveBackend(data);
    if (!parsed) return;
    effectiveBackend = parsed;
    const sentModel = servingModel();
    if (substitutionNoticeQueued || !options.model || !sentModel || !parsed.servedModel || parsed.servedModel === sentModel) return;
    substitutionNoticeQueued = true;
    pendingModelNotices.push({
      id: "model-substitution-1",
      text: `Requested ${sentModel} \u2014 the sandbox answered with ${parsed.servedModel} instead.`
    });
  };
  let fullText = "";
  const partOrder = [];
  const partMap = /* @__PURE__ */ new Map();
  const tracker = { seen: /* @__PURE__ */ new Map() };
  const usage = {};
  const announcedToolArgs = /* @__PURE__ */ new Map();
  const settledTools = /* @__PURE__ */ new Set();
  let stepCounter = 0;
  let danglingToolsTerminalized = false;
  let interactionOutcome = "answered";
  let warningCount = 0;
  const promotedFileParts = /* @__PURE__ */ new Map();
  function recordPersistedPart(part, delta, keyOverride) {
    const persisted = normalizePersistedPart(part);
    if (!persisted) return;
    const key = keyOverride ?? getPartKey(persisted);
    if (!partMap.has(key)) partOrder.push(key);
    partMap.set(key, mergePersistedPart(partMap.get(key), persisted, delta));
  }
  function* emitTerminalizedTools() {
    if (danglingToolsTerminalized) return;
    danglingToolsTerminalized = true;
    const updates = terminalizeDanglingAssistantToolUpdates(partOrder, partMap, fullText);
    for (const part of updates) {
      const toolId = asString(part.id);
      if (!toolId || settledTools.has(toolId)) continue;
      settledTools.add(toolId);
      const state = asRecord(part.state);
      yield {
        type: "tool_result",
        toolCallId: toolId,
        toolName: asString(part.tool) ?? "tool",
        outcome: {
          ok: false,
          ...asString(state?.error) ? { message: asString(state?.error) } : {}
        }
      };
    }
  }
  function* emitFinalUsage() {
    const promptTokens = usage.inputTokens ?? 0;
    const completionTokens = usage.outputTokens ?? 0;
    if (promptTokens || completionTokens) {
      yield {
        type: "usage",
        usage: {
          promptTokens,
          completionTokens,
          ...usage.reasoningTokens !== void 0 ? { reasoningTokens: usage.reasoningTokens } : {},
          ...usage.costUsd !== void 0 ? { providerCostUsd: usage.costUsd } : {}
        }
      };
    }
  }
  function* drainModelNotices() {
    while (pendingModelNotices.length > 0) {
      const queued = pendingModelNotices.shift();
      const notice = noticePart("warning", queued.id, queued.text);
      recordPersistedPart(notice, void 0, noticePartKey(notice.id));
      yield { type: "notice", id: notice.id, noticeKind: "warning", text: queued.text };
    }
  }
  async function* stream() {
    try {
      for await (const raw of source) {
        const record2 = asRecord(raw);
        captureEffectiveBackend(asRecord(record2?.data));
        yield* drainModelNotices();
        if (!record2 || typeof record2.type !== "string") continue;
        const normalized = normalizeToolEvent({ type: record2.type, data: asRecord(record2.data) });
        const event = normalized.type === "message.part.updated" ? normalized : { type: record2.type, data: asRecord(record2.data) };
        if (event.type === "message.part.updated") {
          const part = asRecord(event.data?.part);
          if (!part) continue;
          const rawDelta = event.data?.delta;
          const partType = String(part.type ?? "");
          if (partType === "text" || partType === "reasoning") {
            const key = getPartKey(part);
            const delta = textDelta(tracker, key, part, rawDelta);
            recordPersistedPart(part, delta || void 0);
            if (delta) {
              if (partType === "text") fullText += delta;
              yield { type: partType, text: delta };
            }
            continue;
          }
          if (partType === "tool") {
            recordPersistedPart(part, void 0);
            const persisted = partMap.get(getPartKey(part));
            const state = asRecord(persisted?.state);
            const toolId = String(persisted?.id ?? "");
            const toolName = String(persisted?.tool ?? "tool");
            const args = asRecord(state?.input) ?? {};
            const hasPopulatedArgs = Object.keys(args).length > 0;
            const announcedWithPopulatedArgs = announcedToolArgs.get(toolId);
            if (toolId && (announcedWithPopulatedArgs === void 0 || !announcedWithPopulatedArgs && hasPopulatedArgs && !settledTools.has(toolId))) {
              announcedToolArgs.set(toolId, hasPopulatedArgs);
              yield {
                type: "tool_call",
                call: { toolCallId: toolId, toolName, args }
              };
            }
            const status = String(state?.status ?? "");
            if (toolId && (status === "completed" || status === "error") && !settledTools.has(toolId)) {
              settledTools.add(toolId);
              yield {
                type: "tool_result",
                toolCallId: toolId,
                toolName,
                outcome: {
                  ok: status === "completed",
                  ...state?.output !== void 0 ? { result: state.output } : {},
                  ...asString(state?.error) ? { message: asString(state?.error) } : {}
                }
              };
            }
            continue;
          }
          if (partType === "step-finish") {
            addStepFinishUsage(part, usage);
            recordPersistedPart(part, void 0, `step-finish:#${stepCounter++}`);
            const promptTokens = usage.inputTokens ?? 0;
            const completionTokens = usage.outputTokens ?? 0;
            if (promptTokens || completionTokens) {
              yield {
                type: "usage",
                usage: {
                  promptTokens,
                  completionTokens,
                  ...usage.reasoningTokens !== void 0 ? { reasoningTokens: usage.reasoningTokens } : {},
                  ...usage.costUsd !== void 0 ? { providerCostUsd: usage.costUsd } : {}
                }
              };
            }
            continue;
          }
          if (partType === "step-start") {
            recordPersistedPart(part, void 0, `step-start:#${stepCounter}`);
            continue;
          }
          if (partType === "file" && options.promoteFilePart) {
            const promote = options.promoteFilePart;
            const rawId = asString(part.id);
            const rawUrl = asString(part.url);
            const memoKey = rawId ? `id:${rawId}` : rawUrl ? `url:${rawUrl}` : void 0;
            const attempt = () => Promise.resolve().then(() => promote(part)).catch((err) => {
              const reason = err instanceof Error ? err.message : String(err);
              log("[chat-routes] file part promotion threw", { key: memoKey ?? "(keyless)", error: reason });
              return { succeeded: false, reason };
            });
            let pending;
            if (memoKey) {
              pending = promotedFileParts.get(memoKey) ?? attempt();
              promotedFileParts.set(memoKey, pending);
            } else {
              pending = attempt();
            }
            const outcome = await pending;
            if (outcome.succeeded) {
              recordPersistedPart(outcome.part, void 0, outcome.key);
            } else if (outcome.part) {
              recordPersistedPart(outcome.part, void 0, outcome.key);
            } else {
              recordPersistedPart(part, void 0);
            }
            continue;
          }
          recordPersistedPart(part, void 0);
          continue;
        }
        if (event.type === "interaction") {
          const parsed = parseInteractionRequest(asRecord(record2.data));
          if (!parsed.succeeded) {
            log("[chat-routes] dropping malformed interaction event", { error: parsed.error });
            continue;
          }
          if (renderable(parsed.value.kind)) {
            recordPersistedPart(
              interactionToPersistedPart(parsed.value, "pending"),
              void 0,
              interactionPartKey(parsed.value.id)
            );
            yield toProducerWireEvent(record2);
            continue;
          }
          let declineFailed = false;
          if (options.declineInteraction) {
            try {
              await options.declineInteraction(parsed.value.id);
            } catch (err) {
              declineFailed = true;
              log("[chat-routes] failed to auto-decline interaction", {
                id: parsed.value.id,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          } else {
            declineFailed = true;
            log("[chat-routes] non-renderable interaction with no declineInteraction wired", {
              id: parsed.value.id,
              kind: parsed.value.kind
            });
          }
          const text = declineFailed ? `The agent requested ${parsed.value.kind} approval; declining it failed \u2014 it will expire on its own.` : `The agent requested ${parsed.value.kind} approval \u2014 auto-declined by policy.`;
          const notice = noticePart("auto-declined", `auto-declined-${parsed.value.id}`, text);
          recordPersistedPart(notice, void 0, noticePartKey(notice.id));
          yield { type: "notice", id: notice.id, noticeKind: "auto-declined", text };
          continue;
        }
        if (event.type === "interaction.cancel") {
          const parsed = parseInteractionCancel(asRecord(record2.data));
          if (!parsed.succeeded) {
            log("[chat-routes] dropping malformed interaction.cancel event", { error: parsed.error });
            continue;
          }
          const key = interactionPartKey(parsed.value.id);
          const existing = partMap.get(key);
          if (existing?.type === "interaction" && existing.status === "pending") {
            recordPersistedPart({
              ...existing,
              status: cancelStatusFor(parsed.value.reason),
              ...parsed.value.reason ? { cancelReason: parsed.value.reason } : {}
            }, void 0, key);
          }
          yield toProducerWireEvent(record2);
          continue;
        }
        if (event.type === "plan.submitted") {
          const parsed = parsePlanSubmittedEvent(record2);
          if (!parsed.succeeded) {
            log("[chat-routes] dropping malformed plan.submitted event", { error: parsed.error });
            continue;
          }
          recordPersistedPart(planToPersistedPart(parsed.value), void 0);
          yield toProducerWireEvent(record2);
          continue;
        }
        if (event.type === "warning") {
          const message = asString(event.data?.message);
          if (message) {
            warningCount += 1;
            const code = asString(event.data?.code);
            const text = code ? `${code}: ${message}` : message;
            const notice = noticePart("warning", `warning-${warningCount}`, text);
            recordPersistedPart(notice, void 0, noticePartKey(notice.id));
            yield { type: "notice", id: notice.id, noticeKind: "warning", text };
          }
          yield toProducerWireEvent(record2);
          continue;
        }
        if (event.type === "usage") {
          const reported = extractUsageSnapshot(asRecord(record2.usage));
          if (reported) applyTerminalUsage(reported, usage);
          yield toProducerWireEvent(record2);
          continue;
        }
        if (event.type === "result") {
          const finalText = asString(event.data?.finalText);
          if (finalText) fullText = finalText;
          const reported = extractReportedTurnUsage(asRecord(event.data));
          if (reported) {
            applyTerminalUsage(reported, usage);
            yield* emitFinalUsage();
          } else {
            const resultUsage = asRecord(event.data?.usage);
            if (resultUsage) {
              const input = Number(resultUsage.inputTokens);
              const output = Number(resultUsage.outputTokens);
              if (Number.isFinite(input)) usage.inputTokens = input;
              if (Number.isFinite(output)) usage.outputTokens = output;
            }
          }
          yield* emitTerminalizedTools();
          continue;
        }
        if (event.type === "done") {
          const reported = extractReportedTurnUsage(asRecord(event.data));
          if (reported) {
            applyTerminalUsage(reported, usage);
            yield* emitFinalUsage();
          }
          yield* emitTerminalizedTools();
          yield toProducerWireEvent(record2);
          continue;
        }
        if (event.type === "error") {
          const message = sandboxStreamErrorMessage(event.data);
          const errorContent = fullText.trim() ? `The sandbox model stream stopped before a clean completion.

Error: ${message}` : `The sandbox agent returned an error before producing a visible answer.

Error: ${message}`;
          const errorDelta = fullText ? `

---
${errorContent}` : errorContent;
          fullText += errorDelta;
          interactionOutcome = "expired";
          yield { type: "text", text: errorDelta };
          yield* emitTerminalizedTools();
          yield toProducerWireEvent(record2);
          continue;
        }
        yield toProducerWireEvent(record2);
      }
      yield* drainModelNotices();
    } catch (streamErr) {
      const diagnostic = sandboxStreamFailureDiagnostic(streamErr);
      log("[chat-routes] sandbox stream failed", {
        failureNote: diagnostic.failureNote,
        error: streamErr instanceof Error ? streamErr.message : String(streamErr)
      });
      const errorDelta = fullText ? `

---
${diagnostic.userMessage}` : diagnostic.userMessage;
      fullText += errorDelta;
      interactionOutcome = "expired";
      yield { type: "text", text: errorDelta };
      yield* emitTerminalizedTools();
      yield {
        type: "error",
        data: {
          message: diagnostic.userMessage,
          code: diagnostic.code,
          details: { failureNote: diagnostic.failureNote }
        }
      };
    }
  }
  return {
    stream: stream(),
    finalText: () => fullText,
    assistantParts: () => finalizePendingInteractionParts(
      finalizeAssistantParts(partOrder, partMap, fullText),
      interactionOutcome
    ),
    // Mid-stream snapshot for incremental persistence: the same accumulators,
    // WITHOUT the two completion-time settlements (`terminalizeDanglingTool*`
    // and `finalizePendingInteractionParts`). A running tool and an unanswered
    // ask are the correct live state; settling them early would persist
    // phantom failures the final write then reverses.
    draftParts: () => draftAssistantParts(partOrder, partMap, fullText),
    usage: () => usage,
    // A GETTER, not a captured value: `turn-routes` reads `producer.model` at
    // draft-snapshot and persist time, both of which happen after the stream
    // resolved which model serves. A plain property would freeze the PREFERRED
    // model into the row and make a downgrade unattributable — the exact
    // failure mode this work exists to prevent.
    get model() {
      return servedModel();
    },
    modelFailover: () => ({
      model: servingModel(),
      attempts: failover?.attempts() ?? [],
      usedFallback: failover?.usedFallback() ?? false
    }),
    modelAttribution: () => ({
      ...options.model ? { requestedModel: options.model } : {},
      ...effectiveBackend ?? {},
      echoReceived: effectiveBackend !== void 0
    })
  };
}

// src/chat-routes/protected-runtime-producer.ts
import { createExecutor, streamAgentTurn } from "@tangle-network/agent-runtime/kernel";
import {
  runProtectedAgentCandidateModelGrant
} from "@tangle-network/agent-runtime/candidate-execution";
function createProtectedRuntimeChatProducer(options) {
  if (!Number.isSafeInteger(options.maxToolCalls) || options.maxToolCalls < 0) {
    throw new Error("maxToolCalls must be a non-negative integer");
  }
  options = {
    ...options,
    grant: { ...options.grant, resolve: structuredClone(options.grant.resolve), reserve: structuredClone(options.grant.reserve) },
    tools: options.tools.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) })),
    priorMessages: options.priorMessages ? structuredClone(options.priorMessages) : void 0
  };
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (tools.size !== options.tools.length) throw new Error("Duplicate protected tool name");
  const profile = structuredClone(options.profile);
  let toolCalls = 0;
  let usage = {};
  let started = false;
  let model;
  let budgetEnforced = false;
  let toolTokens;
  async function* events() {
    if (started) throw new Error("A protected chat producer can only execute once");
    started = true;
    const controller = new AbortController();
    options.signal?.throwIfAborted();
    if (Date.now() >= options.grant.deadlineAtMs) throw new Error("Protected execution deadline expired");
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, options.grant.deadlineAtMs - Date.now())),
      ...options.signal ? [options.signal] : []
    ]);
    const channel = new TransformStream();
    const writer = channel.writable.getWriter();
    const reader = channel.readable.getReader();
    const emit = (event) => writer.write(event);
    const execution = runProtectedAgentCandidateModelGrant({
      ...options.grant,
      port: {
        resolve: (input) => options.grant.port.resolve(input),
        reserveGrant: (input) => options.grant.port.reserveGrant(input),
        activateGrant: (input) => options.grant.port.activateGrant(input),
        // Runtime settles failed executions before rethrowing. Retain that receipt too.
        settleGrant: async (input) => {
          let auditError;
          const settlement = await options.grant.port.settleGrant(input).catch((error) => {
            if (!(error instanceof ProtectedModelSettlementError)) throw error;
            auditError = error;
            return error.settlement;
          });
          usage = {
            inputTokens: settlement.calls.reduce((sum2, call) => sum2 + call.accountedInputTokens, 0),
            outputTokens: settlement.calls.reduce((sum2, call) => sum2 + call.outputTokens, 0),
            reasoningTokens: settlement.calls.reduce((sum2, call) => sum2 + call.reasoningTokens, 0),
            costUsd: settlement.calls.reduce((sum2, call) => sum2 + call.costUsdNanos, 0) / 1e9
          };
          budgetEnforced = settlement.usageWithinLimits;
          if (!budgetEnforced) throw new Error("Provider settlement exceeded execution limits");
          if (auditError) throw auditError;
          return settlement;
        }
      },
      execute: async ({ activation, resolved }) => {
        signal.throwIfAborted();
        if (Date.now() >= options.grant.deadlineAtMs) throw new Error("Protected execution deadline expired");
        model = resolved.model;
        if (resolved.provider !== "anthropic" || resolved.reasoningEffort !== "none") {
          throw new Error("Protected chat currently requires Anthropic without reasoning");
        }
        toolTokens = 0;
        const apiKey = activation.env.OPENAI_API_KEY;
        const baseUrl = activation.env.OPENAI_BASE_URL;
        if (!apiKey || !baseUrl) throw new Error("Protected Router activation is missing");
        const factory = createExecutor({
          backend: "router-tools",
          routerBaseUrl: baseUrl,
          routerKey: apiKey,
          tools: options.tools.map((tool) => ({
            type: "function",
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
          })),
          ...options.priorMessages?.length ? { initialMessages: options.priorMessages } : {},
          executeToolCall: async (name, args) => {
            signal.throwIfAborted();
            const tool = tools.get(name);
            if (!tool) throw new Error("Tool is not authorized for this execution");
            if (toolCalls >= options.maxToolCalls) {
              controller.abort(new Error("Execution tool-call limit reached"));
              signal.throwIfAborted();
            }
            toolCalls += 1;
            const id = `tool-${toolCalls}`;
            await emit({ type: "tool_call", data: { id, name, arguments: args } });
            try {
              const result = await tool.run(args, { signal });
              await emit({ type: "tool_result", data: { id, name, output: result } });
              return JSON.stringify(result);
            } catch (error) {
              const message = error instanceof Error ? error.message : "Tool failed";
              await emit({ type: "tool_result", data: { id, name, error: message } });
              throw error;
            }
          }
        });
        let completed = false;
        let streamedText = "";
        for await (const event of streamAgentTurn(
          { kind: "executor", factory, profile },
          { prompt: options.prompt },
          {
            signal,
            callId: options.grant.reserve.executionId,
            timeoutMs: Math.max(1, options.grant.deadlineAtMs - Date.now())
          }
        )) {
          if (event.type === "text_delta") streamedText += event.text;
          if (event.type === "text_delta" || event.type === "reasoning_delta") {
            await emit({ type: "message.part.updated", data: {
              part: { id: event.type, type: event.type === "text_delta" ? "text" : "reasoning" },
              delta: event.text
            } });
          }
          if (event.type === "final") {
            if (event.status !== "completed") throw new Error(`Protected execution ${event.status}`);
            if (event.text !== void 0) {
              if (!event.text.startsWith(streamedText)) {
                throw new Error("Protected execution revised already streamed text");
              }
              const suffix = event.text.slice(streamedText.length);
              if (suffix) await emit({ type: "message.part.updated", data: {
                part: { id: "text_delta", type: "text" },
                delta: suffix
              } });
              streamedText = event.text;
            }
            completed = true;
            await emit({ type: "result", data: { finalText: event.text } });
          }
        }
        if (!completed) throw new Error("Protected execution ended without a terminal result");
      }
    }).then(async () => {
      await writer.close();
    }).catch((error) => writer.abort(error));
    try {
      for (; ; ) {
        const next = await reader.read();
        if (next.done) break;
        yield next.value;
      }
      await execution;
    } finally {
      controller.abort();
      await reader.cancel().catch(() => void 0);
      await execution;
      reader.releaseLock();
      writer.releaseLock();
    }
  }
  const producer = createSandboxChatProducer({ events: events(), model: profile.model?.default });
  return {
    ...producer,
    stream: (async function* () {
      let failure;
      for await (const event of producer.stream) {
        if (event.type === "error") failure = event;
        else yield event;
      }
      if (usage.inputTokens !== void 0 && usage.outputTokens !== void 0 && usage.costUsd !== void 0) {
        yield { type: "usage", usage: {
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          providerCostUsd: usage.costUsd,
          reasoningTokens: usage.reasoningTokens,
          toolTokens,
          toolCallCount: toolCalls,
          budgetEnforced
        } };
      }
      if (failure) yield failure;
    })(),
    get model() {
      return model ?? profile.model?.default;
    },
    usage: () => ({ ...usage })
  };
}

// src/chat-routes/detached-turn.ts
var TERMINAL_ERROR_TYPES = /* @__PURE__ */ new Set(["error", "session.run.failed"]);
function errorMessageOf(ev) {
  const rec = ev;
  const raw = rec?.data?.message ?? rec?.data?.reason ?? rec?.message;
  return typeof raw === "string" && raw ? raw : "run failed";
}
function hasUsage(usage) {
  return typeof usage.inputTokens === "number" && usage.inputTokens > 0;
}
function cachedResultFrom(final, persisted) {
  if (!final && !persisted) {
    throw new Error("Completed turn has no retained result or assistant row; retry exact recovery");
  }
  const usage = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "costUsd"
  ]) {
    const value = final?.usage?.[key] ?? persisted?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
  }
  return {
    state: "completed",
    text: final?.text ?? persisted?.content ?? "",
    parts: final?.parts ?? persisted?.parts ?? [],
    usage,
    cached: true
  };
}
async function runDetachedTurn(opts) {
  const { store, turnId, scopeId } = opts;
  let producer;
  const servingModel = () => producer?.model ?? opts.model;
  const persistedRow = async () => {
    if (!opts.persist) return void 0;
    return (await opts.persist.store.listMessages(opts.persist.threadId)).find(
      (message) => message.id === (opts.persist?.messageId ?? assistantRowIdForTurn(turnId))
    );
  };
  let draft;
  if (opts.persist) {
    const { store: persistStore, threadId, messageId, transformText, ...tuning } = opts.persist;
    if (!storeSupportsDraftPersistence(persistStore)) {
      throw new Error(
        "runDetachedTurn persist requires a store with updateMessage() \u2014 `/chat-store`'s createChatStore has it"
      );
    }
    draft = createAssistantDraftWriter({
      ...tuning,
      store: persistStore,
      threadId,
      messageId: messageId ?? assistantRowIdForTurn(turnId),
      snapshot: () => producer ? {
        content: producer.finalText?.() ?? "",
        ...producer.draftParts ? { parts: producer.draftParts() } : {},
        ...producer.usage ? { usage: producer.usage() } : {},
        ...servingModel() ? { model: servingModel() } : {}
      } : null,
      ...transformText ? { transformText } : {},
      ...opts.log ? { log: opts.log } : {}
    });
  }
  const settleRow = async (base, cachedPersisted) => {
    const persisted = cachedPersisted ?? (!producer ? await persistedRow() : void 0);
    const info = producer?.modelFailover?.();
    const attribution2 = producer?.modelAttribution?.();
    const model = producer?.model ?? persisted?.model ?? opts.model;
    const requestedModel = attribution2?.requestedModel ?? persisted?.requestedModel ?? opts.model;
    const servedModel = attribution2?.servedModel ?? persisted?.servedModel;
    const servedProvider = attribution2?.servedProvider ?? persisted?.servedProvider;
    const servedSource = attribution2?.servedSource ?? (persisted?.servedSource === "request" || persisted?.servedSource === "environment" || persisted?.servedSource === "profile" ? persisted.servedSource : void 0);
    const result = {
      ...base,
      ...model ? { model } : {},
      ...requestedModel ? { requestedModel } : {},
      ...servedModel ? { servedModel } : {},
      ...servedProvider ? { servedProvider } : {},
      ...servedSource ? { servedSource } : {},
      ...info ? { usedModelFallback: info.usedFallback, modelAttempts: info.attempts } : {}
    };
    if (!draft) return result;
    const transform = opts.persist?.transformText;
    const content = transform ? await transform(result.text) : result.text;
    const rawParts = transform ? await Promise.all(
      result.parts.map(
        async (part) => String(part.type ?? "") === "text" ? { ...part, text: await transform(String(part.text ?? "")) } : part
      )
    ) : result.parts;
    const parts2 = toChatMessageParts(rawParts);
    if (!content.trim() && parts2.length === 0) {
      await draft.discard();
      return { ...result, messageId: null };
    }
    const values = {
      content,
      ...parts2.length > 0 ? { parts: parts2 } : {},
      ...result.model ? { model: result.model } : {},
      ...result.requestedModel ? { requestedModel: result.requestedModel } : {},
      ...result.servedModel ? { servedModel: result.servedModel } : {},
      ...result.servedProvider ? { servedProvider: result.servedProvider } : {},
      ...result.servedSource ? { servedSource: result.servedSource } : {},
      ...result.usage.inputTokens !== void 0 ? { inputTokens: result.usage.inputTokens } : {},
      ...result.usage.outputTokens !== void 0 ? { outputTokens: result.usage.outputTokens } : {},
      ...result.usage.reasoningTokens !== void 0 ? { reasoningTokens: result.usage.reasoningTokens } : {},
      ...result.usage.cacheReadTokens !== void 0 ? { cacheReadTokens: result.usage.cacheReadTokens } : {},
      ...result.usage.cacheWriteTokens !== void 0 ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {},
      ...result.usage.costUsd !== void 0 ? { costUsd: result.usage.costUsd } : {}
    };
    await draft.finalize(values);
    return { ...result, messageId: draft.rowId() ?? null };
  };
  const completed = async () => {
    if (!opts.completedResult) return null;
    return await opts.completedResult() ?? null;
  };
  const prior = await store.getStatus(turnId);
  if (prior === "complete") {
    const persisted = await persistedRow();
    return await settleRow(
      cachedResultFrom(await completed(), persisted),
      persisted
    );
  }
  if (prior === "running") {
    const final = await completed();
    if (final) {
      await store.setStatus(turnId, "complete", scopeId);
      const persisted = await persistedRow();
      return await settleRow(cachedResultFrom(final, persisted), persisted);
    }
    if (!opts.resetBuffer) {
      throw new Error("Detached turn recovery requires resetBuffer before replaying an existing stream");
    }
    await opts.resetBuffer(turnId);
  }
  const tap = createBufferedTurnTap({
    store,
    turnId,
    scopeId,
    coalesce: opts.coalesce ?? coalesceDeltas
  });
  await tap.onEvent({ type: "turn", turnId });
  producer = createSandboxChatProducer({
    ...opts.openEvents ? { openEvents: opts.openEvents } : { events: opts.events },
    model: opts.model,
    ...opts.fallbackModels ? { fallbackModels: opts.fallbackModels } : {},
    ...opts.modelFailover === false ? { modelFailover: false } : {},
    ...opts.openTimeoutMs !== void 0 ? { openTimeoutMs: opts.openTimeoutMs } : {},
    ...opts.firstResponseTimeoutMs !== void 0 ? { firstResponseTimeoutMs: opts.firstResponseTimeoutMs } : {},
    ...opts.onModelFallback ? { onModelFallback: opts.onModelFallback } : {},
    isRenderableInteraction: opts.isRenderableInteraction,
    declineInteraction: opts.declineInteraction,
    promoteFilePart: opts.promoteFilePart,
    log: opts.log
  });
  let runError;
  try {
    for await (const ev of producer.stream) {
      const type = ev.type;
      if (typeof type === "string" && TERMINAL_ERROR_TYPES.has(type)) runError = errorMessageOf(ev);
      await tap.onEvent(ev);
      draft?.notify(ev);
    }
    await tap.done(runError ? "error" : "complete");
  } catch (err) {
    await tap.done("error").catch(() => {
    });
    await draft?.close().catch(() => {
    });
    throw err;
  }
  const text = producer.finalText?.() ?? "";
  const parts = producer.assistantParts?.() ?? [];
  let usage = producer.usage?.() ?? {};
  const onlyTextParts = parts.every(
    (part) => String(part.type ?? "") === "text"
  );
  if (!runError && (!hasUsage(usage) || !text || onlyTextParts)) {
    const final = await completed();
    if (final?.usage) usage = { ...usage, ...final.usage };
    return await settleRow({
      state: "completed",
      text: final?.text ?? text,
      parts: final?.parts?.length ? final.parts : parts,
      usage,
      cached: false
    });
  }
  if (runError) return await settleRow({ state: "failed", text, parts, usage, error: runError, cached: false });
  return await settleRow({ state: "completed", text, parts, usage, cached: false });
}

// src/chat-routes/completed-sandbox-turn.ts
function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
  if (typeof value !== "string" || !value.trim()) return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function firstNumber(record2, keys) {
  for (const key of keys) {
    const value = finiteNumber(record2?.[key]);
    if (value !== void 0) return value;
  }
  return void 0;
}
function usageFromResult(result) {
  const raw = asRecord(result?.usage) ?? asRecord(result?.tokenUsage);
  const inputTokens = firstNumber(raw, ["inputTokens", "promptTokens", "input"]);
  const outputTokens = firstNumber(raw, ["outputTokens", "completionTokens", "output"]);
  const reasoningTokens = firstNumber(raw, ["reasoningTokens", "reasoning"]);
  const cacheReadTokens = firstNumber(raw, [
    "cacheReadTokens",
    "cacheReadInputTokens",
    "cacheRead"
  ]);
  const cacheWriteTokens = firstNumber(raw, [
    "cacheWriteTokens",
    "cacheCreationInputTokens",
    "cacheWrite"
  ]);
  const costUsd = firstNumber(result, ["costUsd", "totalCostUsd", "cost"]) ?? firstNumber(raw, ["costUsd", "cost"]);
  return {
    ...inputTokens !== void 0 ? { inputTokens } : {},
    ...outputTokens !== void 0 ? { outputTokens } : {},
    ...reasoningTokens !== void 0 ? { reasoningTokens } : {},
    ...cacheReadTokens !== void 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens !== void 0 ? { cacheWriteTokens } : {},
    ...costUsd !== void 0 ? { costUsd } : {}
  };
}
function textFromResult(result) {
  return asString(result?.response) ?? asString(result?.finalText) ?? asString(result?.text) ?? asString(result?.output);
}
function completedMessagesForTurn(messages, turnId) {
  return messages.filter(
    (message) => message.role === "assistant" && message.metadata?.turnId === turnId && message.metadata?.interrupted !== true && (message.metadata?.completed === true || message.metadata?.status === "completed")
  );
}
function normalizedMessageParts(message) {
  const normalized = [];
  const usage = {};
  for (const raw of message.parts) {
    const record2 = asRecord(raw);
    if (!record2) continue;
    const part = normalizePersistedPart(record2);
    if (!part) continue;
    normalized.push(part);
    if (part.type === "step-finish") addStepFinishUsage(part, usage);
  }
  const collapsed = collapseRedundantTextParts(normalized);
  const derivedText = collapsed.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("");
  return { parts: normalized, usage, derivedText };
}
function projectMessageParts(parts, finalText) {
  const order = [];
  const map = /* @__PURE__ */ new Map();
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const type = String(part.type ?? "");
    const key = type === "step-start" || type === "step-finish" ? `${type}:#${index}` : getPartKey(part);
    if (!map.has(key)) order.push(key);
    map.set(key, mergePersistedPart(map.get(key), part));
  }
  return finalizeAssistantParts(order, map, finalText);
}
function recoverSandboxAssistantMessage(message) {
  const recovered = normalizedMessageParts(message);
  return {
    ...recovered.derivedText ? { text: recovered.derivedText } : {},
    ...hasUsage2(recovered.usage) ? { usage: recovered.usage } : {},
    parts: projectMessageParts(recovered.parts, recovered.derivedText)
  };
}
function hasUsage2(usage) {
  return Object.values(usage).some(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
}
async function readCompletedSandboxTurn(box, options) {
  const { turnId, sessionId, log } = options;
  const session = box.session(sessionId);
  const [cacheOutcome, messagesOutcome] = await Promise.allSettled([
    box.findCompletedTurn(turnId, { sessionId }),
    session.messages({ limit: 1e3 })
  ]);
  if (cacheOutcome.status === "rejected") {
    log?.("[chat-routes] completed Sandbox turn cache lookup failed", {
      turnId,
      sessionId,
      error: String(cacheOutcome.reason)
    });
  }
  if (messagesOutcome.status === "rejected") {
    log?.("[chat-routes] completed Sandbox session message lookup failed", {
      turnId,
      sessionId,
      error: String(messagesOutcome.reason)
    });
  }
  const rawCached = cacheOutcome.status === "fulfilled" ? cacheOutcome.value : null;
  const cached = rawCached && rawCached.turnId === turnId && rawCached.sessionId === sessionId ? rawCached : null;
  if (rawCached && !cached) {
    log?.("[chat-routes] ignored mismatched completed Sandbox turn cache record", {
      turnId,
      sessionId
    });
  }
  const messages = messagesOutcome.status === "fulfilled" ? messagesOutcome.value : [];
  const matchingMessages = completedMessagesForTurn(messages, turnId);
  const matchingCount = matchingMessages.length;
  const message = matchingCount === 1 ? matchingMessages[0] : null;
  if (matchingCount > 1) {
    log?.("[chat-routes] ignored ambiguous completed Sandbox session messages", {
      turnId,
      sessionId,
      matchingCount
    });
  }
  if (!cached && !message) {
    if (cacheOutcome.status === "rejected" || messagesOutcome.status === "rejected") {
      throw new Error("Completed Sandbox turn could not be verified; retry the exact read");
    }
    if (rawCached || matchingCount > 1) {
      throw new Error("Completed Sandbox turn identity is inconsistent; reconciliation is required");
    }
    return null;
  }
  const result = cached ? asRecord(cached.result) : void 0;
  const recovered = message ? normalizedMessageParts(message) : null;
  const text = textFromResult(result) ?? recovered?.derivedText;
  const resultUsage = usageFromResult(result);
  const usage = { ...recovered?.usage ?? {}, ...resultUsage };
  const resultParts = Array.isArray(result?.parts) ? result.parts.map((part) => asRecord(part)).filter((part) => Boolean(part)).map((part) => normalizePersistedPart(part)).filter((part) => Boolean(part)) : null;
  const sourceParts = recovered?.parts ?? resultParts;
  const parts = sourceParts ? projectMessageParts(sourceParts, text ?? recovered?.derivedText ?? "") : void 0;
  return {
    ...text !== void 0 ? { text } : {},
    ...hasUsage2(usage) ? { usage } : {},
    ...parts ? { parts } : {}
  };
}

// src/chat-routes/native-completion.ts
var DEFAULT_ABSENT_DISPATCH_DEADLINE_MS = 10 * 6e4;
var DEFAULT_RECEIPT_DEADLINE_MS = 10 * 6e4;
function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function isSandboxNotFoundError(value) {
  const error = record(value);
  return error?.name === "NotFoundError" || error?.code === "NOT_FOUND" || error?.status === 404;
}
function attribution(result) {
  const metadata = record(result?.metadata);
  const modelAttribution = record(result?.modelAttribution) ?? record(metadata?.modelAttribution);
  const backend = record(result?.effectiveBackend) ?? record(metadata?.effectiveBackend);
  const source = nonEmptyString(result?.servedSource) ?? nonEmptyString(modelAttribution?.servedSource) ?? nonEmptyString(backend?.source);
  const servedSource = source === "request" || source === "environment" || source === "profile" ? source : void 0;
  const servedModel = nonEmptyString(result?.servedModel) ?? nonEmptyString(modelAttribution?.servedModel) ?? nonEmptyString(backend?.model);
  const servedProvider = nonEmptyString(result?.servedProvider) ?? nonEmptyString(modelAttribution?.servedProvider) ?? nonEmptyString(backend?.provider);
  return {
    ...servedModel ? { servedModel } : {},
    ...servedProvider ? { servedProvider } : {},
    ...servedSource ? { servedSource } : {}
  };
}
function usageFromResult2(result) {
  const raw = record(result?.usage) ?? record(result?.tokenUsage);
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
  return {
    ...number(raw?.inputTokens) !== void 0 ? { inputTokens: number(raw?.inputTokens) } : {},
    ...number(raw?.outputTokens) !== void 0 ? { outputTokens: number(raw?.outputTokens) } : {},
    ...number(raw?.cacheReadTokens) !== void 0 ? { cacheReadTokens: number(raw?.cacheReadTokens) } : {},
    ...number(raw?.cacheWriteTokens) !== void 0 ? { cacheWriteTokens: number(raw?.cacheWriteTokens) } : {},
    ...number(result?.costUsd) !== void 0 ? { costUsd: number(result?.costUsd) } : {}
  };
}
function interruptedMessages(messages, turnId) {
  return messages.filter(
    (message) => message.role === "assistant" && message.metadata?.turnId === turnId && (message.metadata.interrupted === true || message.metadata.status === "interrupted")
  );
}
function mergeUsage(messageUsage, resultUsage) {
  return { ...messageUsage, ...resultUsage };
}
function consistent(values) {
  if (values.length === 0 || values.some((value) => value === void 0)) return void 0;
  const first = values[0];
  return values.every((value) => value === first) ? first : void 0;
}
function sum(values) {
  if (values.some((value) => value === void 0)) return void 0;
  return values.reduce((total, value) => total + value, 0);
}
function aggregateNativeCompletionReceipts(turns) {
  const failed = turns.some((turn) => turn.state === "failed");
  const usage = {};
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"]) {
    const total = sum(turns.map((turn) => turn.usage[key]));
    if (total !== void 0) usage[key] = total;
  }
  const error = turns.find(
    (turn) => turn.error?.startsWith("Admitted native execution did not produce") || turn.error?.startsWith("Native Sandbox execution ledger is missing")
  )?.error ?? turns.find((turn) => turn.error)?.error;
  return {
    state: failed ? "failed" : "completed",
    text: turns.map((turn) => turn.text).join(""),
    parts: turns.flatMap((turn) => turn.parts),
    usage,
    ...consistent(turns.map((turn) => turn.servedModel)) ? { servedModel: consistent(turns.map((turn) => turn.servedModel)) } : {},
    ...consistent(turns.map((turn) => turn.servedProvider)) ? { servedProvider: consistent(turns.map((turn) => turn.servedProvider)) } : {},
    ...consistent(turns.map((turn) => turn.servedSource)) ? { servedSource: consistent(turns.map((turn) => turn.servedSource)) } : {},
    ...error ? { error } : {},
    completedTurnIds: turns.map((turn) => turn.turnId)
  };
}
function missingTurnReceipt(turnId, error) {
  return { turnId, state: "failed", text: "", parts: [], usage: {}, error };
}
async function observeNativeCompletion(options) {
  const now = options.now ?? Date.now();
  let admission = await options.admissionStore.read(options.executionId);
  if (!admission) throw new Error("Native completion admission is missing");
  if (admission.executionId !== options.executionId) throw new Error("Native completion admission identity conflict");
  const leaseUntil = timestamp(admission.ownerLeaseUntil) ?? 0;
  const source = options.source;
  const session = source?.session(options.sessionId);
  let status;
  if (!session) {
    status = null;
  } else {
    try {
      status = await session.status();
    } catch (error) {
      if (!isSandboxNotFoundError(error)) throw error;
      status = null;
    }
  }
  if (!status || !session || !source) {
    if (admission.state === "open" && leaseUntil <= now) {
      admission = await options.admissionStore.closeExpired(options.executionId, new Date(now)) ?? admission;
    }
    if (admission.state === "open" || now - options.registeredAt < (options.absentDispatchDeadlineMs ?? DEFAULT_ABSENT_DISPATCH_DEADLINE_MS)) {
      return { state: "running" };
    }
    return {
      state: "failed",
      receipt: aggregateNativeCompletionReceipts([
        missingTurnReceipt(options.turnId, "Native Sandbox dispatch was not observed before the admission deadline")
      ])
    };
  }
  const exactSession = session;
  if (admission.state === "open") {
    if (status.status === "queued" || status.status === "running") {
      admission = await options.admissionStore.renew(options.executionId, new Date(now)) ?? admission;
    } else if (leaseUntil <= now) {
      admission = await options.admissionStore.closeExpired(options.executionId, new Date(now)) ?? admission;
    }
    if (admission.state === "open") return { state: "running" };
  }
  const admittedTurnIds = [...admission.admittedTurnIds];
  if (admittedTurnIds.length === 0 || admittedTurnIds[0] !== options.turnId) {
    throw new Error("Native completion admission has an invalid turn sequence");
  }
  const runs = await exactSession.runs();
  const runsByTurnId = new Map(runs.map((run) => [run.executionId, run]));
  const missingExecution = admittedTurnIds.find((turnId) => !runsByTurnId.has(turnId));
  if (missingExecution && now - options.registeredAt < (options.absentDispatchDeadlineMs ?? DEFAULT_ABSENT_DISPATCH_DEADLINE_MS)) {
    return { state: "running" };
  }
  if (admittedTurnIds.some((turnId) => runsByTurnId.get(turnId)?.status === "active")) return { state: "running" };
  const messages = await exactSession.messages({ limit: 1e3 });
  const recovered = [];
  for (const turnId of admittedTurnIds) {
    const run = runsByTurnId.get(turnId);
    if (!run) {
      recovered.push(missingTurnReceipt(turnId, "Native Sandbox execution ledger is missing the admitted turn"));
      continue;
    }
    const completed = run.status === "completed" ? await readCompletedSandboxTurn(source, { turnId, sessionId: options.sessionId }) : null;
    const cached = run.status === "completed" ? await source.findCompletedTurn(turnId, { sessionId: options.sessionId }) : null;
    if (run.status === "completed" && completed) {
      recovered.push({
        turnId,
        state: "completed",
        text: completed.text ?? "",
        parts: completed.parts ?? [],
        usage: completed.usage ?? {},
        ...attribution(cached?.result)
      });
      continue;
    }
    const interrupted = interruptedMessages(messages, turnId);
    if ((run.status === "failed" || run.status === "cancelled") && interrupted.length === 1) {
      const message = recoverSandboxAssistantMessage(interrupted[0]);
      const result = await exactSession.result({ executionId: turnId });
      recovered.push({
        turnId,
        state: "failed",
        text: message.text ?? result.response ?? "",
        parts: message.parts ?? [],
        usage: mergeUsage(message.usage ?? {}, {
          ...usageFromResult2(result),
          ...result.costUsd !== void 0 ? { costUsd: result.costUsd } : {}
        }),
        ...attribution(result),
        error: result.error ?? interrupted[0].metadata?.interruptReason ?? status.failureReason?.message
      });
      continue;
    }
    const closedAt = timestamp(admission.closedAt) ?? timestamp(admission.updatedAt) ?? options.registeredAt;
    if (now - closedAt < (options.receiptDeadlineMs ?? DEFAULT_RECEIPT_DEADLINE_MS)) return { state: "running" };
    recovered.push(missingTurnReceipt(
      turnId,
      `Admitted native execution did not produce an exact completion: ${turnId}`
    ));
  }
  const receipt = aggregateNativeCompletionReceipts(recovered);
  return receipt.state === "completed" ? { state: "completed", receipt } : { state: "failed", receipt };
}

// src/chat-routes/durable-projection.ts
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function withDurableChatProjection(producer, projection, log = (message, meta) => console.error(message, meta ?? "")) {
  let projected = [];
  async function* stream() {
    for await (const event of producer.stream) {
      try {
        await projection.observe(event);
      } catch (error) {
        log("[chat-routes] durable projection observe failed", {
          eventType: event.type,
          error: errorMessage(error)
        });
      }
      yield event;
    }
    try {
      projected = await projection.materialize();
    } catch (error) {
      log("[chat-routes] durable projection materialize failed", {
        error: errorMessage(error)
      });
    }
  }
  return {
    ...producer,
    stream: stream(),
    assistantParts: () => {
      const parts = producer.assistantParts?.() ?? [];
      const order = [];
      const byKey = /* @__PURE__ */ new Map();
      for (const part of [...parts, ...projected]) {
        const key = getPartKey(part);
        if (!byKey.has(key)) order.push(key);
        byKey.set(key, mergePersistedPart(byKey.get(key), part));
      }
      return order.map((key) => byKey.get(key));
    }
  };
}

// src/chat-routes/upload.ts
var UPLOAD_INLINE_MAX_BYTES = 700 * 1024;
var UPLOAD_MAX_FILE_BYTES = 8 * 1024 * 1024;
var DEFAULT_UPLOAD_DIRECTORY = "/workspace/uploads";
function normalizeUploadDirectory(value) {
  const withoutTrailingSlash = value.trim().replace(/\/+$/, "");
  if (!withoutTrailingSlash.startsWith("/") || withoutTrailingSlash.length === 0) return null;
  const segments = withoutTrailingSlash.slice(1).split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  return `/${segments.join("/")}`;
}
function sanitizeUploadFilename(name) {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return (safe || "file").slice(0, 120);
}
var BASE64_CHUNK = 32768;
function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}
function uploadError(status, code, error) {
  return Response.json({ code, error }, { status });
}
function createUploadRoute(options) {
  const inlineMaxBytes = options.inlineMaxBytes ?? UPLOAD_INLINE_MAX_BYTES;
  const maxFileBytes = options.maxFileBytes ?? UPLOAD_MAX_FILE_BYTES;
  return async function upload(request) {
    const auth = await options.authorize({ request });
    if (!auth.ok) return auth.response;
    const sink = auth.sink ?? null;
    const configuredUploadDir = auth.uploadDir ?? options.uploadDir ?? DEFAULT_UPLOAD_DIRECTORY;
    let form;
    try {
      form = await request.formData();
    } catch {
      return uploadError(400, "INVALID_UPLOAD", "Expected a multipart/form-data body with file fields");
    }
    const files = [];
    form.forEach((value) => {
      if (value instanceof File) files.push(value);
    });
    if (files.length === 0) {
      return uploadError(400, "INVALID_UPLOAD", "No files in the upload body");
    }
    const uploaded = [];
    for (const file of files) {
      const name = sanitizeUploadFilename(file.name);
      const mediaType = file.type || "application/octet-stream";
      const partType = mediaType.startsWith("image/") ? "image" : "file";
      if (file.size > maxFileBytes) {
        return uploadError(
          413,
          "FILE_TOO_LARGE",
          `${name} is ${file.size}B, over the ${maxFileBytes}B per-file cap`
        );
      }
      const id = crypto.randomUUID();
      if (file.size <= inlineMaxBytes) {
        const base642 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
        uploaded.push({
          id,
          name,
          size: file.size,
          mediaType,
          inline: true,
          part: {
            type: partType,
            filename: name,
            mediaType,
            url: `data:${mediaType};base64,${base642}`
          }
        });
        continue;
      }
      if (!sink) {
        return uploadError(
          413,
          "SANDBOX_REQUIRED",
          `${name} is ${file.size}B, over the ${inlineMaxBytes}B inline cap, and no sandbox is available to hold it`
        );
      }
      const uploadDir = normalizeUploadDirectory(configuredUploadDir);
      if (!uploadDir) {
        return uploadError(
          500,
          "INVALID_UPLOAD_DIRECTORY",
          'uploadDir must be an absolute path without empty, "." or ".." segments'
        );
      }
      const path = `${uploadDir}/${id}-${name}`;
      const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      await sink.write(path, base64, { encoding: "base64" });
      uploaded.push({
        id,
        name,
        size: file.size,
        mediaType,
        inline: false,
        part: { type: partType, filename: name, mediaType, path }
      });
    }
    return Response.json({ files: uploaded });
  };
}

// src/chat-routes/attachment-store.ts
var ATTACHMENT_STORAGE_FAILURE_MESSAGE = "Attachment storage is temporarily unavailable. Please try again.";
var ATTACHMENT_ROLLBACK_FAILURE_CODE = "rollback_failed";
var ATTACHMENT_ROLLBACK_FAILURE_MESSAGE = "Attachment cleanup failed. Please try again.";
function immutableAttachmentPath(logicalPath, ownershipId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownershipId)) {
    throw new Error("attachment ownership id must be a path-safe identifier");
  }
  return `${logicalPath}--${ownershipId}`;
}
function createAtomicAttachmentWriter(input) {
  return {
    write: input.write.bind(input),
    abort: input.abort.bind(input)
  };
}

// src/chat-routes/resolve-attachments.ts
var MAX_ATTACHMENT_NAME_LENGTH = 256;
function isAttachmentKind(value) {
  return value === "image" || value === "file";
}
var CONTROL_CHARS = /[\x00-\x1F\x7F]/;
function defaultValidateAttachmentPath(path) {
  if (path.includes("\0")) return { succeeded: false, error: "attachment path must not contain null bytes" };
  if (path.includes("\\")) return { succeeded: false, error: "attachment path must not contain backslashes" };
  if (CONTROL_CHARS.test(path)) return { succeeded: false, error: "attachment path must not contain control characters" };
  if (path.startsWith("/")) return { succeeded: false, error: "attachment path must be store-relative, not absolute" };
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) {
    return { succeeded: false, error: 'attachment path must not contain ".." segments' };
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return { succeeded: false, error: "attachment path must not contain a hidden (dotfile) segment" };
  }
  return { succeeded: true };
}
function parseAttachmentInput(value, index, validatePath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { succeeded: false, error: `attachments[${index}] must be an object` };
  }
  const record2 = value;
  const path = record2.path;
  if (typeof path !== "string" || !path) {
    return { succeeded: false, error: `attachments[${index}].path must be a non-empty string` };
  }
  const name = record2.name;
  if (typeof name !== "string" || !name.trim()) {
    return { succeeded: false, error: `attachments[${index}].name must be a non-empty string` };
  }
  if (name.length > MAX_ATTACHMENT_NAME_LENGTH) {
    return { succeeded: false, error: `attachments[${index}].name must not exceed ${MAX_ATTACHMENT_NAME_LENGTH} characters` };
  }
  if (CONTROL_CHARS.test(name)) {
    return { succeeded: false, error: `attachments[${index}].name must not contain control characters` };
  }
  const size = record2.size;
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return { succeeded: false, error: `attachments[${index}].size must be a finite number` };
  }
  if (size < 0) {
    return { succeeded: false, error: `attachments[${index}].size must not be negative` };
  }
  const mediaType = record2.mediaType;
  if (typeof mediaType !== "string") {
    return { succeeded: false, error: `attachments[${index}].mediaType must be a string` };
  }
  const kind = record2.kind;
  if (!isAttachmentKind(kind)) {
    return { succeeded: false, error: `attachments[${index}].kind must be "image" or "file"` };
  }
  const pathCheck = validatePath(path);
  if (!pathCheck.succeeded) return { succeeded: false, error: pathCheck.error };
  return { succeeded: true, value: { path, name, size, mediaType, kind } };
}
async function resolveChatAttachments(value, options) {
  const maxCount = options.maxCount ?? ATTACHMENT_MAX_COUNT;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES;
  const validatePath = options.validatePath ?? defaultValidateAttachmentPath;
  if (value === void 0 || value === null) return { succeeded: true, value: [] };
  if (!Array.isArray(value)) return { succeeded: false, error: "attachments must be an array" };
  if (value.length > maxCount) {
    return { succeeded: false, error: `attachments must not exceed ${maxCount} entries` };
  }
  const inputs = [];
  const seenPaths = /* @__PURE__ */ new Set();
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseAttachmentInput(value[index], index, validatePath);
    if (!parsed.succeeded) return parsed;
    if (seenPaths.has(parsed.value.path)) {
      return { succeeded: false, error: `attachments must not repeat a path: ${parsed.value.path}` };
    }
    seenPaths.add(parsed.value.path);
    inputs.push(parsed.value);
  }
  const advisoryTotal = inputs.reduce((sum2, input) => sum2 + input.size, 0);
  if (advisoryTotal > maxTotalBytes) {
    return { succeeded: false, error: attachmentTotalSizeErrorMessage(advisoryTotal, maxTotalBytes) };
  }
  let totalStoredBytes = 0;
  for (const input of inputs) {
    const read = await options.readAttachment(options.scopeId, input.path);
    if (!read.ok) return { succeeded: false, error: read.reason };
    totalStoredBytes += read.size;
    if (totalStoredBytes > maxTotalBytes) {
      return { succeeded: false, error: attachmentTotalSizeErrorMessage(totalStoredBytes, maxTotalBytes) };
    }
    input.size = read.size;
  }
  return { succeeded: true, value: inputs.map(attachmentInputToPart) };
}

// src/chat-routes/attachment-write-safety.ts
function objectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
function inspectLegacyAttachmentWriteResult(value) {
  try {
    if (!objectLike(value)) return void 0;
    const ok = value.ok;
    if (ok === true) return { ok: true };
    if (ok === false && typeof value.reason === "string") {
      return { ok: false, reason: value.reason };
    }
  } catch {
  }
  return void 0;
}
function inspectAtomicAttachmentWriteResult(value, ownership) {
  try {
    if (!objectLike(value)) return void 0;
    const receiptValue = value.receipt;
    if (!objectLike(receiptValue)) return void 0;
    const receiptOwnership = receiptValue.ownership;
    if (!objectLike(receiptOwnership)) return void 0;
    if (receiptOwnership.id !== ownership.id || receiptOwnership.path !== ownership.path || typeof receiptOwnership.id !== "string" || typeof receiptOwnership.path !== "string" || typeof receiptValue.rollback !== "function") {
      return void 0;
    }
    if (value.ok === true) {
      return { ok: true, receipt: receiptValue };
    }
    if (value.ok === false && typeof value.reason === "string") {
      return {
        ok: false,
        reason: value.reason,
        receipt: receiptValue
      };
    }
  } catch {
  }
  return void 0;
}

// src/chat-routes/promote-file-part.ts
var PROMOTE_MAX_FILE_BYTES = 10 * 1024 * 1024;
var EXT_TO_MIME = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac"
};
function sniffMimeFromName(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return "text/plain";
  return EXT_TO_MIME[ext] ?? "text/plain";
}
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function parseDataUrl(url) {
  const match = /^data:[^,]*,([\s\S]*)$/i.exec(url);
  if (!match) return null;
  return { base64: /;base64,/i.test(url), data: match[1] ?? "" };
}
function dataUrlMime(url) {
  if (!url) return void 0;
  const match = /^data:([^;,]+)[;,]/i.exec(url);
  return match ? match[1] : void 0;
}
function basenameFromUrl(url) {
  if (!url || /^data:/i.test(url)) return void 0;
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const segments = withoutQuery.split("/").filter(Boolean);
  return segments[segments.length - 1] || void 0;
}
function resolveFileUrlPath(url) {
  const withoutScheme = /^file:\/\//i.test(url) ? url.slice("file://".length) : url;
  try {
    return { succeeded: true, path: decodeURIComponent(withoutScheme) };
  } catch (err) {
    return { succeeded: false, reason: `malformed file path: ${redactErrorMessage(err)}` };
  }
}
function oversizeReason(filename, actual, limit) {
  return `${filename} is ${formatBytes(actual)}; attachments are limited to ${formatBytes(limit)}`;
}
function resolveDataUrlBytes(url, filename, maxBytes) {
  const parsed = parseDataUrl(url);
  if (!parsed) return { succeeded: false, reason: "malformed data URI" };
  let bytes;
  try {
    bytes = parsed.base64 ? base64ToBytes(parsed.data) : new TextEncoder().encode(decodeURIComponent(parsed.data));
  } catch (err) {
    return { succeeded: false, reason: `failed to decode data URI: ${redactErrorMessage(err)}` };
  }
  if (bytes.byteLength > maxBytes) {
    return { succeeded: false, reason: oversizeReason(filename, bytes.byteLength, maxBytes) };
  }
  return { succeeded: true, bytes };
}
async function resolveSandboxFileBytes(input) {
  const stat = await statSandboxFileSize(input.box, input.path, { sessionId: input.sessionId });
  if (!stat.succeeded) {
    return { succeeded: false, reason: `could not stat agent file: ${redactErrorMessage(stat.error)}` };
  }
  if (stat.value > input.maxBytes) {
    return { succeeded: false, reason: oversizeReason(input.filename, stat.value, input.maxBytes) };
  }
  const read = await readSandboxBinaryBytes(input.box, input.path, stat.value, { sessionId: input.sessionId });
  if (!read.succeeded) {
    return { succeeded: false, reason: `could not read agent file: ${redactErrorMessage(read.error)}` };
  }
  return { succeeded: true, bytes: read.value.bytes };
}
async function resolveBytes(input) {
  const url = input.raw.url;
  if (!url) return { succeeded: false, reason: "the file part carries no url" };
  if (/^data:/i.test(url)) return resolveDataUrlBytes(url, input.filename, input.maxBytes);
  const isSandboxPath = /^file:\/\//i.test(url) || url.startsWith("/");
  if (!isSandboxPath) {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase() ?? "unknown";
    return { succeeded: false, reason: `unsupported file URL scheme: ${scheme}` };
  }
  if (!input.box) return { succeeded: false, reason: "no sandbox to read agent file" };
  const resolvedPath = resolveFileUrlPath(url);
  if (!resolvedPath.succeeded) return resolvedPath;
  return resolveSandboxFileBytes({
    path: resolvedPath.path,
    box: input.box,
    sessionId: input.sessionId,
    filename: input.filename,
    maxBytes: input.maxBytes
  });
}
async function hash8(seed) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return Array.from(new Uint8Array(digest).slice(0, 4)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function defaultBuildAttachmentPath(args) {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(args.filename);
  const extension = extensionMatch ? extensionMatch[0] : "";
  const base = extension ? args.filename.slice(0, -extension.length) : args.filename;
  return `uploads/agent/${args.date}/${base}-${args.hash8}${extension}`;
}
function logPromotionStorageError(logger, message, fields) {
  try {
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === "string" ? redactErrorMessage(value) : value
      ])
    );
    logger.error(message, safeFields);
  } catch {
  }
}
async function compensatePromotionWrite(writer, scopeId, ownership, receipt) {
  try {
    await receipt.rollback();
    return {};
  } catch (rollbackError) {
    try {
      await writer.abort(scopeId, ownership);
      return { rollbackError };
    } catch (abortError) {
      return { rollbackError, abortError };
    }
  }
}
function isAtomicPromotionOptions(options) {
  return "attachmentWriter" in options;
}
async function promoteAgentFilePart(options) {
  const atomic = isAtomicPromotionOptions(options);
  const maxBytes = options.maxBytes ?? PROMOTE_MAX_FILE_BYTES;
  const sniffMime = options.sniffMime ?? sniffMimeFromName;
  const buildAttachmentPath = options.buildAttachmentPath ?? defaultBuildAttachmentPath;
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const logger = options.logger ?? console;
  const createWriteId = atomic ? options.createWriteId ?? (() => {
    if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
      throw new Error("attachment promotion requires crypto.randomUUID");
    }
    return crypto.randomUUID();
  }) : void 0;
  const filename = sanitizeAttachmentFileName(
    options.raw.filename ?? basenameFromUrl(options.raw.url) ?? "agent-file"
  );
  const resolved = await resolveBytes({
    raw: options.raw,
    box: options.box,
    sessionId: options.sessionId,
    filename,
    maxBytes
  });
  if (!resolved.succeeded) return { succeeded: false, filename, reason: resolved.reason };
  let mediaType;
  let kind;
  let logicalPath;
  try {
    mediaType = (options.raw.mediaType ?? options.raw.mime ?? dataUrlMime(options.raw.url) ?? sniffMime(filename)).toLowerCase();
    kind = attachmentKindForMime(mediaType);
    const digest = await hash8(options.raw.id ?? options.raw.url ?? filename);
    const date = now().toISOString().split("T")[0] ?? "";
    logicalPath = buildAttachmentPath({ filename, hash8: digest, date, mediaType, kind });
  } catch (error) {
    logPromotionStorageError(logger, "[promote-file-part] path planning failed", {
      error: redactErrorMessage(error)
    });
    return { succeeded: false, filename, reason: ATTACHMENT_STORAGE_FAILURE_MESSAGE };
  }
  if (!atomic) {
    let written2;
    try {
      written2 = await options.writeAttachment(options.scopeId, logicalPath, resolved.bytes, {
        mediaType,
        name: filename,
        originalName: options.raw.filename ?? filename,
        size: resolved.bytes.byteLength
      });
    } catch (error) {
      const reason = redactErrorMessage(error);
      logPromotionStorageError(logger, "[promote-file-part] legacy writer failed", {
        path: logicalPath,
        error: reason
      });
      return { succeeded: false, filename, reason };
    }
    const result2 = inspectLegacyAttachmentWriteResult(written2);
    if (!result2) {
      logPromotionStorageError(logger, "[promote-file-part] legacy writer returned an invalid result", {
        path: logicalPath
      });
      return { succeeded: false, filename, reason: ATTACHMENT_STORAGE_FAILURE_MESSAGE };
    }
    if (!result2.ok) {
      const reason = redactErrorMessage(result2.reason);
      logPromotionStorageError(logger, "[promote-file-part] legacy write rejected", {
        path: logicalPath,
        error: reason
      });
      return { succeeded: false, filename, reason };
    }
    return {
      succeeded: true,
      part: {
        type: kind,
        path: logicalPath,
        name: filename,
        size: resolved.bytes.byteLength,
        mediaType
      }
    };
  }
  let ownershipId;
  let path;
  try {
    ownershipId = createWriteId();
    path = immutableAttachmentPath(logicalPath, ownershipId);
  } catch (error) {
    logPromotionStorageError(logger, "[promote-file-part] could not allocate ownership key", {
      path: logicalPath,
      error: redactErrorMessage(error)
    });
    return { succeeded: false, filename, reason: ATTACHMENT_STORAGE_FAILURE_MESSAGE };
  }
  const ownership = Object.freeze({ id: ownershipId, path });
  let written;
  try {
    written = await options.attachmentWriter.write(options.scopeId, path, resolved.bytes, {
      mediaType,
      name: filename,
      originalName: options.raw.filename ?? filename,
      size: resolved.bytes.byteLength,
      ownership
    });
  } catch (err) {
    let abortError;
    try {
      await options.attachmentWriter.abort(options.scopeId, ownership);
    } catch (error) {
      abortError = error;
    }
    logPromotionStorageError(logger, "[promote-file-part] write failed", {
      path,
      ownershipId: ownership.id,
      error: redactErrorMessage(err),
      ...abortError === void 0 ? {} : { abortError: redactErrorMessage(abortError) }
    });
    return { succeeded: false, filename, reason: ATTACHMENT_STORAGE_FAILURE_MESSAGE };
  }
  const result = inspectAtomicAttachmentWriteResult(written, ownership);
  if (!result) {
    let abortError;
    try {
      await options.attachmentWriter.abort(options.scopeId, ownership);
    } catch (error) {
      abortError = error;
    }
    logPromotionStorageError(logger, "[promote-file-part] writer returned a mismatched ownership receipt", {
      path,
      ownershipId: ownership.id,
      ...abortError === void 0 ? {} : { abortError: redactErrorMessage(abortError) }
    });
    return { succeeded: false, filename, reason: ATTACHMENT_STORAGE_FAILURE_MESSAGE };
  }
  if (!result.ok) {
    const compensation = await compensatePromotionWrite(
      options.attachmentWriter,
      options.scopeId,
      ownership,
      result.receipt
    );
    logPromotionStorageError(logger, "[promote-file-part] write rejected", {
      path,
      ownershipId: ownership.id,
      error: redactErrorMessage(result.reason),
      ...compensation.rollbackError === void 0 ? {} : { rollbackError: redactErrorMessage(compensation.rollbackError) },
      ...compensation.abortError === void 0 ? {} : { abortError: redactErrorMessage(compensation.abortError) }
    });
    return { succeeded: false, filename, reason: ATTACHMENT_STORAGE_FAILURE_MESSAGE };
  }
  return {
    succeeded: true,
    part: {
      type: kind,
      path,
      name: filename,
      size: resolved.bytes.byteLength,
      mediaType
    }
  };
}

// src/chat-routes/attachment-upload.ts
function logAttachmentUploadError(logger, message, fields) {
  try {
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === "string" ? redactErrorMessage(value) : value
      ])
    );
    logger.error(message, safeFields);
  } catch {
  }
}
function attachmentUploadError(status, code, message, path) {
  return Response.json(
    { error: path === void 0 ? { code, message } : { code, message, path } },
    { status }
  );
}
function atomicAttachmentFailure(path, cleanupFailures = 0) {
  return attachmentUploadError(
    503,
    cleanupFailures > 0 ? ATTACHMENT_ROLLBACK_FAILURE_CODE : "attachment_store_unavailable",
    cleanupFailures > 0 ? ATTACHMENT_ROLLBACK_FAILURE_MESSAGE : ATTACHMENT_STORAGE_FAILURE_MESSAGE,
    path
  );
}
async function rollbackSuccessfulWrites(writes, scopeId, writer, logger) {
  let failures = 0;
  for (let index = writes.length - 1; index >= 0; index -= 1) {
    const write = writes[index];
    try {
      await write.receipt.rollback();
    } catch (error) {
      failures += 1;
      logAttachmentUploadError(logger, "[attachment-upload] cleanup failed", {
        path: write.path,
        ownershipId: write.ownership.id,
        error: redactErrorMessage(error)
      });
      failures += await abortOwnership(writer, scopeId, write.ownership, logger);
    }
  }
  return failures;
}
async function abortOwnership(writer, scopeId, ownership, logger) {
  try {
    await writer.abort(scopeId, ownership);
    return 0;
  } catch (error) {
    logAttachmentUploadError(logger, "[attachment-upload] ambiguous write cleanup failed", {
      path: ownership.path,
      ownershipId: ownership.id,
      error: redactErrorMessage(error)
    });
    return 1;
  }
}
function isAtomicRouteOptions(options) {
  return "attachmentWriter" in options;
}
function createAttachmentUploadRoute(options) {
  const atomic = isAtomicRouteOptions(options);
  const maxCount = options.limits?.maxCount ?? ATTACHMENT_MAX_COUNT;
  const maxBinaryBytes = options.limits?.maxBinaryBytes ?? MAX_BINARY_ATTACHMENT_BYTES;
  const maxBytesBySniffedMime = options.limits?.maxBytesBySniffedMime;
  const maxTextBytes = options.limits?.maxTextBytes ?? MAX_TEXT_ATTACHMENT_BYTES;
  const maxTotalBytes = options.limits?.maxTotalBytes ?? MAX_ATTACHMENT_TOTAL_BYTES;
  const allowedKinds = options.allowedKinds ?? ["image", "file"];
  const allowedSniffedMimes = options.allowedSniffedMimes ?? ALLOWED_ATTACHMENT_SNIFFED_MIMES;
  const pathFor = options.pathFor ?? ((name) => name);
  const validatePath = options.validatePath ?? defaultValidateAttachmentPath;
  const sniffMime = options.sniffMime ?? sniffMimeFromName;
  const createWriteId = atomic ? options.createWriteId ?? (() => {
    if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
      throw new Error("attachment upload requires crypto.randomUUID");
    }
    return crypto.randomUUID();
  }) : void 0;
  const logger = options.logger ?? console;
  return async function attachmentUpload(request) {
    const auth = await options.authorize({ request });
    if (!auth.ok) return auth.response;
    const atomicWriter = atomic ? auth.attachmentWriter ?? options.attachmentWriter : void 0;
    const legacyWriter = atomic ? void 0 : auth.writeAttachment ?? options.writeAttachment;
    if (atomic && !atomicWriter) {
      return attachmentUploadError(503, "attachment_store_unavailable", ATTACHMENT_STORAGE_FAILURE_MESSAGE);
    }
    let form;
    try {
      form = await request.formData();
    } catch {
      return attachmentUploadError(400, "invalid_upload", "Expected a multipart/form-data body with file fields");
    }
    const files = [];
    form.forEach((value) => {
      if (value instanceof File) files.push(value);
    });
    if (files.length === 0) {
      return attachmentUploadError(400, "invalid_upload", "No files in the upload body");
    }
    if (files.length > maxCount) {
      return attachmentUploadError(
        400,
        "attachment_count_exceeded",
        `Too many files \u2014 the ${maxCount}-file limit was exceeded`
      );
    }
    const advisoryTotal = files.reduce((sum2, file) => sum2 + file.size, 0);
    if (advisoryTotal > maxTotalBytes) {
      return attachmentUploadError(
        413,
        "attachments_total_too_large",
        attachmentTotalSizeErrorMessage(advisoryTotal, maxTotalBytes)
      );
    }
    const prepared = [];
    const seenLogicalPaths = /* @__PURE__ */ new Set();
    let totalBytes = 0;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniff = sniffBinary(bytes);
      const name = sanitizeAttachmentFileName(file.name);
      const typeCheck = checkAttachmentType(name, sniff, allowedSniffedMimes);
      if (!typeCheck.succeeded) {
        return attachmentUploadError(
          typeCheck.code === "attachment_type_mismatch" ? 400 : 415,
          typeCheck.code,
          typeCheck.message
        );
      }
      const kind = attachmentKindForMime(sniff.mime ?? "");
      if (!allowedKinds.includes(kind)) {
        return attachmentUploadError(
          415,
          "attachment_kind_not_allowed",
          `${name} is a "${kind}" attachment, which this upload route does not accept`
        );
      }
      let limit = maxTextBytes;
      if (sniff.binary) {
        limit = sniff.mime === null ? maxBinaryBytes : maxBytesBySniffedMime?.get(sniff.mime) ?? maxBinaryBytes;
      }
      if (bytes.length > limit) {
        return attachmentUploadError(
          413,
          "attachment_too_large",
          attachmentSizeErrorMessage(name, bytes.length, limit)
        );
      }
      const logicalPath = pathFor(name);
      let ownershipId;
      let path = logicalPath;
      if (atomic) {
        try {
          ownershipId = createWriteId();
          path = immutableAttachmentPath(logicalPath, ownershipId);
        } catch (error) {
          logAttachmentUploadError(logger, "[attachment-upload] could not allocate ownership key", {
            path: logicalPath,
            error: redactErrorMessage(error)
          });
          return attachmentUploadError(
            503,
            "attachment_store_unavailable",
            ATTACHMENT_STORAGE_FAILURE_MESSAGE,
            logicalPath
          );
        }
      }
      const pathCheck = validatePath(path);
      if (!pathCheck.succeeded) {
        return attachmentUploadError(400, "invalid_attachment_path", pathCheck.error, path);
      }
      const duplicatePath = atomic ? logicalPath : path;
      if (seenLogicalPaths.has(duplicatePath)) {
        return attachmentUploadError(
          400,
          "attachment_duplicate_path",
          `attachments must not repeat a path within one upload: ${duplicatePath}`,
          path
        );
      }
      seenLogicalPaths.add(duplicatePath);
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes) {
        return attachmentUploadError(
          413,
          "attachments_total_too_large",
          attachmentTotalSizeErrorMessage(totalBytes, maxTotalBytes)
        );
      }
      const mediaType = sniff.mime ?? sniffMime(name);
      prepared.push({ path, ownershipId, name, bytes, originalName: file.name, size: bytes.length, mediaType, kind });
    }
    const uploaded = [];
    const successfulWrites = [];
    for (const input of prepared) {
      if (!atomic) {
        let written2;
        try {
          written2 = await legacyWriter(auth.scopeId, input.path, input.bytes, {
            mediaType: input.mediaType,
            name: input.name,
            originalName: input.originalName,
            size: input.size
          });
        } catch (error) {
          logAttachmentUploadError(logger, "[attachment-upload] legacy writer failed", {
            path: input.path,
            error: redactErrorMessage(error)
          });
          return attachmentUploadError(
            503,
            "attachment_store_unavailable",
            ATTACHMENT_STORAGE_FAILURE_MESSAGE,
            input.path
          );
        }
        const result2 = inspectLegacyAttachmentWriteResult(written2);
        if (!result2) {
          logAttachmentUploadError(logger, "[attachment-upload] legacy writer returned an invalid result", {
            path: input.path
          });
          return attachmentUploadError(
            503,
            "attachment_store_unavailable",
            ATTACHMENT_STORAGE_FAILURE_MESSAGE,
            input.path
          );
        }
        if (!result2.ok) {
          const reason = redactErrorMessage(result2.reason);
          logAttachmentUploadError(logger, "[attachment-upload] legacy write rejected", {
            path: input.path,
            error: reason
          });
          return attachmentUploadError(413, "attachment_write_failed", reason, input.path);
        }
        uploaded.push({
          path: input.path,
          name: input.name,
          size: input.size,
          mediaType: input.mediaType,
          kind: input.kind
        });
        continue;
      }
      const ownershipId = input.ownershipId;
      if (!ownershipId) {
        return attachmentUploadError(503, "attachment_store_unavailable", ATTACHMENT_STORAGE_FAILURE_MESSAGE, input.path);
      }
      const ownership = Object.freeze({ id: ownershipId, path: input.path });
      let written;
      try {
        written = await atomicWriter.write(auth.scopeId, input.path, input.bytes, {
          mediaType: input.mediaType,
          name: input.name,
          originalName: input.originalName,
          size: input.size,
          ownership
        });
      } catch (error) {
        const cleanupFailures = await abortOwnership(atomicWriter, auth.scopeId, ownership, logger) + await rollbackSuccessfulWrites(successfulWrites, auth.scopeId, atomicWriter, logger);
        logAttachmentUploadError(logger, "[attachment-upload] write failed", {
          path: input.path,
          ownershipId: ownership.id,
          cleanupFailures,
          error: redactErrorMessage(error)
        });
        return atomicAttachmentFailure(input.path, cleanupFailures);
      }
      const result = inspectAtomicAttachmentWriteResult(written, ownership);
      if (!result) {
        const cleanupFailures = await abortOwnership(atomicWriter, auth.scopeId, ownership, logger) + await rollbackSuccessfulWrites(successfulWrites, auth.scopeId, atomicWriter, logger);
        logAttachmentUploadError(logger, "[attachment-upload] writer returned a mismatched ownership receipt", {
          path: input.path,
          ownershipId: ownership.id,
          cleanupFailures
        });
        return atomicAttachmentFailure(input.path, cleanupFailures);
      }
      if (!result.ok) {
        const cleanupFailures = await rollbackSuccessfulWrites([
          { path: input.path, ownership, receipt: result.receipt }
        ], auth.scopeId, atomicWriter, logger) + await rollbackSuccessfulWrites(
          successfulWrites,
          auth.scopeId,
          atomicWriter,
          logger
        );
        logAttachmentUploadError(logger, "[attachment-upload] write rejected", {
          path: input.path,
          ownershipId: ownership.id,
          cleanupFailures,
          error: redactErrorMessage(result.reason)
        });
        return atomicAttachmentFailure(input.path, cleanupFailures);
      }
      successfulWrites.push({ path: input.path, ownership, receipt: result.receipt });
      uploaded.push({
        path: input.path,
        name: input.name,
        size: input.size,
        mediaType: input.mediaType,
        kind: input.kind
      });
    }
    return Response.json({ files: uploaded });
  };
}

// src/chat-routes/dispatch-parts.ts
import { pathToFileURL } from "url";
function byteLen(value) {
  return new TextEncoder().encode(value).length;
}
async function readSandboxMention(box, absolutePath, options) {
  const stat = await statSandboxFileSize(box, absolutePath);
  if (!stat.succeeded) {
    return { succeeded: false, error: `mentioned sandbox file missing or unreadable: ${absolutePath} \u2014 ${stat.error}` };
  }
  if (!options.readBytes) return { succeeded: true, value: { size: stat.value } };
  const read = await readSandboxBinaryBytes(box, absolutePath, stat.value);
  if (!read.succeeded) {
    return { succeeded: false, error: `mentioned sandbox file read failed: ${absolutePath} \u2014 ${read.error}` };
  }
  return { succeeded: true, value: { size: stat.value, base64: bytesToBase64(read.value.bytes) } };
}
function violatesUrlPathXor(part) {
  if (part.type === "text") return false;
  const hasUrl = typeof part.url === "string" && (part.url.startsWith("data:") || part.url.startsWith("file://"));
  const hasPath = "path" in part && typeof part.path === "string" && part.path.startsWith("/");
  if (part.type === "file") return !hasUrl || hasPath;
  return hasUrl === hasPath;
}
function sandboxFileUrl(absolutePath) {
  if (!absolutePath.startsWith("/")) return void 0;
  try {
    return pathToFileURL(absolutePath).href;
  } catch {
    return void 0;
  }
}
function normalizeChatPromptForSandbox(prompt) {
  if (typeof prompt === "string") return prompt;
  return prompt.map((part) => {
    if (part.type === "text") return part;
    if ("content" in part) {
      throw new ChatTurnInputError("Sandbox prompt parts do not accept inline content; provide a URL or path");
    }
    const url = typeof part.url === "string" && part.url.length > 0 ? part.url : void 0;
    const path = typeof part.path === "string" && part.path.length > 0 ? part.path : void 0;
    if (Boolean(url) === Boolean(path)) {
      throw new ChatTurnInputError(`Sandbox ${part.type} parts require exactly one URL or path`);
    }
    if (path && !path.startsWith("/")) {
      throw new ChatTurnInputError(`Sandbox ${part.type} paths must be absolute: ${path}`);
    }
    if (part.type === "image") {
      return {
        type: "image",
        ...part.filename ? { filename: part.filename } : {},
        ...part.mediaType ? { mediaType: part.mediaType } : {},
        ...url ? { url } : { path }
      };
    }
    const filename = part.filename?.trim();
    if (!filename) {
      throw new ChatTurnInputError("Sandbox file parts require a filename");
    }
    const fileUrl = url ?? sandboxFileUrl(path);
    if (!fileUrl) {
      throw new ChatTurnInputError(`Sandbox file paths must be absolute: ${path}`);
    }
    return {
      type: "file",
      filename,
      ...part.mediaType ? { mediaType: part.mediaType } : {},
      url: fileUrl
    };
  });
}
function readResultToBase64(read) {
  if (typeof read.base64 === "string") return read.base64;
  if (read.bytes) return bytesToBase64(read.bytes);
  return void 0;
}
async function buildDispatchParts(input) {
  const readMention = input.readSandboxMention ?? readSandboxMention;
  const resolveMentionPath = input.resolveMentionPath ?? input.resolveAttachmentPath;
  const forcePath = input.forcePath ?? false;
  const mentions = input.mentions ?? [];
  const requestMaxBytes = input.requestMaxBytes ?? DISPATCH_REQUEST_MAX_BYTES;
  const structuralReserveBytes = input.structuralReserveBytes ?? DISPATCH_STRUCTURAL_RESERVE_BYTES;
  const maxParts = input.maxParts ?? DISPATCH_MAX_PARTS;
  const parts = [{ type: "text", text: input.text }];
  const emittedAbsPaths = /* @__PURE__ */ new Set();
  const flattenedForSizing = flattenHistory(input.text, input.history);
  const inlineBudget = requestMaxBytes - base64WireLen(byteLen(flattenedForSizing)) - byteLen(JSON.stringify(input.systemPrompt)) - input.profileWireBytes - structuralReserveBytes;
  let runningInline = 0;
  for (const attachment of input.attachments) {
    if (!attachment.path) {
      return { succeeded: false, error: `attachment path must be non-empty: ${attachment.name}` };
    }
    let read;
    try {
      read = await input.readAttachment(input.scopeId, attachment.path);
    } catch (err) {
      return {
        succeeded: false,
        error: `attachment store read failed: ${attachment.path} \u2014 ${err instanceof Error ? err.message : String(err)}`
      };
    }
    if (!read.ok) return { succeeded: false, error: read.reason };
    const base64 = readResultToBase64(read);
    if (base64 === void 0) {
      return { succeeded: false, error: `attachment store read produced no content: ${attachment.path}` };
    }
    const mediaType = attachment.mediaType ?? read.mediaType;
    if (attachment.type === "image" && !mediaType) {
      return { succeeded: false, error: `attachment is missing a mediaType required for an image data URI: ${attachment.path}` };
    }
    const absPath = input.resolveAttachmentPath(attachment.path);
    emittedAbsPaths.add(absPath);
    if (attachment.type === "image") {
      const inlinePart2 = {
        type: "image",
        filename: attachment.name,
        mediaType,
        url: `data:${mediaType};base64,${base64}`
      };
      const cost2 = byteLen(JSON.stringify(inlinePart2));
      if (!forcePath && runningInline + cost2 <= inlineBudget) {
        parts.push(inlinePart2);
        runningInline += cost2;
      } else {
        parts.push({ type: "image", filename: attachment.name, mediaType, path: absPath });
      }
      continue;
    }
    const fileMediaType = mediaType ?? "application/octet-stream";
    const inlinePart = {
      type: "file",
      filename: attachment.name,
      mediaType: fileMediaType,
      url: `data:${fileMediaType};base64,${base64}`
    };
    const cost = byteLen(JSON.stringify(inlinePart));
    if (!forcePath && runningInline + cost <= inlineBudget) {
      parts.push(inlinePart);
      runningInline += cost;
    } else {
      const url = sandboxFileUrl(absPath);
      if (!url) {
        return { succeeded: false, error: `resolved attachment path must be absolute: ${absPath}` };
      }
      parts.push({ type: "file", filename: attachment.name, mediaType: fileMediaType, url });
    }
  }
  if (mentions.length > 0 && !input.box) {
    return { succeeded: false, error: "internal error: sandbox mentions require a box to read from" };
  }
  for (const mention of mentions) {
    if (!mention.path) {
      return { succeeded: false, error: `mention path must be non-empty: ${mention.name}` };
    }
    if (!isWorkspaceFileExportable(mention.path)) {
      return { succeeded: false, error: `mention file is not exportable: ${mention.path}` };
    }
    const absPath = resolveMentionPath(mention.path);
    if (emittedAbsPaths.has(absPath)) continue;
    emittedAbsPaths.add(absPath);
    const isImage = mention.mentionKind === "image";
    const mediaType = isImage ? mediaTypeForMentionPath(mention.path) : void 0;
    let stat;
    try {
      stat = await readMention(input.box, absPath, { readBytes: false });
    } catch (err) {
      return { succeeded: false, error: `mention read failed: ${absPath} \u2014 ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!stat.succeeded) return { succeeded: false, error: stat.error };
    const projectedInlineCost = base64WireLen(stat.value.size) + byteLen(JSON.stringify({ type: "image", filename: mention.name, mediaType: mediaType ?? "", url: "" }));
    if (isImage && mediaType && !forcePath && runningInline + projectedInlineCost <= inlineBudget) {
      let read;
      try {
        read = await readMention(input.box, absPath, { readBytes: true });
      } catch (err) {
        return { succeeded: false, error: `mention read failed: ${absPath} \u2014 ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!read.succeeded) return { succeeded: false, error: read.error };
      if (!read.value.base64) return { succeeded: false, error: `mentioned image produced no bytes: ${absPath}` };
      const inlinePart = {
        type: "image",
        filename: mention.name,
        mediaType,
        url: `data:${mediaType};base64,${read.value.base64}`
      };
      const cost = byteLen(JSON.stringify(inlinePart));
      if (runningInline + cost <= inlineBudget) {
        parts.push(inlinePart);
        runningInline += cost;
        continue;
      }
    }
    if (isImage && mediaType) {
      parts.push({ type: "image", filename: mention.name, mediaType, path: absPath });
    } else {
      const url = sandboxFileUrl(absPath);
      if (!url) {
        return { succeeded: false, error: `resolved mention path must be absolute: ${absPath}` };
      }
      parts.push({ type: "file", filename: mention.name, url });
    }
  }
  for (const part of parts) {
    if (violatesUrlPathXor(part)) {
      return { succeeded: false, error: "internal error: emitted media part violates the url/path exclusivity invariant" };
    }
  }
  const textPartSize = base64WireLen(byteLen(flattenedForSizing));
  const mediaPartsSize = parts.slice(1).reduce((total, part) => total + byteLen(JSON.stringify(part)), 0);
  const systemPromptSize = byteLen(JSON.stringify(input.systemPrompt));
  if (textPartSize + mediaPartsSize + systemPromptSize + input.profileWireBytes + structuralReserveBytes > requestMaxBytes) {
    return { succeeded: false, error: "dispatch parts exceed the sandbox proxy request cap even after path demotion" };
  }
  if (parts.length > maxParts) {
    return { succeeded: false, error: `dispatch parts exceed the sidecar per-request cap of ${maxParts}` };
  }
  return { succeeded: true, value: parts };
}
export {
  ALLOWED_ATTACHMENT_SNIFFED_MIMES,
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_ROLLBACK_FAILURE_CODE,
  ATTACHMENT_ROLLBACK_FAILURE_MESSAGE,
  ATTACHMENT_STORAGE_FAILURE_MESSAGE,
  ChatTurnInputError,
  DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS,
  DEFAULT_MODEL_STREAM_OPEN_TIMEOUT_MS,
  DEFAULT_STALE_TURN_LOCK_GRACE_MS,
  DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS,
  DISPATCH_MAX_MEDIA_PARTS,
  DISPATCH_MAX_PARTS,
  DISPATCH_REQUEST_MAX_BYTES,
  DISPATCH_STRUCTURAL_RESERVE_BYTES,
  INLINE_PARTS_MAX_BYTES,
  MACRO_ENABLED_OOXML_SNIFFED_MIMES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_BINARY_ATTACHMENT_BYTES,
  MAX_EMPTY_TURN_RETRIES,
  MAX_TEXT_ATTACHMENT_BYTES,
  MENTION_MAX_COUNT,
  ModelFailoverTimeoutError,
  OOXML_PRESENTATION_MACRO_ENABLED_MIME,
  OOXML_PRESENTATION_MIME,
  OOXML_SNIFFED_MIMES,
  OOXML_SPREADSHEET_MACRO_ENABLED_MIME,
  OOXML_SPREADSHEET_MIME,
  OOXML_WORD_MACRO_ENABLED_MIME,
  OOXML_WORD_MIME,
  PROMOTE_MAX_FILE_BYTES,
  UPLOAD_INLINE_MAX_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  aggregateNativeCompletionReceipts,
  assertPromptPartsWithinCap,
  assistantRowIdForTurn,
  attachmentSizeErrorMessage,
  attachmentTotalSizeErrorMessage,
  base64WireLen,
  buildDispatchParts,
  buildMentionPromptBlock,
  bytesToBase64,
  chatTurnRequestInit,
  checkAttachmentType,
  classifyTerminalFailure,
  createAssistantDraftWriter,
  createAtomicAttachmentWriter,
  createAttachmentUploadRoute,
  createChatTurnRoutes,
  createProtectedRuntimeChatProducer,
  createSandboxChatProducer,
  createSandboxFileIndexRoute,
  createUploadRoute,
  defaultValidateAttachmentPath,
  fileMentionsToParts,
  formatBytes,
  immutableAttachmentPath,
  isCommittingSandboxEvent,
  isDraftContentEvent,
  isLiveLifecycleEvent,
  mediaTypeForMentionPath,
  mentionKindForPath,
  normalizeChatPromptForSandbox,
  observeNativeCompletion,
  parseChatTurnParts,
  parseFileMentions,
  promoteAgentFilePart,
  promptPartsByteSize,
  readCompletedSandboxTurn,
  reconcileStaleTurnLock,
  recoverSandboxAssistantMessage,
  resolveChatAttachments,
  resolveEmptyTurnRetries,
  rowIdOf,
  runDetachedTurn,
  sanitizeAttachmentFileName,
  sanitizeUploadFilename,
  sniffBinary,
  sniffMimeFromName,
  storeSupportsDraftPersistence,
  streamChatRouteAsSandboxEvents,
  streamWithModelFailover,
  summarizeFailoverReason,
  validateSandboxMentionPath,
  withDurableChatProjection
};
//# sourceMappingURL=index.js.map