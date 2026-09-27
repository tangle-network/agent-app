import {
  reconcileStaleTurnLock
} from "../chunk-CCVWR33L.js";
import {
  DEFAULT_RUNNING_TURN_LEASE_MS
} from "../chunk-HXTJXODG.js";

// src/turn-stream/core.ts
function isTerminalRunEvent(type) {
  return type === "session.run.completed" || type === "session.run.failed";
}
function threadChannelKey(workspaceId, threadId) {
  return `${workspaceId}:${threadId}`;
}
function workspaceChannelKey(workspaceId) {
  return workspaceId;
}
function turnLockChannelKey(workspaceId, threadId, scope) {
  return scope === "workspace" ? workspaceChannelKey(workspaceId) : threadChannelKey(workspaceId, threadId);
}
function turnStorageChannelKey(turnId) {
  return `turn:${turnId}`;
}
function scopeIndexChannelKey(scopeId) {
  return `scope:${scopeId}`;
}
var MAX_SEGMENT_EVENTS = 2e3;
var MAX_RECENT_CREATED = 50;
var ACTIVITY_TTL_MS = 15 * 60 * 1e3;
function createSegmentStore() {
  return { segments: /* @__PURE__ */ new Map(), activeExecutionId: null };
}
function appendSegmentEvent(store, executionId, incoming, maxEvents = MAX_SEGMENT_EVENTS) {
  let segment = store.segments.get(executionId);
  if (incoming.type === "session.run.started" || !segment) {
    if (!segment) {
      segment = { events: [], maxSeq: 0, terminal: false };
      store.segments.set(executionId, segment);
    }
    store.activeExecutionId = executionId;
    for (const id of store.segments.keys()) {
      if (id !== executionId) store.segments.delete(id);
    }
  }
  const seq = ++segment.maxSeq;
  const stamped = { ...incoming, seq };
  segment.events.push(stamped);
  if (segment.events.length > maxEvents) {
    segment.events = segment.events.slice(-maxEvents);
  }
  if (isTerminalRunEvent(incoming.type)) {
    segment.terminal = true;
  }
  return stamped;
}
function replayActiveSegment(store, afterSeq) {
  const segment = store.activeExecutionId ? store.segments.get(store.activeExecutionId) : void 0;
  if (!segment || segment.terminal) return [];
  return segment.events.filter((event) => (event.seq ?? 0) > afterSeq);
}
function pruneStaleThreads(active, now, ttlMs) {
  const removed = [];
  for (const [threadId, startedAt] of active) {
    if (now - startedAt > ttlMs) {
      active.delete(threadId);
      removed.push(threadId);
    }
  }
  return removed;
}
var TURN_LOCK_TTL_MS = 30 * 60 * 1e3;
function activeTurnLock(stored, now) {
  if (!stored) return null;
  const lock = stored.scope ? stored : { ...stored, scope: "thread" };
  return lock.expiresAt > now ? lock : null;
}
function createTurnLock(input, now, ttlMs = TURN_LOCK_TTL_MS) {
  return {
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    scope: input.scope,
    executionId: input.executionId,
    lockId: input.lockId,
    startedAt: now,
    expiresAt: now + ttlMs,
    ...input.turnId ? { turnId: input.turnId } : {}
  };
}
function turnLockMatchesRelease(active, input) {
  if (active.executionId !== input.executionId) return false;
  if (input.lockId && active.lockId !== input.lockId) return false;
  return true;
}
function interruptedReleaseApplies(active, input) {
  if (active.threadId !== input.threadId) return false;
  if (active.startedAt > input.interruptedAt) return false;
  if (active.turnId) {
    if (active.turnId !== input.turnId) return false;
  } else if (input.turnId) {
    return false;
  }
  return true;
}
var TURN_STREAM_PATHS = {
  broadcast: "/broadcast",
  lockAcquire: "/chat-turn-lock/acquire",
  lockRelease: "/chat-turn-lock/release",
  lockReleaseInterrupted: "/chat-turn-lock/release-interrupted",
  turnEventsAppend: "/turn-events/append",
  turnEventsRead: "/turn-events/read",
  turnStatusSet: "/turn-status/set",
  turnStatusGet: "/turn-status/get",
  scopeStatusSet: "/turn-scope/set",
  scopeRunningList: "/turn-scope/running"
};
var TURN_STREAM_STORAGE_KEYS = {
  lock: "chatTurnLock",
  activeThreads: "activeThreads",
  turnStatus: "turnStatus",
  turnScope: "turnScopeIndex",
  turnEventPrefix: "turnEvent:"
};
function turnEventStorageKey(seq) {
  return `${TURN_STREAM_STORAGE_KEYS.turnEventPrefix}${String(seq).padStart(10, "0")}`;
}

