import {
  createInteractionAnswerRoute
} from "./chunk-ZSSCVT6H.js";
import {
  parseJsonObjectBody
} from "./chunk-EA4UVS4T.js";
import {
  mentionInputToPart,
  toChatMessageParts
} from "./chunk-4PZE7XAM.js";
import {
  ChatTurnInputError,
  assertPromptPartsWithinCap,
  chatTurnRequestInit,
  parseChatTurnParts,
  parseFileMentions
} from "./chunk-X47R2IVO.js";
import {
  normalizeClientTurnId,
  resolveChatTurn
} from "./chunk-3NM4GCAY.js";
import {
  coalesceDeltas,
  createBufferedTurnTap,
  replayTurnEvents,
  stampReplaySeq
} from "./chunk-HXTJXODG.js";

// src/chat-routes/draft-persistence.ts
var CONTENT_EVENT_TYPES = /* @__PURE__ */ new Set([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "usage",
  "notice",
  "error",
  "file",
  "interaction",
  "interaction.cancel",
  "plan.submitted",
  "message.part.updated"
]);
var DEFAULT_INTERVAL_MS = 2e3;
var DEFAULT_BACKOFF_BYTES = 262144;
var DEFAULT_MAX_DRAFT_TOOL_OUTPUT_BYTES = 32768;
function isDraftContentEvent(event) {
  return typeof event?.type === "string" && CONTENT_EVENT_TYPES.has(event.type);
}
function capDraftToolOutput(part, maxBytes) {
  if (maxBytes <= 0) return part;
  if (String(part.type ?? "") !== "tool") return part;
  const state = part.state;
  if (!state || typeof state !== "object") return part;
  const record = state;
  const output = record.output;
  if (output === void 0 || output === null) return part;
  const serialized = typeof output === "string" ? output : safeStringify(output);
  if (serialized.length <= maxBytes) return part;
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  return {
    ...part,
    state: {
      ...record,
      output: `${serialized.slice(0, maxBytes)}\u2026[draft-truncated ${serialized.length - maxBytes} chars]`,
      metadata: { ...metadata, draftTruncated: true }
    }
  };
}
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
function createAssistantDraftWriter(options) {
  const log = options.log ?? (() => {
  });
  const baseIntervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const backoffBytes = options.backoffBytes ?? DEFAULT_BACKOFF_BYTES;
  const maxToolOutput = options.maxDraftToolOutputBytes ?? DEFAULT_MAX_DRAFT_TOOL_OUTPUT_BYTES;
  let dirty = false;
  let closed = false;
  let inFlight;
  let lastWriteAt = 0;
  let lastBlobBytes = 0;
  let rowId;
  let writes = 0;
  function currentIntervalMs() {
    if (lastBlobBytes >= backoffBytes * 10) return baseIntervalMs * 5;
    if (lastBlobBytes >= backoffBytes) return Math.round(baseIntervalMs * 2.5);
    return baseIntervalMs;
  }
  async function projectValues(snapshot) {
    const transform = options.transformText;
    const content = transform ? await transform(snapshot.content) : snapshot.content;
    let parts;
    if (snapshot.parts) {
      const capped = snapshot.parts.map((part) => capDraftToolOutput(part, maxToolOutput));
      const redacted = transform ? await Promise.all(
        capped.map(
          async (part) => String(part.type ?? "") === "text" ? { ...part, text: await transform(String(part.text ?? "")) } : part
        )
      ) : capped;
      parts = toChatMessageParts(redacted);
    }
    const usage = snapshot.usage ?? {};
    return {
      content,
      ...parts && parts.length > 0 ? { parts } : {},
      ...snapshot.model ? { model: snapshot.model } : {},
      ...usage.inputTokens !== void 0 ? { inputTokens: usage.inputTokens } : {},
      ...usage.outputTokens !== void 0 ? { outputTokens: usage.outputTokens } : {},
      ...usage.reasoningTokens !== void 0 ? { reasoningTokens: usage.reasoningTokens } : {},
      ...usage.cacheReadTokens !== void 0 ? { cacheReadTokens: usage.cacheReadTokens } : {},
      ...usage.cacheWriteTokens !== void 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {},
      ...usage.costUsd !== void 0 ? { costUsd: usage.costUsd } : {}
    };
  }
  async function adoptRow() {
    if (rowId) return rowId;
    const existing = (await options.store.listMessages(options.threadId)).find(
      (message) => message.id === options.messageId
    );
    if (existing) rowId = existing.id;
    return rowId;
  }
  async function writeOnce(values) {
    if (await adoptRow()) {
      await options.store.updateMessage(rowId, values);
      writes += 1;
      return;
    }
    const inserted = await options.store.appendMessage({
      id: options.messageId,
      threadId: options.threadId,
      role: "assistant",
      ...values
    });
    rowId = rowIdOf(inserted) ?? options.messageId;
    writes += 1;
  }
  function trigger() {
    if (closed) return;
    if (!dirty) return;
    if (inFlight) return;
    const now = Date.now();
    if (lastWriteAt !== 0 && now - lastWriteAt < currentIntervalMs()) return;
    const snapshot = options.snapshot();
    if (!snapshot) return;
    if (!snapshot.content && (!snapshot.parts || snapshot.parts.length === 0)) return;
    dirty = false;
    lastWriteAt = now;
    inFlight = (async () => {
      try {
        const values = await projectValues(snapshot);
        lastBlobBytes = values.parts ? safeStringify(values.parts).length : 0;
        await writeOnce(values);
      } catch (err) {
        log("[chat-routes] incremental assistant persistence failed", {
          messageId: options.messageId,
          error: err instanceof Error ? err.message : String(err)
        });
      } finally {
        inFlight = void 0;
        if (dirty && !closed) trigger();
      }
    })();
  }
  return {
    notify(event) {
      if (closed) return;
      if (isDraftContentEvent(event)) dirty = true;
      trigger();
    },
    async close() {
      closed = true;
      if (inFlight) await inFlight;
    },
    async finalize(values) {
      closed = true;
      if (inFlight) await inFlight;
      await writeOnce(values);
    },
    rowId: () => rowId,
    async discard() {
      closed = true;
      if (inFlight) await inFlight;
      if (!options.store.deleteMessage) return;
      try {
        if (!await adoptRow()) return;
        await options.store.deleteMessage(rowId);
        rowId = void 0;
      } catch (err) {
        log("[chat-routes] draft assistant row discard failed", {
          messageId: options.messageId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    },
    writeCount: () => writes
  };
}
function storeSupportsDraftPersistence(store) {
  return typeof store.updateMessage === "function";
}
function rowIdOf(inserted) {
  const id = inserted?.id;
  return typeof id === "string" && id ? id : null;
}
function assistantRowIdForTurn(turnKey) {
  return `assistant:${turnKey}`;
}

// src/chat-routes/turn-routes.ts
import {
  deriveExecutionId,
  handleChatTurn
} from "@tangle-network/agent-runtime/durable";
function failureReasonOf(data) {
  if (!data) return void 0;
  const message = data.message ?? data.error ?? data.reason;
  if (typeof message === "string" && message.length > 0) return message;
  return void 0;
}
function errorResponse(err) {
  return Response.json({ code: err.code, error: err.message }, { status: err.status });
}
function validateTurnBody(body, maxInlinePartBytes) {
  const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId) throw new ChatTurnInputError("Missing threadId");
  const rawContent = body.content ?? body.message ?? "";
  if (typeof rawContent !== "string") throw new ChatTurnInputError("content must be a string");
  const content = rawContent.trim();
  const fileParts = parseChatTurnParts(body.parts);
  const mentions = parseFileMentions(body.mentions);
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  if (!content && fileParts.length === 0 && mentions.length === 0 && !hasAttachments) {
    throw new ChatTurnInputError("Missing content (send text, parts, mentions, attachments, or any combination)");
  }
  assertPromptPartsWithinCap(fileParts, maxInlinePartBytes);
  let turnId;
  try {
    turnId = normalizeClientTurnId(body.turnId);
  } catch (err) {
    throw new ChatTurnInputError(err instanceof Error ? err.message : "Invalid turnId");
  }
  return {
    // The VALIDATED, deduped mention list replaces the raw one on the payload,
    // so every downstream seam (`authorize`, `contextGate`, `beforeTurn`,
    // `produce`) reads checked paths and never the request's own.
    payload: { ...body, threadId, content, mentions },
    content,
    fileParts,
    mentions,
    turnId
  };
}
function userPartsWithFiles(userParts, fileParts, mentions) {
  return toChatMessageParts([
    ...userParts,
    ...fileParts.map((part) => ({ ...part })),
    ...mentions.map((mention) => ({ ...mentionInputToPart(mention) }))
  ]);
}
async function* tapRawEvents(source, onRawEvent, log) {
  for await (const event of source) {
    try {
      await onRawEvent(event);
    } catch (err) {
      log("[chat-routes] onRawEvent failed", { error: err instanceof Error ? err.message : String(err) });
    }
    yield event;
  }
}
async function* withStreamHeartbeat(source, intervalMs, makeEvent) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    let pending = iterator.next();
    let windowStart = Date.now();
    let tick = 0;
    for (; ; ) {
      let timer;
      let winner;
      try {
        const heartbeat = new Promise((resolve) => {
          timer = setTimeout(() => resolve("heartbeat"), intervalMs);
        });
        winner = await Promise.race([pending.then(() => "event"), heartbeat]);
      } finally {
        if (timer !== void 0) clearTimeout(timer);
      }
      if (winner === "heartbeat") {
        tick += 1;
        yield makeEvent({ elapsedMs: Date.now() - windowStart, tick });
        continue;
      }
      const result = await pending;
      if (result.done) return;
      yield result.value;
      pending = iterator.next();
      windowStart = Date.now();
      tick = 0;
    }
  } finally {
    await iterator.return?.();
  }
}
function createChatTurnRoutes(options) {
  const log = options.log ?? ((message, meta) => console.error(message, meta ?? ""));
  const draftStore = options.store;
  if (options.incrementalPersistence && !storeSupportsDraftPersistence(draftStore)) {
    throw new Error(
      "incrementalPersistence requires a store with updateMessage() \u2014 `/chat-store`'s createChatStore has it; a product store must implement it or omit the option"
    );
  }
  const draftTuning = options.incrementalPersistence === false || !storeSupportsDraftPersistence(draftStore) ? null : options.incrementalPersistence ?? {};
  async function turn(request, ctx) {
    const [rawBody, badBody] = await parseJsonObjectBody(request);
    if (badBody) return badBody;
    let parsed;
    try {
      parsed = validateTurnBody(rawBody, options.maxInlinePartBytes);
    } catch (err) {
      if (err instanceof ChatTurnInputError) return errorResponse(err);
      throw err;
    }
    const { payload, content, fileParts, mentions, turnId } = parsed;
    const auth = await options.authorize({ request, intent: "turn", body: payload });
    if (!auth.ok) return auth.response;
    const { tenantId, userId, context } = auth;
    const existingMessages = (await options.store.listMessages(payload.threadId)).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: m.parts ?? null
    }));
    let hasRunningTurn = false;
    if (draftTuning && existingMessages.at(-1)?.role === "assistant") {
      try {
        hasRunningTurn = (await options.turnStore.listRunning?.(payload.threadId) ?? []).length > 0;
      } catch (err) {
        log("[chat-routes] listRunning probe failed; treating the thread as idle", {
          threadId: payload.threadId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const chatTurn = resolveChatTurn({ existingMessages, userContent: content, turnId, hasRunningTurn });
    const identity = {
      tenantId,
      sessionId: payload.threadId,
      userId,
      turnIndex: chatTurn.turnIndex
    };
    const executionId = deriveExecutionId({
      projectId: options.projectId,
      sessionId: payload.threadId,
      turnIndex: chatTurn.turnIndex
    });
    const turnStreamId = crypto.randomUUID();
    const prompt = fileParts.length === 0 ? content : content ? [{ type: "text", text: content }, ...fileParts] : [...fileParts];
    let draft;
    let tap;
    let completionHandoff = false;
    let completionHandoffPromise;
    const handoffCompletion = () => {
      if (!completionHandoffPromise) {
        completionHandoffPromise = (async () => {
          completionHandoff = true;
          try {
            await tap?.detach();
          } catch (err) {
            log("[chat-routes] turn buffer detach failed", {
              turnId: turnStreamId,
              error: err instanceof Error ? err.message : String(err)
            });
          }
          await draft?.close();
        })();
      }
      return completionHandoffPromise;
    };
    let produceArgs = {
      request,
      body: payload,
      identity,
      context,
      prompt,
      executionId,
      turnStreamId,
      priorMessages: chatTurn.priorMessages,
      handoffCompletion,
      ...ctx?.executionLimits ? { executionLimits: ctx.executionLimits } : {}
    };
    let lockAcquired = false;
    let lockHandle;
    let lockReleased = false;
    const releaseLock = async () => {
      if (completionHandoff || !lockAcquired || lockReleased) return;
      lockReleased = true;
      try {
        await options.turnLock.release(lockHandle);
      } catch (err) {
        log("[chat-routes] turnLock.release failed", {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    };
    if (options.turnLock) {
      const acquired = await options.turnLock.acquire(produceArgs);
      if (!acquired.acquired) return acquired.response;
      lockAcquired = true;
      lockHandle = acquired.handle;
    }
    let producer;
    let assistantMessageId;
    const assistantRowId = () => assistantMessageId ?? draft?.rowId() ?? null;
    let runFailed = false;
    let lastFailureData;
    let turnStartedAtMs = 0;
    let turnStarted = false;
    let lifecycleSettled = false;
    let gatedTurn = false;
    const fireTerminalLifecycle = async (failed, terminalError) => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      const lifecycle = options.lifecycle;
      if (!lifecycle) return;
      const durationMs = Date.now() - turnStartedAtMs;
      try {
        if (failed) {
          await lifecycle.onTurnError?.({
            identity,
            executionId,
            turnStreamId,
            context,
            durationMs,
            error: terminalError ?? lastFailureData ?? new Error("chat turn failed")
          });
        } else {
          const failoverInfo = producer?.modelFailover?.();
          const attribution = producer?.modelAttribution?.();
          await lifecycle.onTurnComplete?.({
            identity,
            executionId,
            turnStreamId,
            context,
            durationMs,
            finalText: producer?.finalText() ?? "",
            usage: producer?.usage?.() ?? {},
            assistantMessageId: assistantRowId(),
            ...gatedTurn ? { gated: true } : {},
            ...producer?.model ? { model: producer.model } : {},
            ...attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {},
            ...attribution?.servedModel ? { servedModel: attribution.servedModel } : {},
            ...attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {},
            ...attribution?.servedSource ? { servedSource: attribution.servedSource } : {},
            ...failoverInfo ? { modelFailover: failoverInfo } : {}
          });
        }
      } catch (err) {
        log("[chat-routes] lifecycle terminal hook failed", {
          turnId: turnStreamId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    };
    try {
      const insertUserMessage = chatTurn.shouldInsertUserMessage && (auth.insertUserMessage ?? true);
      let userMessageId = chatTurn.reusedUserMessageId ?? null;
      if (insertUserMessage) {
        userMessageId = rowIdOf(
          await options.store.appendMessage({
            threadId: payload.threadId,
            role: "user",
            content,
            parts: userPartsWithFiles(chatTurn.userParts, fileParts, mentions)
          })
        );
      }
      produceArgs = { ...produceArgs, userMessageId };
      if (options.contextGate) {
        const gate = await options.contextGate(produceArgs);
        if (gate.proceed === "handoff") {
          await releaseLock();
          return gate.response;
        }
        if (!gate.proceed) {
          await releaseLock();
          if (completionHandoff) return gate.response;
          gatedTurn = true;
          turnStartedAtMs = Date.now();
          if (options.lifecycle?.onTurnStart) {
            try {
              await options.lifecycle.onTurnStart({
                identity,
                executionId,
                turnStreamId,
                context,
                startedAt: turnStartedAtMs
              });
            } catch (err) {
              log("[chat-routes] lifecycle.onTurnStart failed", {
                turnId: turnStreamId,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }
          await fireTerminalLifecycle(false, void 0);
          return gate.response;
        }
      }
      if (options.beforeTurn) {
        const patch = await options.beforeTurn(produceArgs);
        if (patch) produceArgs = { ...produceArgs, ...patch };
      }
      tap = createBufferedTurnTap({
        store: options.turnStore,
        turnId: turnStreamId,
        scopeId: payload.threadId,
        coalesce: options.coalesceTurnEvents ?? coalesceDeltas
      });
      const turnMarker = { type: "turn", turnId: turnStreamId };
      await tap.onEvent(turnMarker);
      if (completionHandoff) await tap.detach();
      if (draftTuning) {
        draft = createAssistantDraftWriter({
          ...draftTuning,
          store: draftStore,
          threadId: payload.threadId,
          messageId: options.draftMessageId ? options.draftMessageId({ identity, executionId, threadId: payload.threadId }) : assistantRowIdForTurn(executionId),
          snapshot: () => {
            if (!producer) return null;
            return {
              content: producer.finalText(),
              ...producer.draftParts ? { parts: producer.draftParts() } : {},
              ...producer.usage ? { usage: producer.usage() } : {},
              ...producer.model ? { model: producer.model } : {}
            };
          },
          ...options.transformFinalText ? { transformText: options.transformFinalText } : {},
          log
        });
        if (completionHandoff) await draft.close();
      }
      turnStartedAtMs = Date.now();
      turnStarted = true;
      if (options.lifecycle?.onTurnStart) {
        try {
          await options.lifecycle.onTurnStart({
            identity,
            executionId,
            turnStreamId,
            context,
            startedAt: turnStartedAtMs
          });
        } catch (err) {
          log("[chat-routes] lifecycle.onTurnStart failed", {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      const result = handleChatTurn({
        identity,
        waitUntil: ctx?.waitUntil,
        log,
        hooks: {
          // The engine wants a synchronous producer; box resolution is async —
          // defer it into the generator's first pull.
          produce: () => ({
            stream: (async function* () {
              producer = await options.produce(produceArgs);
              let source = producer.stream;
              if (ctx?.cancelOnDisconnect) {
                source = abortOnSignal(source, request.signal);
              }
              if (options.onRawEvent) {
                source = tapRawEvents(source, (event) => options.onRawEvent(event, context), log);
              }
              if (options.heartbeat) {
                source = withStreamHeartbeat(source, options.heartbeat.intervalMs, options.heartbeat.event);
              }
              for await (const event of source) yield event;
            })(),
            finalText: () => producer?.finalText() ?? ""
          }),
          onEvent: async (event) => {
            if (event.type === "session.run.failed" || event.type === "error") {
              runFailed = true;
              lastFailureData = event.data;
            }
            await tap.onEvent(event);
            if (!completionHandoff) draft?.notify(event);
            if (options.onEvent) await options.onEvent(event, context);
          },
          ...options.transformFinalText ? { transformFinalText: options.transformFinalText } : {},
          persistAssistantMessage: async ({ finalText }) => {
            if (completionHandoff) return;
            if (ctx?.cancelOnDisconnect && request.signal.aborted) {
              await draft?.discard();
              assistantMessageId = null;
              return;
            }
            const rawParts = producer?.assistantParts ? producer.assistantParts() : void 0;
            const projected = rawParts && options.transformFinalText ? await Promise.all(
              rawParts.map(
                async (part) => String(part.type ?? "") === "text" ? { ...part, text: await options.transformFinalText(String(part.text ?? "")) } : part
              )
            ) : rawParts;
            const parts = projected ? toChatMessageParts(projected) : void 0;
            if (!finalText.trim() && (!parts || parts.length === 0)) {
              await draft?.discard();
              assistantMessageId = draft?.rowId() ?? null;
              return;
            }
            const usage = producer?.usage?.() ?? {};
            const attribution = producer?.modelAttribution?.();
            const values = {
              content: finalText,
              ...parts && parts.length > 0 ? { parts } : {},
              ...producer?.model ? { model: producer.model } : {},
              ...attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {},
              ...attribution?.servedModel ? { servedModel: attribution.servedModel } : {},
              ...attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {},
              ...attribution?.servedSource ? { servedSource: attribution.servedSource } : {},
              ...usage.inputTokens !== void 0 ? { inputTokens: usage.inputTokens } : {},
              ...usage.outputTokens !== void 0 ? { outputTokens: usage.outputTokens } : {},
              ...usage.reasoningTokens !== void 0 ? { reasoningTokens: usage.reasoningTokens } : {},
              ...usage.cacheReadTokens !== void 0 ? { cacheReadTokens: usage.cacheReadTokens } : {},
              ...usage.cacheWriteTokens !== void 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {},
              ...usage.costUsd !== void 0 ? { costUsd: usage.costUsd } : {}
            };
            if (draft) {
              await draft.finalize(values);
              assistantMessageId = draft.rowId() ?? null;
              return;
            }
            assistantMessageId = rowIdOf(
              await options.store.appendMessage({
                threadId: payload.threadId,
                role: "assistant",
                ...values
              })
            );
          },
          ...options.onTurnComplete ? {
            // Wired into the engine's completion hook, which fires only when
            // the stream ended without throwing. A terminal error EVENT
            // (not a throw) still lands here — so surface `runFailed` so the
            // product skips billing an errored turn instead of marking it
            // complete with empty text.
            onTurnComplete: async ({ identity: turnIdentity, finalText }) => {
              if (completionHandoff) return;
              const failoverInfo = producer?.modelFailover?.();
              const attribution = producer?.modelAttribution?.();
              return options.onTurnComplete({
                identity: turnIdentity,
                finalText,
                context,
                failed: runFailed,
                assistantMessageId: assistantRowId(),
                ...runFailed ? { failureReason: failureReasonOf(lastFailureData) } : {},
                ...producer?.model ? { model: producer.model } : {},
                ...attribution?.requestedModel ? { requestedModel: attribution.requestedModel } : {},
                ...attribution?.servedModel ? { servedModel: attribution.servedModel } : {},
                ...attribution?.servedProvider ? { servedProvider: attribution.servedProvider } : {},
                ...attribution?.servedSource ? { servedSource: attribution.servedSource } : {},
                ...failoverInfo ? { modelFailover: failoverInfo } : {}
              });
            }
          } : {},
          ...options.traceFlush ? { traceFlush: () => options.traceFlush(context) } : {}
        }
      });
      const [clientBody, drainBody] = result.body.tee();
      const drained = (async () => {
        const reader = drainBody.getReader();
        let drainError;
        try {
          for (; ; ) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch (err) {
          drainError = err;
          log("[chat-routes] turn drain failed", {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        const failed = runFailed || drainError !== void 0;
        if (completionHandoff) {
          await tap.detach();
          return;
        }
        if (ctx?.cancelOnDisconnect && request.signal.aborted) {
          await draft?.discard();
        } else {
          await draft?.close();
        }
        try {
          await tap.done(failed ? "error" : "complete");
        } catch (err) {
          log("[chat-routes] turn buffer finalize failed", {
            turnId: turnStreamId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
        await fireTerminalLifecycle(failed, drainError);
        await releaseLock();
      })();
      if (ctx?.waitUntil) ctx.waitUntil(drained);
      else void drained.catch(() => {
      });
      const encoder = new TextEncoder();
      const marker = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(turnMarker)}
`));
          controller.close();
        }
      });
      const body = concatStreams([marker, clientBody]);
      return new Response(body, {
        headers: {
          "Content-Type": result.contentType,
          "Cache-Control": "no-cache",
          "X-Turn-Id": turnStreamId
        }
      });
    } catch (err) {
      if (!completionHandoff) {
        if (turnStarted) await fireTerminalLifecycle(true, err);
        await releaseLock();
      }
      throw err;
    }
  }
  async function replay(request, params) {
    const turnId = params.turnId?.trim();
    if (!turnId) return Response.json({ error: "Missing turnId" }, { status: 400 });
    const auth = await options.authorize({ request, intent: "replay", turnId });
    if (!auth.ok) return auth.response;
    const fromSeqRaw = new URL(request.url).searchParams.get("fromSeq");
    const fromSeq = fromSeqRaw ? Math.max(0, Math.trunc(Number(fromSeqRaw)) || 0) : 0;
    const encoder = new TextEncoder();
    const events = replayTurnEvents({
      store: options.turnStore,
      turnId,
      fromSeq,
      ...options.replay?.pollMs !== void 0 ? { pollMs: options.replay.pollMs } : {},
      ...options.replay?.timeoutMs !== void 0 ? { timeoutMs: options.replay.timeoutMs } : {}
    });
    const body = new ReadableStream({
      async pull(controller) {
        const { done, value } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${stampReplaySeq(value)}
`));
      },
      cancel() {
        void events.return(void 0);
      }
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache"
      }
    });
  }
  async function running(request) {
    const threadId = new URL(request.url).searchParams.get("threadId")?.trim();
    if (!threadId) return Response.json({ error: "Missing threadId" }, { status: 400 });
    const auth = await options.authorize({ request, intent: "running", threadId });
    if (!auth.ok) return auth.response;
    const ids = await options.turnStore.listRunning?.(threadId) ?? [];
    return Response.json({ running: ids });
  }
  return {
    turn,
    replay,
    running,
    interactions: options.interactions ? createInteractionAnswerRoute(options.interactions) : null
  };
}
function concatStreams(streams) {
  let index = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      for (; ; ) {
        if (!reader) {
          const next = streams[index++];
          if (!next) {
            controller.close();
            return;
          }
          reader = next.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      for (const stream of streams.slice(index)) await stream.cancel(reason);
    }
  });
}
async function* abortOnSignal(source, signal) {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (; ; ) {
      const next = await nextWithAbort(iterator, signal);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await closeIteratorAfterAbort(iterator);
  }
}
function nextWithAbort(iterator, signal) {
  if (signal.aborted) return Promise.reject(new Error("chat turn cancelled"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("chat turn cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve().then(() => iterator.next()).then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}
var ABORT_CLEANUP_TIMEOUT_MS = 50;
async function closeIteratorAfterAbort(iterator) {
  let closing;
  try {
    const result = iterator.return?.();
    if (result) closing = Promise.resolve(result);
  } catch {
    return;
  }
  if (!closing) return;
  let timeout;
  try {
    await Promise.race([
      Promise.resolve(closing).catch(() => void 0),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, ABORT_CLEANUP_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout !== void 0) clearTimeout(timeout);
  }
}

// src/chat-routes/gateway-adapter.ts
async function* streamChatRouteAsSandboxEvents(options) {
  const parentSignal = options.signal ?? options.request.signal;
  if (parentSignal.aborted) return;
  let reader;
  const stopForwarding = () => void reader?.cancel();
  parentSignal.addEventListener("abort", stopForwarding, { once: true });
  const request = new Request(options.request.url, {
    ...chatTurnRequestInit(options.payload),
    headers: options.request.headers
  });
  request.headers.set("Content-Type", "application/json");
  let complete = false;
  try {
    const response = await options.routes.turn(
      request,
      {
        ...options.waitUntil ? { waitUntil: options.waitUntil } : {},
        ...options.executionLimits ? { executionLimits: options.executionLimits } : {}
      }
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => void 0);
      throw new Error(`chat route rejected the gateway turn (${response.status})`);
    }
    if (!response.body) throw new Error("chat route returned no stream");
    reader = response.body.getReader();
    if (parentSignal.aborted) {
      await reader.cancel().catch(() => void 0);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for (; ; ) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        buffer += decoder.decode();
        const event = toSandboxEvent(parseEvent(buffer));
        if (event) yield event;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = toSandboxEvent(parseEvent(line));
        if (event) yield event;
      }
    }
  } finally {
    if (!complete) await reader?.cancel().catch(() => void 0);
    reader?.releaseLock();
    parentSignal.removeEventListener("abort", stopForwarding);
  }
}
function parseEvent(line) {
  if (!line.trim()) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("chat route returned invalid NDJSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("chat route returned a non-object event");
  }
  const event = value;
  if (event.type !== void 0 && typeof event.type !== "string") {
    throw new Error("chat route returned an invalid event type");
  }
  const data = event.data;
  if (data !== void 0 && (!data || typeof data !== "object" || Array.isArray(data))) {
    throw new Error("chat route returned invalid event data");
  }
  const dataUsage = data && data.usage;
  if (dataUsage !== void 0 && (!dataUsage || typeof dataUsage !== "object" || Array.isArray(dataUsage))) {
    throw new Error("chat route returned invalid data.usage");
  }
  if (event.text !== void 0 && typeof event.text !== "string") {
    throw new Error("chat route returned an invalid text event");
  }
  const usage = event.usage;
  if (usage !== void 0 && (!usage || typeof usage !== "object" || Array.isArray(usage))) {
    throw new Error("chat route returned invalid usage");
  }
  if (event.toolName !== void 0 && typeof event.toolName !== "string") {
    throw new Error("chat route returned an invalid tool name");
  }
  return {
    ...typeof event.type === "string" ? { type: event.type } : {},
    ...data ? { data } : {},
    ...typeof event.text === "string" ? { text: event.text } : {},
    ...usage ? { usage } : {},
    ...typeof event.toolName === "string" ? { toolName: event.toolName } : {}
  };
}
function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function aliasedSafeInteger(usage, field, alias) {
  const value = usage[field];
  const aliasValue = alias ? usage[alias] : void 0;
  for (const candidate of [value, aliasValue]) {
    if (candidate !== void 0 && !isNonNegativeSafeInteger(candidate)) {
      throw new Error(`chat route returned invalid usage.${field}`);
    }
  }
  if (value !== void 0 && aliasValue !== void 0 && value !== aliasValue) {
    throw new Error(`chat route returned conflicting usage.${field}`);
  }
  return value ?? aliasValue;
}
function aliasedNonNegativeNumber(usage, field, alias) {
  const value = usage[field];
  const aliasValue = alias ? usage[alias] : void 0;
  for (const candidate of [value, aliasValue]) {
    if (candidate !== void 0 && (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)) {
      throw new Error(`chat route returned invalid usage.${field}`);
    }
  }
  if (value !== void 0 && aliasValue !== void 0 && value !== aliasValue) {
    throw new Error(`chat route returned conflicting usage.${field}`);
  }
  return value ?? aliasValue;
}
function providerUsageUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value;
  const usage = {};
  const inputTokens = aliasedSafeInteger(source, "inputTokens", "promptTokens");
  const outputTokens = aliasedSafeInteger(source, "outputTokens", "completionTokens");
  const reasoningTokens = aliasedSafeInteger(source, "reasoningTokens");
  const toolTokens = aliasedSafeInteger(source, "toolTokens");
  const toolCallCount = aliasedSafeInteger(source, "toolCallCount");
  const providerCostUsd = aliasedNonNegativeNumber(source, "providerCostUsd", "costUsd");
  if (inputTokens !== void 0) usage.inputTokens = inputTokens;
  if (outputTokens !== void 0) usage.outputTokens = outputTokens;
  if (reasoningTokens !== void 0) usage.reasoningTokens = reasoningTokens;
  if (toolTokens !== void 0) usage.toolTokens = toolTokens;
  if (toolCallCount !== void 0) usage.toolCallCount = toolCallCount;
  if (providerCostUsd !== void 0) usage.providerCostUsd = providerCostUsd;
  if (source.budgetEnforced !== void 0) {
    if (typeof source.budgetEnforced !== "boolean") {
      throw new Error("chat route returned invalid usage.budgetEnforced");
    }
    usage.budgetEnforced = source.budgetEnforced;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}
function toSandboxEvent(event) {
  if (!event) return null;
  if (event.type === "text") {
    if (event.text === void 0) throw new Error("chat route text event had no text");
    return {
      type: "message.part.updated",
      data: { part: { type: "text" }, delta: event.text }
    };
  }
  if (event.type === "reasoning") return null;
  if (event.type === "usage" || event.usage || event.data?.usage) {
    const usage = providerUsageUpdate(event.usage ?? event.data?.usage);
    if (!usage) return null;
    return { type: "usage", data: { usage } };
  }
  if (event.type === "tool_result") {
    if (!event.toolName) throw new Error("chat route tool result had no tool name");
    return { type: "tool_result", data: { tool: { name: event.toolName } } };
  }
  if (event.type === "input-required" && !event.data?.inputRequired) {
    const prompt = typeof event.data?.prompt === "string" ? event.data.prompt : void 0;
    return {
      type: "input-required",
      data: { inputRequired: prompt ? { prompt } : {} }
    };
  }
  return {
    ...event.type ? { type: event.type } : {},
    ...event.data ? { data: event.data } : {}
  };
}

export {
  isDraftContentEvent,
  createAssistantDraftWriter,
  storeSupportsDraftPersistence,
  rowIdOf,
  assistantRowIdForTurn,
  createChatTurnRoutes,
  streamChatRouteAsSandboxEvents
};
//# sourceMappingURL=chunk-V4YGTOCS.js.map