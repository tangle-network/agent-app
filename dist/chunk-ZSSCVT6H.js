import {
  interactionFromWireRequest,
  isSafeInteractionFieldKey,
  questionInteractionContentSignature
} from "./chunk-M3K2HVQD.js";

// src/interactions/sidecar.ts
var DEFAULT_TIMEOUT_MS = 5e3;
function sanitizeUpstreamMessage(input) {
  const message = input instanceof Error ? input.message : String(input);
  return message.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/\b(?:sk|pk|tc)[_-][A-Za-z0-9_-]{8,}\b/g, "[redacted-key]");
}
async function interactionsFetch(connection, init) {
  const doFetch = connection.fetchImpl ?? fetch;
  const url = `${connection.runtimeUrl.replace(/\/$/, "")}/agents/sessions/${encodeURIComponent(connection.sessionId)}/interactions`;
  let response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        ...connection.authToken ? { Authorization: `Bearer ${connection.authToken}` } : {},
        ...init.method === "POST" ? { "Content-Type": "application/json" } : {}
      },
      ...init.method === "POST" ? { body: JSON.stringify(init.body) } : {},
      signal: AbortSignal.timeout(connection.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    });
  } catch (err) {
    return {
      succeeded: false,
      error: { code: "UPSTREAM_UNREACHABLE", message: sanitizeUpstreamMessage(err), status: 0 }
    };
  }
  const raw = await response.text().catch(() => "");
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
  }
  if (!response.ok) {
    const upstreamError = parsed.error ?? {};
    return {
      succeeded: false,
      error: {
        code: typeof upstreamError.code === "string" && upstreamError.code ? upstreamError.code : "UPSTREAM_ERROR",
        message: sanitizeUpstreamMessage(
          typeof upstreamError.message === "string" && upstreamError.message ? upstreamError.message : `sidecar interactions ${init.method} failed (${response.status})`
        ),
        status: response.status
      }
    };
  }
  return { succeeded: true, value: parsed };
}
async function listSessionInteractions(connection) {
  const result = await interactionsFetch(connection, { method: "GET" });
  if (!result.succeeded) return result;
  const data = result.value.data;
  if (!Array.isArray(data?.interactions)) {
    return {
      succeeded: false,
      error: { code: "MALFORMED_RESPONSE", message: "sidecar list returned no interactions array", status: 200 }
    };
  }
  return { succeeded: true, value: data.interactions };
}
async function respondToSessionInteraction(connection, response) {
  const result = await interactionsFetch(connection, {
    method: "POST",
    body: {
      id: response.id,
      outcome: response.outcome,
      ...response.data ? { data: response.data } : {}
    }
  });
  if (!result.succeeded) return result;
  return { succeeded: true, value: void 0 };
}
function isTerminalSidecarState(state) {
  if (state.activeExecutionId) return false;
  if (state.reconnectable === true) return false;
  if (state.outstandingInteractions && state.outstandingInteractions.length > 0) return false;
  return TERMINAL_SESSION_STATES.includes(state.state ?? "") || state.reconnectable === false;
}
var TERMINAL_SESSION_STATES = ["completed", "failed", "aborted", "expired", "idle", "terminal"];
async function sessionFetch(connection, init = { method: "GET" }) {
  const doFetch = connection.fetchImpl ?? fetch;
  const base = `${connection.runtimeUrl.replace(/\/$/, "")}/agents/sessions/${encodeURIComponent(connection.sessionId)}`;
  const url = init.method === "POST" ? `${base}/abort` : base;
  let response;
  try {
    response = await doFetch(url, {
      method: init.method,
      headers: {
        ...connection.authToken ? { authorization: `Bearer ${connection.authToken}` } : {},
        ...init.method === "POST" ? { "content-type": "application/json" } : {}
      },
      ...init.method === "POST" ? { body: "{}" } : {},
      signal: AbortSignal.timeout(connection.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    });
  } catch (err) {
    return {
      succeeded: false,
      error: { code: "SIDECAR_UNREACHABLE", message: sanitizeUpstreamMessage(err), status: 502 }
    };
  }
  let parsed = {};
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const upstreamError = parsed.error && typeof parsed.error === "object" ? parsed.error : {};
    return {
      succeeded: false,
      error: {
        code: typeof upstreamError.code === "string" && upstreamError.code ? upstreamError.code : "SIDECAR_SESSION_FAILED",
        message: sanitizeUpstreamMessage(
          typeof upstreamError.message === "string" && upstreamError.message ? upstreamError.message : `sidecar session ${init.method} failed (${response.status})`
        ),
        status: response.status
      }
    };
  }
  return { succeeded: true, value: parsed };
}
function sessionStateFromPayload(payload) {
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const session = data.session && typeof data.session === "object" ? data.session : data;
  const activeExecution = data.activeExecution && typeof data.activeExecution === "object" ? data.activeExecution : session.activeExecution && typeof session.activeExecution === "object" ? session.activeExecution : null;
  const interactions = session.outstandingInteractions ?? session.interactions;
  return {
    ...typeof session.state === "string" ? { state: session.state } : {},
    ...typeof session.activeExecutionId === "string" ? { activeExecutionId: session.activeExecutionId } : session.activeExecutionId === null ? { activeExecutionId: null } : {},
    ...typeof session.reconnectable === "boolean" ? { reconnectable: session.reconnectable } : {},
    ...typeof session.registryAuthority === "string" ? { registryAuthority: session.registryAuthority } : session.registryAuthority === null ? { registryAuthority: null } : {},
    ...typeof session.terminalReason === "string" ? { terminalReason: session.terminalReason } : session.terminalReason === null ? { terminalReason: null } : {},
    ...typeof session.lastEventAt === "string" || typeof session.lastEventAt === "number" || session.lastEventAt === null ? { lastEventAt: session.lastEventAt } : {},
    ...Array.isArray(interactions) ? { outstandingInteractions: interactions } : {},
    ...activeExecution && typeof activeExecution.id === "string" && typeof session.activeExecutionId !== "string" ? { activeExecutionId: activeExecution.id } : {},
    ...activeExecution && typeof activeExecution.status === "string" ? { activeExecutionStatus: activeExecution.status } : activeExecution === null && session.activeExecution === null ? { activeExecutionStatus: null } : {}
  };
}
async function getSessionState(connection) {
  const result = await sessionFetch(connection);
  if (!result.succeeded) return result;
  return { succeeded: true, value: sessionStateFromPayload(result.value) };
}
async function abortSession(connection) {
  const result = await sessionFetch(connection, { method: "POST" });
  if (!result.succeeded) {
    if (result.error.status === 404) return { succeeded: true, value: { cancelled: false, reason: "not-found" } };
    return result;
  }
  const data = result.value.data && typeof result.value.data === "object" ? result.value.data : result.value;
  const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : typeof data.noopReason === "string" && data.noopReason.trim() ? data.noopReason.trim() : void 0;
  return {
    succeeded: true,
    value: {
      cancelled: data.cancelled === true,
      ...reason ? { reason } : {},
      ...data.session && typeof data.session === "object" ? { session: sessionStateFromPayload(result.value) } : {}
    }
  };
}

