import {
  DEFAULT_CEILING_TOLERANCE_MS,
  DEFAULT_EXPECTATION_GRACE_MS,
  SPEND_CHECKS,
  assertSpendWindow,
  assessAllExcluded,
  boxLivenessInWindow,
  chargeNanoUsd,
  computeExpectedCeiling,
  decideBoxOwnership,
  formatSpendReport,
  isCharge,
  ownedByBillingKeys,
  parseSandboxGroupKey,
  parseSettlementReference,
  reconcileSpend,
  settlementSandboxId,
  spendReportToJson,
  undeclaredExpectation
} from "../chunk-TRWJ5CRT.js";

// src/spend/store.ts
function foldSpendBoxRecord(record, patch) {
  let lastActivityAt = record.lastActivityAt;
  let stoppedAt = record.stoppedAt;
  let openDetachedRunIds = record.openDetachedRunIds;
  if (patch.observedActivityAt !== void 0) {
    lastActivityAt = Math.max(lastActivityAt, patch.observedActivityAt);
    if (stoppedAt !== null && patch.observedActivityAt > stoppedAt) stoppedAt = null;
  }
  if (patch.openDetachedRunAdd !== void 0 && !openDetachedRunIds.includes(patch.openDetachedRunAdd)) {
    openDetachedRunIds = [...openDetachedRunIds, patch.openDetachedRunAdd];
  }
  if (patch.openDetachedRunRemove !== void 0) {
    openDetachedRunIds = openDetachedRunIds.filter((id) => id !== patch.openDetachedRunRemove);
  }
  if (patch.stoppedAt !== void 0) {
    stoppedAt = patch.stoppedAt >= lastActivityAt ? patch.stoppedAt : stoppedAt;
  }
  return {
    ...record,
    lastActivityAt,
    stoppedAt,
    openDetachedRunIds,
    // Set-once: a deleted sandbox id never comes back, so a second observation
    // is a duplicate delivery, not a second deletion.
    deletedAt: record.deletedAt ?? patch.deletedAt ?? null
  };
}
function createInMemorySpendLedgerStore() {
  const rows = /* @__PURE__ */ new Map();
  return {
    async load(sandboxId) {
      const row = rows.get(sandboxId);
      return row ? structuredClone(row) : null;
    },
    async insert(record) {
      const stored = structuredClone(record);
      rows.set(record.sandboxId, stored);
      return structuredClone(stored);
    },
    async update(sandboxId, patch) {
      const current = rows.get(sandboxId);
      if (!current) return null;
      const next = foldSpendBoxRecord(current, patch);
      rows.set(sandboxId, next);
      return structuredClone(next);
    },
    async listLiveBetween(window) {
      return [...rows.values()].filter(
        (row) => row.createdAt <= window.endAt && (row.deletedAt === null || row.deletedAt >= window.startAt)
      ).map((row) => structuredClone(row));
    },
    records() {
      return [...rows.values()].map((row) => structuredClone(row));
    },
    put(record) {
      rows.set(record.sandboxId, structuredClone(record));
    }
  };
}
function createSpendLedger(options) {
  const { store } = options;
  const clock = options.now ?? Date.now;
  return {
    async observeSandbox(input) {
      const at = input.at ?? clock();
      const existing = await store.load(input.sandboxId);
      if (existing) {
        const updated = await store.update(input.sandboxId, { observedActivityAt: at });
        return updated ?? existing;
      }
      return await store.insert(
        {
          sandboxId: input.sandboxId,
          workspaceId: input.workspaceId,
          createdAt: at,
          idleTimeoutSeconds: input.idleTimeoutSeconds,
          maxLifetimeSeconds: input.maxLifetimeSeconds ?? null,
          lastActivityAt: at,
          openDetachedRunIds: [],
          stoppedAt: null,
          deletedAt: null
        },
        options.extras
      );
    },
    async recordActivity(sandboxId, at) {
      return await store.update(sandboxId, { observedActivityAt: at ?? clock() });
    },
    async recordDetachedRunStarted(sandboxId, runId, at) {
      return await store.update(sandboxId, {
        observedActivityAt: at ?? clock(),
        openDetachedRunAdd: runId
      });
    },
    async recordDetachedRunEnded(sandboxId, runId, at) {
      return await store.update(sandboxId, {
        observedActivityAt: at ?? clock(),
        openDetachedRunRemove: runId
      });
    },
    async recordStopped(sandboxId, at) {
      return await store.update(sandboxId, { stoppedAt: at ?? clock() });
    },
    async recordDeleted(sandboxId, at) {
      return await store.update(sandboxId, { deletedAt: at ?? clock() });
    }
  };
}

