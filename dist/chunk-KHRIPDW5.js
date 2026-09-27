// src/runtime/protected-model.ts
import {
  createProtectedAgentCandidateModelPort
} from "@tangle-network/agent-runtime/candidate-execution";
var GATEWAY_ORIGIN = "https://candidate-router.tangle.tools";
var CONTROL_ORIGIN = "https://router.tangle.tools/v1/candidate-model-grants";
var ACTIVATION_NAMES = [
  "MODEL_GATEWAY_TOKEN",
  "MODEL_GATEWAY_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
];
var ProtectedModelSettlementError = class extends Error {
  constructor(settlement, cause) {
    super("Protected model settled, but its audit record could not be saved", { cause });
    this.settlement = settlement;
    this.name = "ProtectedModelSettlementError";
  }
  settlement;
};
function createRouterProtectedModelPort(options) {
  if (!options.apiKey || !Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0 || !Number.isSafeInteger(Math.round(options.maxCostUsd * 1e9))) {
    throw new Error("Protected Router transport requires a parent key and finite positive cap");
  }
  const receipts = /* @__PURE__ */ new Map();
  async function request(operation, body, settling = false) {
    const timeout = AbortSignal.timeout(settling ? 3e4 : 15e3);
    const signal = !settling && options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response;
    try {
      response = await fetch(`${CONTROL_ORIGIN}/${operation}`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "X-Tangle-Client": options.clientName ?? "agent-app"
        },
        body: JSON.stringify(body)
      });
    } catch {
      if (!settling && options.signal?.aborted) throw options.signal.reason;
      throw new Error(`Protected model ${operation} transport failed`);
    }
    if (!response.ok) {
      const body2 = await response.json().catch(() => null);
      const code = body2?.error?.code;
      const safeCode = typeof code === "string" && /^candidate_[a-z_]{1,80}$/.test(code) ? code : "request_failed";
      throw new Error(`Protected model ${operation}: ${safeCode} (HTTP ${response.status})`);
    }
    return await response.json();
  }
  const client = {
    reserve: (value) => request("reserve", value),
    activate: async (value) => {
      const activation = await request("activate", value);
      const env = activation?.env;
      const token = env?.MODEL_GATEWAY_TOKEN;
      if (typeof token !== "string" || !/^sk-tgr-[A-Za-z0-9_-]{32,}$/.test(token) || env.MODEL_GATEWAY_BASE_URL !== `${GATEWAY_ORIGIN}/v1` || env.OPENAI_BASE_URL !== `${GATEWAY_ORIGIN}/v1` || env.ANTHROPIC_BASE_URL !== GATEWAY_ORIGIN || [env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].some((value2) => value2 !== token)) {
        throw new Error("Protected model activation changed the gateway or credential binding");
      }
      return activation;
    },
    settle: async (value) => {
      const wire = await request("settle", value, true);
      const projected = runtimeSettlement(wire, options.maxCostUsd);
      receipts.set(value.preparationId, wire);
      return projected;
    }
  };
  const port = createProtectedAgentCandidateModelPort({
    client,
    resolveModel: (value) => request("resolve", value),
    gatewayDomain: "candidate-router.tangle.tools",
    activationEnvNames: ACTIVATION_NAMES
  });
  return {
    ...port,
    settleGrant: async (value) => {
      const settlement = await port.settleGrant(value);
      const receipt = receipts.get(value.preparationId);
      if (receipt) {
        try {
          await options.onSettlement?.(structuredClone(receipt));
        } catch (error) {
          throw new ProtectedModelSettlementError(settlement, error);
        } finally {
          receipts.delete(value.preparationId);
        }
      }
      return settlement;
    }
  };
}
function runtimeSettlement(wire, capUsd) {
  const billing = wire?.billing;
  if (!Array.isArray(wire?.calls) || !billing || billing.status !== "settled" || typeof billing.authorizationId !== "string" || billing.authorizationId.length === 0 || billing.reservedCostUsdNanos !== Math.round(capUsd * 1e9) || !Number.isSafeInteger(billing.settledCostUsdNanos) || billing.settledCostUsdNanos < 0 || billing.settledCostUsdNanos > billing.reservedCostUsdNanos || billing.settledCostUsdNanos > 0 && (typeof billing.transactionId !== "string" || billing.transactionId.length === 0)) {
    throw new Error("Protected model billing receipt is incomplete or exceeds its reservation");
  }
  const billingFields = /* @__PURE__ */ new Set(["status", "authorizationId", "transactionId", "reservedCostUsdNanos", "settledCostUsdNanos"]);
  if (Object.keys(billing).some((key) => !billingFields.has(key))) {
    throw new Error("Protected model billing receipt contains an unknown field");
  }
  let cost = 0;
  const calls = wire.calls.map(({ cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens, ...call }) => {
    for (const count of [cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens]) {
      if (!Number.isSafeInteger(count) || count < 0 || count > call.accountedInputTokens) {
        throw new Error("Protected model cache-write receipt is invalid");
      }
    }
    if (cacheWrite5mTokens + cacheWrite1hTokens > cacheWriteTokens) {
      throw new Error("Protected model cache-write receipt does not reconcile");
    }
    if (!Number.isSafeInteger(call.costUsdNanos) || call.costUsdNanos < 0) {
      throw new Error("Protected model call cost is invalid");
    }
    cost += call.costUsdNanos;
    if (!Number.isSafeInteger(cost)) throw new Error("Protected model cumulative cost is invalid");
    if ("costProvenance" in call) throw new Error("Router call receipt contains an unknown field");
    return { ...call, costProvenance: "observed" };
  });
  if (cost !== billing.settledCostUsdNanos) throw new Error("Protected model billing does not match its call ledger");
  const { billing: _billing, ...settlement } = wire;
  return { ...settlement, calls };
}

export {
  ProtectedModelSettlementError,
  createRouterProtectedModelPort
};
//# sourceMappingURL=chunk-KHRIPDW5.js.map