// src/interactions/route.ts
function validateInteractionAnswerBody(body) {
  const id = typeof body.id === "string" && body.id ? body.id : null;
  if (!id) return { ok: false, error: "Missing interaction id" };
  const outcome = body.outcome;
  if (outcome !== "accepted" && outcome !== "declined") {
    return { ok: false, error: "Invalid outcome: expected accepted or declined" };
  }
  if (body.data === void 0) return { ok: true, id, outcome };
  if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
    return { ok: false, error: "Invalid data: expected an object of field values" };
  }
  const data = {};
  for (const [key, value] of Object.entries(body.data)) {
    if (!isSafeInteractionFieldKey(key)) {
      return { ok: false, error: "Invalid data: field names must contain only letters, numbers, underscores, or hyphens" };
    }
    const validValue = typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) && value.every((item) => typeof item === "string");
    if (!validValue) {
      return { ok: false, error: "Invalid data: field values must be strings, numbers, booleans, or string arrays" };
    }
    data[key] = value;
  }
  return { ok: true, id, outcome, data };
}
function mapInteractionRespondFailure(error, logger = console) {
  if (error.code === "INVALID_INTERACTION_ANSWER") {
    return Response.json(
      { code: "INVALID_INTERACTION_ANSWER", error: "This question needs an answer from the card above \u2014 pick one of the listed options." },
      { status: 400 }
    );
  }
  if (error.status === 404) {
    return Response.json(
      { code: "INTERACTION_EXPIRED", error: "This question is no longer waiting for an answer." },
      { status: 410 }
    );
  }
  if (error.status === 501 || error.code === "NOT_IMPLEMENTED") {
    return Response.json(
      { code: "INTERACTIONS_UNSUPPORTED", error: "This agent backend cannot accept answers this way." },
      { status: 501 }
    );
  }
  logger.error("[interactions] respond failed:", error);
  return Response.json(
    { code: "INTERACTION_UPSTREAM_FAILED", error: "Could not reach the agent. Try again." },
    { status: 503 }
  );
}
function createInteractionAnswerRoute(options) {
  const logger = options.logger ?? console;
  async function list(request) {
    const resolution = await options.resolveConnection({ request, intent: "list" });
    if (!resolution.ok) {
      if ("response" in resolution) return resolution.response;
      return Response.json({ interactions: [], unavailable: resolution.unavailable });
    }
    const result = await listSessionInteractions(resolution.connection);
    if (!result.succeeded) {
      logger.warn("[interactions] list failed:", result.error);
      return Response.json({ interactions: [], unavailable: result.error.code });
    }
    return Response.json({ interactions: result.value });
  }
  async function answer(request) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const validation = validateInteractionAnswerBody(body);
    if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 });
    const attemptKey = typeof body.attemptKey === "string" ? body.attemptKey.trim() : "";
    if (options.durable && !attemptKey) {
      return Response.json({ error: "Missing attemptKey for durable interaction answer" }, { status: 400 });
    }
    const resolution = await options.resolveConnection({ request, intent: "answer", body });
    if (!resolution.ok) {
      if ("response" in resolution) return resolution.response;
      return mapInteractionRespondFailure(
        { code: resolution.unavailable, message: "sandbox runtime unavailable", status: 0 },
        logger
      );
    }
    const connection = resolution.connection;
    const answerPayload = {
      outcome: validation.outcome,
      ...validation.data ? { data: validation.data } : {}
    };
    const before = await listSessionInteractions(connection);
    if (!before.succeeded && (options.beforeAnswer || options.durable)) {
      return mapInteractionRespondFailure(before.error, logger);
    }
    const answeredRequest = before.succeeded ? before.value.find((item) => item.id === validation.id) : void 0;
    if (options.beforeAnswer && !options.durable && !answeredRequest) {
      return mapInteractionRespondFailure(
        { code: "NOT_FOUND", message: "interaction not found", status: 404 },
        logger
      );
    }
    const answeredSignature = answeredRequest ? questionInteractionContentSignature(interactionFromWireRequest(answeredRequest)) : null;
    const duplicateRequests = before.succeeded && answeredSignature ? before.value.filter((item) => item.id !== validation.id && questionInteractionContentSignature(interactionFromWireRequest(item)) === answeredSignature) : [];
    const lifecycleArgs = {
      request,
      body,
      answer: validation,
      connection,
      outstanding: before.succeeded ? before.value : [],
      ...answeredRequest ? { answeredRequest } : {},
      duplicateRequests
    };
    if (options.beforeAnswer && answeredRequest) {
      try {
        await options.beforeAnswer(lifecycleArgs);
      } catch (error) {
        logger.error("[interactions] beforeAnswer failed:", error);
        return Response.json(
          { code: "INTERACTION_BEFORE_ANSWER_FAILED", error: "Could not save the answer. Try again." },
          { status: 503 }
        );
      }
    }
    let prepared;
    const durableArgs = options.durable ? { ...lifecycleArgs, attemptKey } : null;
    if (options.durable && durableArgs) {
      try {
        prepared = await options.durable.prepare(durableArgs);
      } catch (error) {
        logger.error("[interactions] durable prepare failed:", error);
        return Response.json(
          { code: "INTERACTION_PREPARE_FAILED", error: "Could not prepare the answer. Try again." },
          { status: 503 }
        );
      }
      if (!answeredRequest) {
        let reconciled;
        try {
          reconciled = await options.durable.reconcile({ ...durableArgs, prepared });
        } catch (error) {
          logger.error("[interactions] durable reconcile failed:", error);
          reconciled = { settled: false };
        }
        if (reconciled.settled) return Response.json({ ok: true, idempotent: true });
        return Response.json(
          { code: "INTERACTION_RECONCILIATION_PENDING", error: "The answer status is still being checked. Retry with the same attempt." },
          { status: 503 }
        );
      }
    }
    const result = await respondToSessionInteraction(connection, { id: validation.id, ...answerPayload });
    if (!result.succeeded) {
      if (options.durable && durableArgs) {
        let reconciled;
        try {
          reconciled = await options.durable.reconcile({ ...durableArgs, prepared });
        } catch {
          reconciled = { settled: false };
        }
        if (reconciled.settled) return Response.json({ ok: true, idempotent: true });
        if (result.error.status === 404) {
          return Response.json(
            { code: "INTERACTION_RECONCILIATION_PENDING", error: "The answer status is still being checked. Retry with the same attempt." },
            { status: 503 }
          );
        }
        try {
          await options.durable.fail?.({ ...durableArgs, prepared, error: result.error });
        } catch {
        }
      }
      return mapInteractionRespondFailure(result.error, logger);
    }
    let remaining = await listSessionInteractions(connection);
    const acknowledgedDuplicateIds = [];
    if (remaining.succeeded && answeredSignature) {
      const remainingDuplicates = remaining.value.filter((item) => {
        if (item.id === validation.id) return false;
        return questionInteractionContentSignature(interactionFromWireRequest(item)) === answeredSignature;
      });
      for (const duplicate of remainingDuplicates) {
        const duplicateResult = await respondToSessionInteraction(connection, { id: duplicate.id, ...answerPayload });
        if (!duplicateResult.succeeded) break;
        acknowledgedDuplicateIds.push(duplicate.id);
      }
      if (remainingDuplicates.length > 0) remaining = await listSessionInteractions(connection);
    }
    if (remaining.succeeded && remaining.value.some((item) => item.id === validation.id || answeredSignature && questionInteractionContentSignature(interactionFromWireRequest(item)) === answeredSignature)) {
      logger.error("[interactions] respond returned ok but interaction is still pending:", {
        sessionId: connection.sessionId,
        interactionId: validation.id
      });
      return Response.json(
        { code: "INTERACTION_STILL_PENDING", error: "The agent did not accept the answer. Try answering again." },
        { status: 503 }
      );
    }
    if (options.durable && durableArgs) {
      try {
        await options.durable.acknowledge({
          ...durableArgs,
          prepared,
          duplicateIds: acknowledgedDuplicateIds
        });
        await options.durable.finalize({
          ...durableArgs,
          prepared,
          duplicateIds: acknowledgedDuplicateIds
        });
      } catch (error) {
        logger.error("[interactions] durable finalize failed:", error);
        return Response.json(
          { code: "INTERACTION_FINALIZE_FAILED", error: "The answer was accepted but is still being saved. Retry to reconcile it." },
          { status: 503 }
        );
      }
    }
    return Response.json({ ok: true });
  }
  return { list, answer };
}

export {
  listSessionInteractions,
  respondToSessionInteraction,
  isTerminalSidecarState,
  getSessionState,
  abortSession,
  validateInteractionAnswerBody,
  mapInteractionRespondFailure,
  createInteractionAnswerRoute
};
//# sourceMappingURL=chunk-ZSSCVT6H.js.map