// src/stream/turn-buffer.ts
var DEFAULT_RUNNING_TURN_LEASE_MS = 5 * 6e4;
var DEFAULT_RUNNING_TURN_RENEW_INTERVAL_MS = 3e4;
function deltaTypeOf(ev) {
  const e = ev;
  if (!e || typeof e !== "object") return null;
  const inner = e.kind === "event" ? e.event : e;
  if (!inner || typeof inner !== "object") return null;
  if ((inner.type === "text" || inner.type === "reasoning") && typeof inner.text === "string") {
    return inner.type;
  }
  return null;
}
function coalesceDeltas(events) {
  const out = [];
  for (const ev of events) {
    const type = deltaTypeOf(ev);
    const prev = out[out.length - 1];
    if (type && prev && deltaTypeOf(prev) === type) {
      const read = (x) => x.kind === "event" ? x.event : x;
      const merged = JSON.parse(JSON.stringify(prev));
      read(merged).text = String(read(prev).text) + String(read(ev).text);
      out[out.length - 1] = merged;
      continue;
    }
    out.push(ev);
  }
  return out;
}
function asPartUpdate(ev) {
  const e = ev;
  if (!e || typeof e !== "object" || e.type !== "message.part.updated") return null;
  const data = e.data;
  if (!data || typeof data !== "object") return null;
  const part = data.part;
  const partId = part?.id ?? data.partId ?? part?.partId ?? null;
  return { partId, delta: data.delta };
}
function coalesceChatStreamEvents(events) {
  const out = [];
  for (const ev of events) {
    const cur = asPartUpdate(ev);
    const prevEv = out[out.length - 1];
    const prev = prevEv ? asPartUpdate(prevEv) : null;
    if (cur && prev && cur.partId != null && cur.partId === prev.partId) {
      const merged = JSON.parse(JSON.stringify(ev));
      merged.data.delta = String(prev.delta ?? "") + String(cur.delta ?? "");
      out[out.length - 1] = merged;
      continue;
    }
    out.push(ev);
  }
  return out;
}
function createBufferedTurnTap(opts) {
  const flushIntervalMs = opts.flushIntervalMs ?? 400;
  const coalesce = opts.coalesce ?? coalesceDeltas;
  const startedAt = Date.now();
  let seq = 0;
  let clientGone = false;
  let pending = [];
  let lastFlush = Date.now();
  let started = false;
  let settled = false;
  let detached = false;
  let renewalTimer;
  let renewal = Promise.resolve();
  let lastRenewedAt = 0;
  const runningTurnRenewIntervalMs = Math.max(
    1,
    opts.runningTurnRenewIntervalMs ?? DEFAULT_RUNNING_TURN_RENEW_INTERVAL_MS
  );
  function clearRenewalTimer() {
    if (renewalTimer !== void 0) clearTimeout(renewalTimer);
    renewalTimer = void 0;
  }
  function scheduleRenewal() {
    if (settled || detached || !opts.scopeId) return;
    clearRenewalTimer();
    const elapsedMs = Math.max(0, Date.now() - lastRenewedAt);
    const delayMs = Math.max(1, runningTurnRenewIntervalMs - elapsedMs);
    renewalTimer = setTimeout(() => {
      renewalTimer = void 0;
      void renewLease();
    }, delayMs);
    if (typeof renewalTimer === "object" && "unref" in renewalTimer) {
      renewalTimer.unref();
    }
  }
  async function renewLease() {
    if (settled || detached || !opts.scopeId) return;
    clearRenewalTimer();
    lastRenewedAt = Date.now();
    renewal = renewal.then(() => opts.store.setStatus(opts.turnId, "running", opts.scopeId)).catch(() => {
    });
    await renewal;
    scheduleRenewal();
  }
  async function flush() {
    if (pending.length === 0) return;
    const batch = coalesce(pending);
    pending = [];
    const rows = batch.map((ev) => ({ seq: ++seq, event: JSON.stringify(ev) }));
    await opts.store.append(opts.turnId, rows);
    lastFlush = Date.now();
  }
  async function ensureStarted() {
    if (started) return;
    started = true;
    if (detached) return;
    await opts.store.setStatus(opts.turnId, "running", opts.scopeId);
    lastRenewedAt = Date.now();
    scheduleRenewal();
  }
  return {
    async onEvent(raw) {
      await ensureStarted();
      if (!detached && opts.scopeId && Date.now() - lastRenewedAt >= runningTurnRenewIntervalMs) {
        await renewLease();
      }
      const ev = raw && typeof raw === "object" ? { ...raw, _t: Date.now() - startedAt } : raw;
      pending.push(ev);
      if (!clientGone && opts.write) {
        try {
          await opts.write(JSON.stringify(ev));
        } catch {
          clientGone = true;
        }
      }
      if (detached || Date.now() - lastFlush >= flushIntervalMs) await flush();
    },
    async done(status = "complete") {
      await ensureStarted();
      if (detached) {
        await flush();
        return;
      }
      settled = true;
      clearRenewalTimer();
      await renewal;
      if (status === "error") {
        await flush().catch(() => {
        });
        await opts.store.setStatus(opts.turnId, "error", opts.scopeId).catch(() => {
        });
        return;
      }
      await flush();
      await opts.store.setStatus(opts.turnId, "complete", opts.scopeId);
    },
    async detach() {
      detached = true;
      clearRenewalTimer();
      await renewal;
      await flush();
    }
  };
}
async function pumpBufferedTurn(opts) {
  const tap = createBufferedTurnTap(opts);
  try {
    for await (const raw of opts.source) await tap.onEvent(raw);
    await tap.done("complete");
  } catch (err) {
    await tap.done("error");
    throw err;
  }
}
async function* replayTurnEvents(opts) {
  const pollMs = opts.pollMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 12e4;
  let cursor = opts.fromSeq ?? 0;
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    const batch = await opts.store.read(opts.turnId, cursor);
    for (const row of batch) {
      cursor = Math.max(cursor, row.seq);
      yield row;
    }
    const status = await opts.store.getStatus(opts.turnId);
    if (status !== "running") {
      yield* await opts.store.read(opts.turnId, cursor);
      yield { seq: -1, event: JSON.stringify({ type: "turn_status", status: status ?? "unknown" }) };
      return;
    }
    if (Date.now() >= deadline) {
      yield { seq: -1, event: JSON.stringify({ type: "turn_status", status: "timeout" }) };
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
function stampReplaySeq(row) {
  if (row.seq <= 0) return row.event;
  const line = row.event;
  if (line.charCodeAt(0) !== 123) return line;
  const rest = line.slice(1);
  return rest.trimStart().startsWith("}") ? `{"seq":${row.seq}${rest}` : `{"seq":${row.seq},${rest}`;
}
function normalizeTurnCutoff(before) {
  const milliseconds = before instanceof Date ? before.getTime() : before;
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("turn retention cutoff must be a finite Unix-millisecond timestamp or a valid Date");
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("turn retention cutoff is outside the supported Date range");
  }
  return { milliseconds, iso: date.toISOString() };
}
async function runAtomicTurnBatch(db, statements) {
  if (typeof db.batch !== "function") {
    throw new Error("turn retention requires D1 batch() for atomic deletion");
  }
  return db.batch(statements);
}
function changesFromD1Result(result) {
  if (!result || typeof result !== "object") return 0;
  const meta = result.meta;
  if (meta && typeof meta === "object") {
    const changes2 = meta.changes;
    if (typeof changes2 === "number" && Number.isFinite(changes2)) return changes2;
  }
  const changes = result.changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}
var TURN_EVENTS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS turn_events (
  turnId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (turnId, seq)
);
CREATE TABLE IF NOT EXISTS turn_status (
  turnId TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  scopeId TEXT,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turn_status_scope ON turn_status (scopeId, status);
CREATE INDEX IF NOT EXISTS idx_turn_status_retention ON turn_status (status, updatedAt);
`;
var TURN_STATUS_SCOPE_MIGRATION_SQL = `ALTER TABLE turn_status ADD COLUMN scopeId TEXT;`;
var TURN_STATUS_RETENTION_MIGRATION_SQL = "CREATE INDEX IF NOT EXISTS idx_turn_status_retention ON turn_status (status, updatedAt);";
var D1_APPEND_CHUNK = 33;
function createD1TurnEventStore(db, options = {}) {
  const now = options.now ?? Date.now;
  const runningTurnLeaseMs = Math.max(
    1,
    options.runningTurnLeaseMs ?? DEFAULT_RUNNING_TURN_LEASE_MS
  );
  return {
    async append(turnId, events) {
      if (!events.length) return;
      for (let start = 0; start < events.length; start += D1_APPEND_CHUNK) {
        const chunk = events.slice(start, start + D1_APPEND_CHUNK);
        const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
        const values = chunk.flatMap((e) => [turnId, e.seq, e.event]);
        await db.prepare(
          `WITH pending(turnId, seq, event) AS (VALUES ${placeholders})
             INSERT OR IGNORE INTO turn_events (turnId, seq, event)
             SELECT pending.turnId, pending.seq, pending.event
             FROM pending
             WHERE NOT EXISTS (
               SELECT 1 FROM turn_status
               WHERE turn_status.turnId = pending.turnId
                 AND turn_status.status IN ('complete', 'error')
             )`
        ).bind(...values).run();
      }
    },
    async read(turnId, fromSeq) {
      const { results } = await db.prepare("SELECT seq, event FROM turn_events WHERE turnId = ? AND seq > ? ORDER BY seq ASC").bind(turnId, fromSeq).all();
      return results;
    },
    async setStatus(turnId, status, scopeId) {
      await db.prepare(
        "INSERT INTO turn_status (turnId, status, scopeId, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(turnId) DO UPDATE SET status = excluded.status, scopeId = COALESCE(excluded.scopeId, turn_status.scopeId), updatedAt = excluded.updatedAt"
      ).bind(turnId, status, scopeId ?? null, new Date(now()).toISOString()).run();
    },
    async getStatus(turnId) {
      const row = await db.prepare("SELECT status FROM turn_status WHERE turnId = ?").bind(turnId).first();
      return row?.status ?? null;
    },
    async listRunning(scopeId) {
      const { results } = await db.prepare(
        "SELECT turnId FROM turn_status WHERE scopeId = ? AND status = 'running' AND updatedAt >= ? ORDER BY updatedAt DESC, rowid DESC"
      ).bind(scopeId, new Date(now() - runningTurnLeaseMs).toISOString()).all();
      return results.map((r) => r.turnId);
    },
    async deleteTurn(turnId) {
      await runAtomicTurnBatch(db, [
        db.prepare("DELETE FROM turn_events WHERE turnId = ?").bind(turnId),
        db.prepare("DELETE FROM turn_status WHERE turnId = ?").bind(turnId)
      ]);
    },
    async pruneTerminalTurns(before) {
      const cutoff = normalizeTurnCutoff(before);
      const terminalBefore = "status IN ('complete', 'error') AND updatedAt < ?";
      const results = await runAtomicTurnBatch(db, [
        db.prepare(
          `DELETE FROM turn_events WHERE turnId IN (SELECT turnId FROM turn_status WHERE ${terminalBefore})`
        ).bind(cutoff.iso),
        db.prepare(`DELETE FROM turn_status WHERE ${terminalBefore}`).bind(cutoff.iso)
      ]);
      return changesFromD1Result(results[1]);
    }
  };
}
function createMemoryTurnEventStore(options = {}) {
  const events = /* @__PURE__ */ new Map();
  const status = /* @__PURE__ */ new Map();
  const scopes = /* @__PURE__ */ new Map();
  const order = [];
  const updatedAt = /* @__PURE__ */ new Map();
  const now = options.now ?? Date.now;
  const runningTurnLeaseMs = Math.max(
    1,
    options.runningTurnLeaseMs ?? DEFAULT_RUNNING_TURN_LEASE_MS
  );
  return {
    async append(turnId, rows) {
      if (status.get(turnId) === "complete" || status.get(turnId) === "error") return;
      const list = events.get(turnId) ?? [];
      list.push(...rows);
      events.set(turnId, list);
    },
    async read(turnId, fromSeq) {
      return (events.get(turnId) ?? []).filter((e) => e.seq > fromSeq);
    },
    async setStatus(turnId, s, scopeId) {
      status.set(turnId, s);
      if (scopeId) scopes.set(turnId, scopeId);
      if (!order.includes(turnId)) order.push(turnId);
      updatedAt.set(turnId, now());
    },
    async getStatus(turnId) {
      return status.get(turnId) ?? null;
    },
    async listRunning(scopeId) {
      const cutoff = now() - runningTurnLeaseMs;
      return order.filter(
        (turnId) => status.get(turnId) === "running" && scopes.get(turnId) === scopeId && (updatedAt.get(turnId) ?? Number.NEGATIVE_INFINITY) >= cutoff
      ).sort((left, right) => {
        const updatedDelta = (updatedAt.get(right) ?? 0) - (updatedAt.get(left) ?? 0);
        return updatedDelta || order.indexOf(right) - order.indexOf(left);
      });
    },
    async deleteTurn(turnId) {
      events.delete(turnId);
      status.delete(turnId);
      scopes.delete(turnId);
      updatedAt.delete(turnId);
      const index = order.indexOf(turnId);
      if (index >= 0) order.splice(index, 1);
    },
    async pruneTerminalTurns(before) {
      const cutoff = normalizeTurnCutoff(before).milliseconds;
      const removable = order.filter((turnId) => {
        const s = status.get(turnId);
        return (s === "complete" || s === "error") && (updatedAt.get(turnId) ?? Number.POSITIVE_INFINITY) < cutoff;
      });
      for (const turnId of removable) {
        events.delete(turnId);
        status.delete(turnId);
        scopes.delete(turnId);
        updatedAt.delete(turnId);
      }
      if (removable.length) {
        const removed = new Set(removable);
        for (let i = order.length - 1; i >= 0; i--) {
          if (removed.has(order[i])) order.splice(i, 1);
        }
      }
      return removable.length;
    }
  };
}

export {
  DEFAULT_RUNNING_TURN_LEASE_MS,
  DEFAULT_RUNNING_TURN_RENEW_INTERVAL_MS,
  coalesceDeltas,
  coalesceChatStreamEvents,
  createBufferedTurnTap,
  pumpBufferedTurn,
  replayTurnEvents,
  stampReplaySeq,
  TURN_EVENTS_MIGRATION_SQL,
  TURN_STATUS_SCOPE_MIGRATION_SQL,
  TURN_STATUS_RETENTION_MIGRATION_SQL,
  createD1TurnEventStore,
  createMemoryTurnEventStore
};
//# sourceMappingURL=chunk-HXTJXODG.js.map