// src/turn-stream/do.ts
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
async function jsonBody(request) {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? body : null;
}
var MAX_SCOPE_TURNS = 100;
var TurnStreamDO = class {
  state;
  env;
  options;
  // Thread channel: per-turn segments; only the active one is replayed.
  segments = createSegmentStore();
  // Workspace channel: recent thread.created markers (in-memory, best-effort)
  // + durable responding set (threadId → startedAt) that survives eviction.
  recentCreated = [];
  activeThreads = null;
  constructor(state, env, options = {}) {
    this.state = state;
    this.env = env;
    this.options = options;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request, url);
    }
    if (request.method === "POST") {
      switch (url.pathname) {
        case TURN_STREAM_PATHS.broadcast:
          return this.handleBroadcast(request);
        case TURN_STREAM_PATHS.lockAcquire:
          return this.handleLockAcquire(request);
        case TURN_STREAM_PATHS.lockRelease:
          return this.handleLockRelease(request);
        case TURN_STREAM_PATHS.lockReleaseInterrupted:
          return this.handleLockReleaseInterrupted(request);
        case TURN_STREAM_PATHS.turnEventsAppend:
          return this.handleTurnEventsAppend(request);
        case TURN_STREAM_PATHS.turnEventsRead:
          return this.handleTurnEventsRead(request);
        case TURN_STREAM_PATHS.turnStatusSet:
          return this.handleTurnStatusSet(request);
        case TURN_STREAM_PATHS.turnStatusGet:
          return this.handleTurnStatusGet();
        case TURN_STREAM_PATHS.scopeStatusSet:
          return this.handleScopeStatusSet(request);
        case TURN_STREAM_PATHS.scopeRunningList:
          return this.handleScopeRunningList();
      }
    }
    const product = await this.handleProductRequest(request, url);
    if (product) return product;
    return request.method === "POST" ? jsonResponse({ error: `Unknown turn-stream endpoint ${url.pathname}` }, 404) : new Response("Method not allowed", { status: 405 });
  }
  // ── product extension seam ────────────────────────────────────────────────
  /** Called for any request no base endpoint claimed (before the 404), so a
   *  subclass adds product endpoints without touching base routing. Return
   *  `null` to decline. */
  async handleProductRequest(_request, _url) {
    return null;
  }
  /** Consulted before any lock release (cooperative, interrupted, or the
   *  terminal-event auto-release). Return `true` while a product-owned
   *  post-turn task for `executionId` must keep the scope serialized (e.g.
   *  file persistence still reading the box) — the release is then parked as
   *  `releasePending` on the lock and completed via
   *  {@link completeDeferredLockRelease}. Base: never defer. */
  async shouldDeferLockRelease(_executionId) {
    return false;
  }
  /** Complete a release parked by {@link shouldDeferLockRelease}. A subclass
   *  calls this when its deferred condition settles. */
  async completeDeferredLockRelease(executionId) {
    const active = await this.loadActiveLock();
    if (!active?.releasePending || active.executionId !== executionId) return false;
    await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock);
    return true;
  }
  /** Extra product state replayed to a socket during its `sync`, after the
   *  base replay for its scope (e.g. an in-flight persistence status card).
   *  Base: none. */
  async productSyncEvents(_scope, _meta) {
    return [];
  }
  // ── WebSocket channel ─────────────────────────────────────────────────────
  handleWebSocketUpgrade(_request, url) {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) return new Response("Missing sessionId", { status: 400 });
    const scope = url.searchParams.get("scope") === "workspace" ? "workspace" : "thread";
    const PairCtor = globalThis.WebSocketPair;
    if (!PairCtor) {
      return new Response("WebSocket upgrades require the Cloudflare runtime", { status: 501 });
    }
    const pair = new PairCtor();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ sessionId, scope, synced: false });
    return new Response(null, { status: 101, webSocket: client });
  }
  /**
   * First (and only) client message after open: `{ type: 'sync', afterSeq }`.
   * Replays the current state for the socket's scope, then marks it `synced`
   * so live broadcasts start flowing. Because the DO is single-threaded, the
   * replay snapshot and the synced flip are atomic w.r.t. broadcasts — every
   * event reaches the socket exactly once, in order, via replay XOR live
   * fan-out.
   */
  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment();
    if (!meta || meta.synced) return;
    let afterSeq = 0;
    try {
      const parsed = JSON.parse(typeof message === "string" ? message : "");
      if (parsed.type !== "sync") return;
      afterSeq = typeof parsed.afterSeq === "number" ? parsed.afterSeq : 0;
    } catch {
      return;
    }
    if (meta.scope === "workspace") {
      const active = await this.loadActiveThreads();
      const removed = pruneStaleThreads(active, Date.now(), this.options.activityTtlMs ?? ACTIVITY_TTL_MS);
      if (removed.length > 0) await this.persistActiveThreads(active);
      for (const [threadId, startedAt] of active) {
        this.trySend(ws, {
          type: "thread.activity",
          data: { threadId, phase: "start", sessionId: meta.sessionId },
          timestamp: startedAt
        });
      }
      for (const event of this.recentCreated) this.trySend(ws, event);
    } else {
      for (const event of replayActiveSegment(this.segments, afterSeq)) {
        this.trySend(ws, event);
      }
    }
    for (const event of await this.productSyncEvents(meta.scope, { sessionId: meta.sessionId })) {
      this.trySend(ws, event);
    }
    ws.serializeAttachment({ ...meta, synced: true });
  }
  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
    }
  }
  webSocketError() {
  }
  trySend(ws, event) {
    try {
      ws.send(JSON.stringify(event));
    } catch {
    }
  }
  // ── broadcast (live fanout + segments + activity) ─────────────────────────
  async handleBroadcast(request) {
    const incoming = await request.json();
    const data = incoming.data ?? {};
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : void 0;
    let outgoing = incoming;
    if (incoming.type === "thread.activity") {
      const threadId = typeof data.threadId === "string" ? data.threadId : void 0;
      if (threadId) {
        const active = await this.loadActiveThreads();
        if (data.phase === "end") active.delete(threadId);
        else active.set(threadId, Date.now());
        await this.persistActiveThreads(active);
      }
    } else if (incoming.type === "thread.created") {
      this.recentCreated.push(incoming);
      if (this.recentCreated.length > MAX_RECENT_CREATED) {
        this.recentCreated = this.recentCreated.slice(-MAX_RECENT_CREATED);
      }
    } else if (typeof data.executionId === "string") {
      outgoing = appendSegmentEvent(
        this.segments,
        data.executionId,
        incoming,
        this.options.maxSegmentEvents ?? MAX_SEGMENT_EVENTS
      );
      if (isTerminalRunEvent(incoming.type)) {
        if (await this.shouldDeferLockRelease(data.executionId)) {
          await this.deferLockRelease({ executionId: data.executionId });
        } else {
          await this.releaseActiveLock({ executionId: data.executionId });
        }
      }
    }
    const message = JSON.stringify(outgoing);
    for (const ws of this.state.getWebSockets()) {
      const meta = ws.deserializeAttachment();
      if (!meta?.synced) continue;
      if (!sessionId || meta.sessionId === sessionId) {
        try {
          ws.send(message);
        } catch {
        }
      }
    }
    return new Response("OK", { status: 200 });
  }
  async loadActiveThreads() {
    if (this.activeThreads === null) {
      const stored = await this.state.storage.get(TURN_STREAM_STORAGE_KEYS.activeThreads);
      this.activeThreads = new Map(Object.entries(stored ?? {}));
    }
    return this.activeThreads;
  }
  async persistActiveThreads(map) {
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.activeThreads, Object.fromEntries(map));
  }
  // ── chat-turn lock ────────────────────────────────────────────────────────
  async loadActiveLock(now = Date.now()) {
    const stored = await this.state.storage.get(TURN_STREAM_STORAGE_KEYS.lock);
    const lock = activeTurnLock(stored, now);
    if (stored && !lock) await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock);
    return lock;
  }
  async releaseActiveLock(input) {
    const active = await this.loadActiveLock();
    if (!active || !turnLockMatchesRelease(active, input)) return false;
    await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock);
    return true;
  }
  /** Park a release on the lock itself; {@link completeDeferredLockRelease}
   *  finishes it once the product's deferred condition settles. */
  async deferLockRelease(input) {
    const active = await this.loadActiveLock();
    if (!active || !turnLockMatchesRelease(active, input)) return false;
    if (active.releasePending) return true;
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.lock, { ...active, releasePending: true });
    return true;
  }
  async handleLockAcquire(request) {
    const body = await jsonBody(request);
    const workspaceId = stringValue(body?.workspaceId);
    const threadId = stringValue(body?.threadId);
    const executionId = stringValue(body?.executionId);
    const lockId = stringValue(body?.lockId);
    const scope = body?.scope === "workspace" ? "workspace" : body?.scope === "thread" ? "thread" : null;
    const turnId = stringValue(body?.turnId) ?? void 0;
    if (!workspaceId || !threadId || !executionId || !lockId || !scope) {
      return jsonResponse({ error: "Missing workspaceId, threadId, executionId, lockId, or scope" }, 400);
    }
    const active = await this.loadActiveLock();
    if (active) {
      return jsonResponse({ acquired: false, active }, 409);
    }
    const lock = createTurnLock(
      { workspaceId, threadId, scope, executionId, lockId, ...turnId ? { turnId } : {} },
      Date.now(),
      this.options.lockTtlMs ?? TURN_LOCK_TTL_MS
    );
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.lock, lock);
    return jsonResponse({ acquired: true, lock });
  }
  async handleLockRelease(request) {
    const body = await jsonBody(request);
    const executionId = stringValue(body?.executionId);
    const lockId = stringValue(body?.lockId);
    if (!executionId || !lockId) {
      return jsonResponse({ error: "Missing executionId or lockId" }, 400);
    }
    if (await this.shouldDeferLockRelease(executionId)) {
      const deferred = await this.deferLockRelease({ executionId, lockId });
      return jsonResponse({ released: false, deferred });
    }
    const released = await this.releaseActiveLock({ executionId, lockId });
    return jsonResponse({ released });
  }
  async handleLockReleaseInterrupted(request) {
    const body = await jsonBody(request);
    const threadId = stringValue(body?.threadId);
    const interruptedAt = typeof body?.interruptedAt === "number" && Number.isFinite(body.interruptedAt) ? body.interruptedAt : void 0;
    if (!threadId || interruptedAt === void 0) {
      return jsonResponse({ error: "Missing threadId or interruptedAt" }, 400);
    }
    const turnId = stringValue(body?.turnId) ?? void 0;
    const active = await this.loadActiveLock();
    if (!active) return jsonResponse({ released: false });
    if (await this.shouldDeferLockRelease(active.executionId)) {
      return jsonResponse({ released: false });
    }
    if (!interruptedReleaseApplies(active, { threadId, interruptedAt, ...turnId ? { turnId } : {} })) {
      return jsonResponse({ released: false });
    }
    await this.state.storage.delete(TURN_STREAM_STORAGE_KEYS.lock);
    return jsonResponse({ released: true });
  }
  // ── durable turn-event storage (TurnEventStore backing) ───────────────────
  async handleTurnEventsAppend(request) {
    const body = await jsonBody(request);
    const events = Array.isArray(body?.events) ? body.events : null;
    if (!events) return jsonResponse({ error: "Missing events" }, 400);
    for (const row of events) {
      const seq = row.seq;
      const event = row.event;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || typeof event !== "string") {
        return jsonResponse({ error: "Invalid turn-event row" }, 400);
      }
    }
    const status = await this.state.storage.get(TURN_STREAM_STORAGE_KEYS.turnStatus);
    if (status === "complete" || status === "error") return jsonResponse({ appended: 0 });
    for (const row of events) {
      await this.state.storage.put(turnEventStorageKey(row.seq), row.event);
    }
    return jsonResponse({ appended: events.length });
  }
  async handleTurnEventsRead(request) {
    const body = await jsonBody(request);
    const fromSeq = typeof body?.fromSeq === "number" && Number.isFinite(body.fromSeq) ? Math.trunc(body.fromSeq) : 0;
    const rows = await this.state.storage.list({
      prefix: TURN_STREAM_STORAGE_KEYS.turnEventPrefix,
      start: turnEventStorageKey(fromSeq + 1)
    });
    const events = [];
    for (const [key, event] of rows) {
      const seq = Number(key.slice(TURN_STREAM_STORAGE_KEYS.turnEventPrefix.length));
      if (Number.isFinite(seq) && seq > fromSeq) events.push({ seq, event });
    }
    return jsonResponse({ events });
  }
  async handleTurnStatusSet(request) {
    const body = await jsonBody(request);
    const status = body?.status;
    if (status !== "running" && status !== "complete" && status !== "error") {
      return jsonResponse({ error: "Invalid status" }, 400);
    }
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.turnStatus, status);
    return jsonResponse({ ok: true });
  }
  async handleTurnStatusGet() {
    const status = await this.state.storage.get(TURN_STREAM_STORAGE_KEYS.turnStatus);
    return jsonResponse({ status: status ?? null });
  }
  // ── scope index (listRunning reconnect discovery) ─────────────────────────
  async handleScopeStatusSet(request) {
    const body = await jsonBody(request);
    const turnId = stringValue(body?.turnId);
    const status = body?.status;
    if (!turnId || status !== "running" && status !== "complete" && status !== "error") {
      return jsonResponse({ error: "Invalid scope-status request" }, 400);
    }
    const index = await this.state.storage.get(TURN_STREAM_STORAGE_KEYS.turnScope) ?? {};
    index[turnId] = { status, updatedAt: Date.now() };
    const entries = Object.entries(index);
    if (entries.length > MAX_SCOPE_TURNS) {
      const removable = entries.filter(([, entry]) => entry.status !== "running").sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [id] of removable.slice(0, entries.length - MAX_SCOPE_TURNS)) {
        delete index[id];
      }
    }
    await this.state.storage.put(TURN_STREAM_STORAGE_KEYS.turnScope, index);
    return jsonResponse({ ok: true });
  }
  async handleScopeRunningList() {
    const index = await this.state.storage.get(TURN_STREAM_STORAGE_KEYS.turnScope) ?? {};
    const cutoff = Date.now() - Math.max(
      1,
      this.options.runningTurnLeaseMs ?? DEFAULT_RUNNING_TURN_LEASE_MS
    );
    const running = Object.entries(index).filter(([, entry]) => entry.status === "running" && entry.updatedAt >= cutoff).sort((a, b) => b[1].updatedAt - a[1].updatedAt).map(([turnId]) => turnId);
    return jsonResponse({ running });
  }
};

