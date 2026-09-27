// src/web-react/sandbox-terminal.ts
import { useCallback, useEffect, useRef, useState } from "react";
var DEFAULT_PROVISION_POLL_INTERVAL_MS = 2e3;
var DEFAULT_PROVISION_POLL_TIMEOUT_MS = 9e4;
var DEFAULT_TOKEN_REFRESH_SKEW_MS = 12e4;
var EMPTY_CONNECTION = {
  runtimeUrl: null,
  sidecarUrl: null,
  token: null,
  expiresAt: null,
  status: "idle",
  error: null,
  loading: false
};
function useSandboxTerminalConnection(opts) {
  const [conn, setConn] = useState(EMPTY_CONNECTION);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const fetcher = opts.fetcher ?? fetch;
  const pollIntervalMs = opts.provisionPollIntervalMs ?? DEFAULT_PROVISION_POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.provisionPollTimeoutMs ?? DEFAULT_PROVISION_POLL_TIMEOUT_MS;
  const refreshSkewMs = opts.tokenRefreshSkewMs ?? DEFAULT_TOKEN_REFRESH_SKEW_MS;
  const connectionUrl = useCallback(() => {
    const base = typeof opts.connectionUrl === "function" ? opts.connectionUrl(opts.workspaceId) : opts.connectionUrl ?? `/api/workspaces/${encodeURIComponent(opts.workspaceId)}/sandbox/connection`;
    if (!opts.connectionId) return base;
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}connectionId=${encodeURIComponent(opts.connectionId)}`;
  }, [opts.connectionUrl, opts.workspaceId, opts.connectionId]);
  const connect = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const isCurrent = () => mountedRef.current && generationRef.current === generation;
    const setCurrentConn = (value) => {
      if (!isCurrent()) return;
      setConn(value);
    };
    setCurrentConn((current) => ({ ...current, loading: true, error: null }));
    const deadline = Date.now() + pollTimeoutMs;
    while (isCurrent()) {
      try {
        const res = await fetcher(connectionUrl());
        const data = await res.json();
        if (!isCurrent()) return;
        const runtimeUrl = data.runtimeUrl ?? data.sidecarUrl;
        if (res.ok && runtimeUrl && data.token && data.expiresAt) {
          setCurrentConn({
            runtimeUrl,
            sidecarUrl: data.sidecarUrl ?? runtimeUrl,
            token: data.token,
            expiresAt: data.expiresAt,
            status: data.status ?? "running",
            error: null,
            loading: false,
            ...data.sandboxId ? { sandboxId: data.sandboxId } : {},
            ...data.connectionId ? { connectionId: data.connectionId } : {}
          });
          return;
        }
        if (res.ok) {
          setCurrentConn({
            runtimeUrl: null,
            sidecarUrl: null,
            token: null,
            expiresAt: null,
            loading: false,
            error: "Sandbox connection response is missing required fields",
            status: data.status ?? "error",
            ...data.sandboxId ? { sandboxId: data.sandboxId } : {}
          });
          return;
        }
        if (res.status === 503 && Date.now() < deadline) {
          setCurrentConn((current) => ({
            ...current,
            loading: true,
            status: data.status ?? "provisioning",
            error: null
          }));
          await sleep(pollIntervalMs);
          continue;
        }
        setCurrentConn((current) => ({
          ...current,
          runtimeUrl: null,
          sidecarUrl: null,
          token: null,
          expiresAt: null,
          loading: false,
          error: data.error ?? "Sandbox not available",
          status: data.status ?? "error"
        }));
        return;
      } catch (err) {
        if (!isCurrent()) return;
        if (Date.now() < deadline) {
          await sleep(pollIntervalMs);
          continue;
        }
        setCurrentConn((current) => ({
          ...current,
          runtimeUrl: null,
          sidecarUrl: null,
          token: null,
          expiresAt: null,
          loading: false,
          error: err instanceof Error ? err.message : "Connection failed"
        }));
        return;
      }
    }
  }, [connectionUrl, fetcher, pollIntervalMs, pollTimeoutMs]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);
  useEffect(() => {
    void connect();
  }, [connect]);
  useEffect(() => {
    if (!conn.runtimeUrl || !conn.token || !conn.expiresAt) return;
    const refreshAt = Date.parse(conn.expiresAt) - Date.now() - refreshSkewMs;
    if (!Number.isFinite(refreshAt)) {
      setConn((current) => ({
        ...current,
        runtimeUrl: null,
        sidecarUrl: null,
        token: null,
        expiresAt: null,
        status: "error",
        error: "Sandbox token expiry is invalid"
      }));
      return;
    }
    const timer = window.setTimeout(() => {
      void connect();
    }, Math.max(1e3, refreshAt));
    return () => window.clearTimeout(timer);
  }, [conn.runtimeUrl, conn.token, conn.expiresAt, connect, refreshSkewMs]);
  return { ...conn, connect };
}
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
var DEFAULT_TERMINAL_CID_KEY = "agent-app:terminal-connection-id";
function newConnectionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `cid-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
function tabTerminalConnectionId(storageKey = DEFAULT_TERMINAL_CID_KEY) {
  try {
    const store = globalThis.sessionStorage;
    const existing = store?.getItem(storageKey);
    if (existing) return existing;
    const id = newConnectionId();
    store?.setItem(storageKey, id);
    return id;
  } catch {
    return newConnectionId();
  }
}

export {
  useSandboxTerminalConnection,
  tabTerminalConnectionId
};
//# sourceMappingURL=chunk-BATKJP3P.js.map