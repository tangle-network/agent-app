// src/chat-routes/stale-turn-lock.ts
var DEFAULT_STALE_TURN_LOCK_GRACE_MS = 5 * 60 * 1e3;
var DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS = 60 * 1e3;
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
async function reconcileStaleTurnLock(options) {
  let sandbox;
  try {
    sandbox = await options.probeSandbox();
  } catch (err) {
    return forceReleaseUnreachable(options, {
      unreachableReason: "SANDBOX_PROBE_FAILED",
      unreachableDetail: messageOf(err)
    });
  }
  if (sandbox.status !== "running") {
    return forceReleaseUnreachable(options, {
      unreachableReason: sandbox.status === "absent" ? "SANDBOX_ABSENT" : "SANDBOX_NOT_RUNNING",
      ...sandbox.status === "not-running" && sandbox.state !== void 0 ? { sandboxState: sandbox.state } : {}
    });
  }
  const observedAt = (options.now ?? Date.now)();
  let session;
  try {
    session = await options.probeSession();
  } catch (err) {
    return forceReleaseUnreachable(options, {
      unreachableReason: "SESSION_PROBE_FAILED",
      unreachableDetail: messageOf(err)
    });
  }
  if (!session.reachable) {
    return forceReleaseUnreachable(options, {
      unreachableReason: "SESSION_UNREACHABLE",
      ...session.reason !== void 0 ? { sessionProbeError: session.reason } : {}
    });
  }
  const diagnostics = {
    sandboxReachable: true,
    sessionTerminal: session.terminal,
    ...session.diagnostics ?? {}
  };
  if (!session.terminal) return { released: false, diagnostics };
  const terminalGraceMs = options.terminalGraceMs ?? DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS;
  const lockAgeMs = observedAt - options.lockStartedAt;
  if (lockAgeMs < terminalGraceMs) {
    const log = options.log ?? ((message, meta) => console.warn(message, meta));
    const withheld = {
      ...diagnostics,
      lockAgeMs,
      terminalReleaseGraceMs: terminalGraceMs,
      terminalReleaseWithheld: "LOCK_WITHIN_TERMINAL_GRACE_PERIOD"
    };
    log("[chat-routes] stale turn lock held: terminal verdict but lock is younger than the registration window", {
      ...options.context ?? {},
      ...withheld
    });
    return { released: false, diagnostics: withheld };
  }
  const released = await options.release({ observedAt });
  return {
    released,
    diagnostics: { ...diagnostics, lockAgeMs, terminalReleaseGraceMs: terminalGraceMs, released, observedAt }
  };
}
async function forceReleaseUnreachable(options, reason) {
  const log = options.log ?? ((message, meta) => console.warn(message, meta));
  const graceMs = options.graceMs ?? DEFAULT_STALE_TURN_LOCK_GRACE_MS;
  const at = (options.now ?? Date.now)();
  const lockAgeMs = at - options.lockStartedAt;
  const diagnostics = {
    ...reason,
    sandboxReachable: false,
    lockAgeMs,
    forceReleaseGraceMs: graceMs
  };
  if (lockAgeMs < graceMs) {
    log("[chat-routes] stale turn lock held: sandbox unreachable but lock is inside the grace period", {
      ...options.context ?? {},
      ...diagnostics
    });
    return { released: false, diagnostics: { ...diagnostics, forceReleaseWithheld: "LOCK_WITHIN_GRACE_PERIOD" } };
  }
  const released = await options.release({ observedAt: at });
  log("[chat-routes] force-released stale turn lock: sandbox unreachable, no turn can be executing", {
    ...options.context ?? {},
    ...diagnostics,
    released
  });
  return { released, diagnostics: { ...diagnostics, forceReleased: released } };
}

export {
  DEFAULT_STALE_TURN_LOCK_GRACE_MS,
  DEFAULT_TERMINAL_TURN_LOCK_GRACE_MS,
  reconcileStaleTurnLock
};
//# sourceMappingURL=chunk-CCVWR33L.js.map