// src/turn-stream/adapters.ts
var INTERNAL_ORIGIN = "https://turn-stream.internal";
async function postJson(namespace, channelKey, path, body) {
  const stub = namespace.get(namespace.idFromName(channelKey));
  const response = await stub.fetch(`${INTERNAL_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
async function postJsonOk(namespace, channelKey, path, body) {
  const result = await postJson(namespace, channelKey, path, body);
  if (result.status !== 200) {
    throw new Error(`turn-stream ${path} failed with status ${result.status}`);
  }
  return result.body;
}
function createDurableObjectTurnEventStore(namespace) {
  return {
    async append(turnId, events) {
      if (!events.length) return;
      await postJsonOk(namespace, turnStorageChannelKey(turnId), TURN_STREAM_PATHS.turnEventsAppend, { events });
    },
    async read(turnId, fromSeq) {
      const body = await postJsonOk(
        namespace,
        turnStorageChannelKey(turnId),
        TURN_STREAM_PATHS.turnEventsRead,
        { fromSeq }
      );
      return body.events;
    },
    async setStatus(turnId, status, scopeId) {
      await postJsonOk(namespace, turnStorageChannelKey(turnId), TURN_STREAM_PATHS.turnStatusSet, { status });
      if (scopeId) {
        await postJsonOk(namespace, scopeIndexChannelKey(scopeId), TURN_STREAM_PATHS.scopeStatusSet, {
          turnId,
          status
        });
      }
    },
    async getStatus(turnId) {
      const body = await postJsonOk(
        namespace,
        turnStorageChannelKey(turnId),
        TURN_STREAM_PATHS.turnStatusGet,
        {}
      );
      return body.status;
    },
    async listRunning(scopeId) {
      const body = await postJsonOk(
        namespace,
        scopeIndexChannelKey(scopeId),
        TURN_STREAM_PATHS.scopeRunningList,
        {}
      );
      return body.running;
    }
  };
}
async function acquireDurableTurnLock(namespace, input) {
  const lockId = input.lockId ?? crypto.randomUUID();
  const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope);
  const result = await postJson(namespace, key, TURN_STREAM_PATHS.lockAcquire, {
    ...input,
    lockId
  });
  if (result.status !== 200 && result.status !== 409) {
    throw new Error(`turn-stream lock acquire failed with status ${result.status}`);
  }
  return result.body;
}
async function releaseDurableTurnLock(namespace, input) {
  const key = turnLockChannelKey(input.workspaceId, input.threadId, input.scope);
  return postJsonOk(namespace, key, TURN_STREAM_PATHS.lockRelease, input);
}
async function releaseInterruptedDurableTurnLock(namespace, input) {
  const scopes = input.scope ? [input.scope] : ["workspace", "thread"];
  for (const scope of scopes) {
    const key = turnLockChannelKey(input.workspaceId, input.threadId, scope);
    const result = await postJsonOk(namespace, key, TURN_STREAM_PATHS.lockReleaseInterrupted, {
      threadId: input.threadId,
      interruptedAt: input.interruptedAt,
      ...input.turnId ? { turnId: input.turnId } : {}
    });
    if (result.released) return true;
  }
  return false;
}
async function reconcileStaleDurableTurnLock(options) {
  const { namespace, workspaceId, threadId, active, ...policy } = options;
  return reconcileStaleTurnLock({
    ...policy,
    lockStartedAt: active.startedAt,
    release: (fence) => releaseInterruptedDurableTurnLock(namespace, {
      workspaceId,
      threadId: active.threadId,
      scope: active.scope,
      interruptedAt: fence.observedAt,
      ...active.turnId ? { turnId: active.turnId } : {}
    })
  });
}
function defaultRefusalResponse(active, diagnostics) {
  const workspaceConflict = active.scope === "workspace";
  return Response.json(
    {
      error: {
        code: workspaceConflict ? "workspace_turn_in_flight" : "chat_turn_in_flight",
        message: workspaceConflict ? "A chat turn is already running for this workspace. Wait for it to finish before starting another." : "A chat turn is already running for this thread. Reconnect to the active response or wait for it to finish.",
        threadId: active.threadId,
        executionId: active.executionId,
        ...active.turnId ? { turnId: active.turnId } : {},
        lockStartedAt: active.startedAt,
        lockAgeMs: Date.now() - active.startedAt,
        ...diagnostics ? { diagnostics } : {}
      }
    },
    { status: 409 }
  );
}
function createDurableTurnLock(options) {
  return {
    async acquire(args) {
      const workspaceId = args.identity.tenantId;
      const threadId = args.identity.sessionId;
      const scope = options.scopeOf(args);
      const executionId = options.lockExecutionIdOf?.(args) ?? args.executionId;
      const turnId = options.clientTurnIdOf ? options.clientTurnIdOf(args) : args.body.turnId;
      const input = {
        workspaceId,
        threadId,
        scope,
        executionId,
        ...turnId ? { turnId } : {}
      };
      let acquired = await acquireDurableTurnLock(options.namespace, input);
      let diagnostics;
      if (!acquired.acquired && options.reconcile) {
        const reconciled = await options.reconcile(args, acquired.active);
        diagnostics = reconciled.diagnostics;
        if (reconciled.released) {
          acquired = await acquireDurableTurnLock(options.namespace, input);
        }
      }
      if (!acquired.acquired) {
        return {
          acquired: false,
          response: (options.onRefused ?? defaultRefusalResponse)(acquired.active, diagnostics)
        };
      }
      const handle = {
        workspaceId,
        threadId,
        scope,
        executionId,
        lockId: acquired.lock.lockId
      };
      return { acquired: true, handle };
    },
    async release(handle) {
      if (!handle) return;
      await releaseDurableTurnLock(options.namespace, handle);
    }
  };
}
async function broadcastTurnStreamEvent(namespace, input) {
  try {
    await postJson(namespace, threadChannelKey(input.workspaceId, input.threadId), TURN_STREAM_PATHS.broadcast, {
      type: input.event.type,
      timestamp: Date.now(),
      data: {
        ...input.event.data ?? {},
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        sessionId: input.threadId,
        executionId: input.executionId
      }
    });
  } catch {
  }
}
async function broadcastWorkspaceActivity(namespace, workspaceId, threadId, phase) {
  try {
    await postJson(namespace, workspaceChannelKey(workspaceId), TURN_STREAM_PATHS.broadcast, {
      type: "thread.activity",
      timestamp: Date.now(),
      data: { threadId, phase, workspaceId, sessionId: workspaceId }
    });
  } catch {
  }
}
async function broadcastThreadCreated(namespace, workspaceId, thread) {
  try {
    await postJson(namespace, workspaceChannelKey(workspaceId), TURN_STREAM_PATHS.broadcast, {
      type: "thread.created",
      timestamp: Date.now(),
      data: { threadId: thread.threadId, title: thread.title, workspaceId, sessionId: workspaceId }
    });
  } catch {
  }
}
function createTurnStreamUpgradeHandler(options) {
  const path = options.path ?? "/api/session-stream";
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== path || request.headers.get("Upgrade") !== "websocket") return null;
    const workspaceId = url.searchParams.get("workspaceId");
    const threadId = url.searchParams.get("threadId");
    if (!workspaceId) return new Response("Missing workspaceId", { status: 400 });
    const auth = await options.authorize(request, { workspaceId, threadId });
    if (!auth.ok) return auth.response;
    const key = threadId ? threadChannelKey(workspaceId, threadId) : workspaceChannelKey(workspaceId);
    const sessionId = threadId ?? workspaceId;
    const stub = options.namespace.get(options.namespace.idFromName(key));
    const forwardUrl = new URL(request.url);
    forwardUrl.searchParams.set("sessionId", sessionId);
    forwardUrl.searchParams.set("scope", threadId ? "thread" : "workspace");
    return stub.fetch(new Request(forwardUrl, request));
  };
}

// src/turn-stream/memory.ts
function createMemoryStorage() {
  const map = /* @__PURE__ */ new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      return map.delete(key);
    },
    async list({ prefix, start }) {
      const keys = [...map.keys()].filter((key) => key.startsWith(prefix) && (start === void 0 || key >= start)).sort();
      return new Map(keys.map((key) => [key, map.get(key)]));
    }
  };
}
function createMemoryTurnStreamHarness(createInstance = (state) => new TurnStreamDO(state), _options = {}) {
  const instances = /* @__PURE__ */ new Map();
  function ensure(name) {
    let entry = instances.get(name);
    if (!entry) {
      const sockets = [];
      const state = {
        storage: createMemoryStorage(),
        acceptWebSocket: (ws) => sockets.push(ws),
        getWebSockets: () => sockets.filter((ws) => !ws.closed)
      };
      entry = { instance: createInstance(state), sockets };
      instances.set(name, entry);
    }
    return entry;
  }
  const namespace = {
    idFromName: (name) => name,
    get(id) {
      const entry = ensure(String(id));
      return {
        fetch: (input, init) => entry.instance.fetch(typeof input === "string" ? new Request(input, init) : input)
      };
    }
  };
  return {
    namespace,
    channel(name) {
      const entry = ensure(name);
      return {
        instance: entry.instance,
        async connect({ sessionId, scope, afterSeq = 0 }) {
          let attachment = null;
          const frames = [];
          let closed = false;
          const socket = {
            get frames() {
              return frames;
            },
            get closed() {
              return closed;
            },
            send(data) {
              if (closed) throw new Error("socket closed");
              frames.push(data);
            },
            close() {
              closed = true;
            },
            serializeAttachment(value) {
              attachment = value;
            },
            deserializeAttachment() {
              return attachment;
            }
          };
          socket.serializeAttachment({ sessionId, scope, synced: false });
          entry.sockets.push(socket);
          await entry.instance.webSocketMessage(socket, JSON.stringify({ type: "sync", afterSeq }));
          return socket;
        }
      };
    }
  };
}
export {
  ACTIVITY_TTL_MS,
  MAX_RECENT_CREATED,
  MAX_SEGMENT_EVENTS,
  TURN_LOCK_TTL_MS,
  TURN_STREAM_PATHS,
  TURN_STREAM_STORAGE_KEYS,
  TurnStreamDO,
  acquireDurableTurnLock,
  activeTurnLock,
  appendSegmentEvent,
  broadcastThreadCreated,
  broadcastTurnStreamEvent,
  broadcastWorkspaceActivity,
  createDurableObjectTurnEventStore,
  createDurableTurnLock,
  createMemoryTurnStreamHarness,
  createSegmentStore,
  createTurnLock,
  createTurnStreamUpgradeHandler,
  interruptedReleaseApplies,
  isTerminalRunEvent,
  pruneStaleThreads,
  reconcileStaleDurableTurnLock,
  releaseDurableTurnLock,
  releaseInterruptedDurableTurnLock,
  replayActiveSegment,
  scopeIndexChannelKey,
  threadChannelKey,
  turnEventStorageKey,
  turnLockChannelKey,
  turnLockMatchesRelease,
  turnStorageChannelKey,
  workspaceChannelKey
};
//# sourceMappingURL=index.js.map