// src/web-react/session-gateway.ts
var GATEWAY_TERMINAL_EVENT_TYPES = /* @__PURE__ */ new Set([
  "done",
  "error",
  "result",
  "session.run.completed",
  "session.run.failed"
]);
var GATEWAY_TRANSPORT_NOTICE_TYPES = /* @__PURE__ */ new Set([
  "connection.established",
  "heartbeat",
  "ping",
  "pong"
]);
function isTerminalGatewayEvent(type) {
  return GATEWAY_TERMINAL_EVENT_TYPES.has(type);
}
function isGatewayTransportNotice(type) {
  return GATEWAY_TRANSPORT_NOTICE_TYPES.has(type);
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function gatewayFrameToTurnEvent(raw) {
  if (!isRecord(raw)) return null;
  const type = typeof raw.type === "string" ? raw.type.trim() : "";
  if (type) {
    const { type: _ignored, properties, ...rest } = raw;
    return { type, data: isRecord(properties) ? properties : rest };
  }
  if (isRecord(raw.outcome) || typeof raw.outcome === "string") {
    return { type: "done", data: raw };
  }
  return null;
}
function parseSessionStreamGrant(body) {
  if (!isRecord(body) || body.available !== true) return null;
  const { url, token, sessionId, expiresAt } = body;
  if (typeof url !== "string" || !url.trim() || !isWebSocketUrl(url) || typeof token !== "string" || !token.trim() || typeof sessionId !== "string" || !sessionId.trim() || typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt < 0) {
    return null;
  }
  return { url, token, sessionId, expiresAt };
}
function isWebSocketUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}
function createSessionStreamGrantFetcher(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (signal) => {
    try {
      const url = typeof options.url === "function" ? options.url(options.scopeId) : options.url;
      const response = await fetchImpl(url, {
        ...options.requestInit,
        signal
      });
      if (!response.ok) return null;
      return parseSessionStreamGrant(await response.json());
    } catch {
      return null;
    }
  };
}
var APPLIED_SEQ_CAP = 1e5;
async function defaultCreateClient(config) {
  const module = await import("@tangle-network/sandbox/session-gateway");
  return new module.SessionGatewayClient(config);
}
function defaultReplayStorage() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : void 0;
  } catch {
    return void 0;
  }
}
function createSessionGatewayLane(options) {
  const cap = options.appliedSeqCap ?? APPLIED_SEQ_CAP;
  const createClient = options.createClient ?? defaultCreateClient;
  return async (handlers) => {
    let grant;
    try {
      grant = await options.fetchGrant(handlers.signal);
    } catch {
      return null;
    }
    if (!grant || handlers.signal.aborted) return null;
    const appliedSeqs = /* @__PURE__ */ new Set();
    let firstTurnEventSent = false;
    let closed = false;
    let client;
    const replayStorage = options.replayStorage === null ? void 0 : options.replayStorage ?? defaultReplayStorage();
    const config = {
      url: grant.url,
      token: grant.token,
      sessionId: grant.sessionId,
      autoReconnect: true,
      ...replayStorage ? { enableReplayPersistence: true, replayStorage } : {},
      onTokenRefresh: async () => {
        const refreshed = await options.fetchGrant(handlers.signal);
        if (!refreshed) throw new Error("stream token refresh unavailable");
        return { token: refreshed.token, expiresAt: refreshed.expiresAt };
      },
      handlers: {
        onAgentEvent: (_channel, data, sequenceId) => {
          if (closed) return;
          if (typeof sequenceId === "number" && Number.isSafeInteger(sequenceId) && sequenceId >= 0) {
            if (appliedSeqs.has(sequenceId)) return;
            if (appliedSeqs.size < cap) appliedSeqs.add(sequenceId);
          }
          const event = gatewayFrameToTurnEvent(data);
          if (!event || isGatewayTransportNotice(event.type)) return;
          if (!firstTurnEventSent) {
            firstTurnEventSent = true;
            handlers.onFirstTurnEvent?.();
          }
          handlers.onEvent(event);
          if (isTerminalGatewayEvent(event.type)) handlers.onTerminal?.();
        },
        onBackpressureWarning: (_dropped, since) => {
          if (closed) return;
          try {
            const replay = client.replay(since);
            if (replay && typeof replay.then === "function") {
              void replay.catch((error) => {
                if (!closed) {
                  handlers.onUnusable?.(
                    `replay failed: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
              });
            }
          } catch (error) {
            handlers.onUnusable?.(
              `replay failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        },
        onTokenExpired: () => {
          if (!closed) handlers.onUnusable?.("token expired");
        },
        onError: (message, code) => {
          if (!closed) handlers.onUnusable?.(code ? `${code}: ${message}` : message);
        }
      }
    };
    try {
      client = await createClient(config);
    } catch {
      return null;
    }
    if (handlers.signal.aborted) {
      client.disconnect();
      return null;
    }
    try {
      client.connect();
    } catch {
      client.disconnect();
      return null;
    }
    return {
      close: () => {
        if (closed) return;
        closed = true;
        appliedSeqs.clear();
        client.clearReplayState();
        client.disconnect();
      }
    };
  };
}
export {
  APPLIED_SEQ_CAP,
  GATEWAY_TERMINAL_EVENT_TYPES,
  GATEWAY_TRANSPORT_NOTICE_TYPES,
  createSessionGatewayLane,
  createSessionStreamGrantFetcher,
  gatewayFrameToTurnEvent,
  isGatewayTransportNotice,
  isTerminalGatewayEvent,
  parseSessionStreamGrant
};
//# sourceMappingURL=session-gateway.js.map