// src/spend/budget.ts
var ComputeBudgetExceededError = class extends Error {
  workspaceId;
  limitNanoUsd;
  settledNanoUsd;
  overageNanoUsd;
  constructor(refusal) {
    super(
      `Compute budget exceeded for workspace ${refusal.workspaceId}: $${(refusal.settledNanoUsd / 1e9).toFixed(2)} settled against a cap of $${(refusal.limitNanoUsd / 1e9).toFixed(2)} (over by $${(refusal.overageNanoUsd / 1e9).toFixed(2)}). No sandbox was provisioned. Raise the cap or reconcile the spend before retrying.`
    );
    this.name = "ComputeBudgetExceededError";
    this.workspaceId = refusal.workspaceId;
    this.limitNanoUsd = refusal.limitNanoUsd;
    this.settledNanoUsd = refusal.settledNanoUsd;
    this.overageNanoUsd = refusal.overageNanoUsd;
  }
};
async function assertComputeBudget(budget, workspaceId) {
  if (!budget) return;
  const settledNanoUsd = await budget.settledNanoUsd(workspaceId);
  if (settledNanoUsd < budget.limitNanoUsd) return;
  const refusal = {
    workspaceId,
    limitNanoUsd: budget.limitNanoUsd,
    settledNanoUsd,
    overageNanoUsd: settledNanoUsd - budget.limitNanoUsd,
    at: (budget.now ?? Date.now)()
  };
  budget.onRefusal?.(refusal);
  throw new ComputeBudgetExceededError(refusal);
}
function createSandboxSpendHooks(options) {
  const { ledger, budget, onError } = options;
  return {
    async beforeProvision(input) {
      await assertComputeBudget(budget, input.workspaceId);
    },
    async onProvisioned(observation) {
      if (!ledger) return;
      try {
        await ledger.observeSandbox({
          sandboxId: observation.sandboxId,
          workspaceId: observation.workspaceId,
          idleTimeoutSeconds: observation.idleTimeoutSeconds,
          maxLifetimeSeconds: observation.maxLifetimeSeconds ?? null,
          at: observation.at
        });
      } catch (err) {
        onError?.(err);
      }
    },
    onActivity(input) {
      if (!ledger) return;
      void ledger.recordActivity(input.sandboxId, input.at).catch((err) => onError?.(err));
    }
  };
}
export {
  ComputeBudgetExceededError,
  DEFAULT_CEILING_TOLERANCE_MS,
  DEFAULT_EXPECTATION_GRACE_MS,
  SPEND_CHECKS,
  assertComputeBudget,
  assertSpendWindow,
  assessAllExcluded,
  boxLivenessInWindow,
  chargeNanoUsd,
  computeExpectedCeiling,
  createInMemorySpendLedgerStore,
  createSandboxSpendHooks,
  createSpendLedger,
  decideBoxOwnership,
  foldSpendBoxRecord,
  formatSpendReport,
  isCharge,
  ownedByBillingKeys,
  parseSandboxGroupKey,
  parseSettlementReference,
  reconcileSpend,
  settlementSandboxId,
  spendReportToJson,
  undeclaredExpectation
};
//# sourceMappingURL=index.js.map