// src/billing/crypto-probe.ts
async function assertWorkspaceKeyCryptoUsable(crypto) {
  const probe = "agent-app:key-manager:crypto-probe";
  let roundTripped;
  try {
    roundTripped = await crypto.decrypt(await crypto.encrypt(probe));
  } catch (error) {
    throw new Error(
      "Key encryption is misconfigured: the crypto seam threw before minting. Validate FIELD_ENCRYPTION_KEY (64-char hex) at startup. No platform key was minted.",
      { cause: error }
    );
  }
  if (roundTripped !== probe) {
    throw new Error(
      "Key encryption is misconfigured: encrypt/decrypt round-trip did not preserve the plaintext. No platform key was minted."
    );
  }
}

// src/billing/identity-bound.ts
var DEFAULT_KEY_LIFETIME_MS = 55 * 6e4;
var DEFAULT_LEASE_MS = 6e4;
var DEFAULT_LEASE_WAIT_MS = 15e3;
var DEFAULT_LEASE_POLL_MS = 50;
var DEFAULT_LEASE_RENEW_INTERVAL_MS = Math.floor(DEFAULT_LEASE_MS / 3);
var DEFAULT_REVOCATION_RETRY_BASE_MS = 2e3;
var DEFAULT_REVOCATION_RETRY_MAX_MS = 6e4;
var PENDING_REVOCATION_BATCH_SIZE = 20;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function operationId() {
  return globalThis.crypto.randomUUID();
}
function requirePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return value;
}
function requireNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}
function normalizeIdentity(identity) {
  const workspaceId = identity.workspaceId.trim();
  const ownerUserId = identity.ownerUserId.trim();
  const platformUserId = identity.platformUserId.trim();
  const sourceKeyFingerprint = identity.sourceKeyFingerprint.trim();
  const sourceKeyId2 = identity.sourceKeyId?.trim() || null;
  if (!workspaceId || !ownerUserId || !platformUserId || !sourceKeyFingerprint) {
    throw new Error("workspace child key identity is incomplete");
  }
  return { workspaceId, ownerUserId, platformUserId, sourceKeyId: sourceKeyId2, sourceKeyFingerprint };
}
function scopeFor(identity, product) {
  return { workspaceId: identity.workspaceId, ownerUserId: identity.ownerUserId, product };
}
function scopeKey(scope) {
  return JSON.stringify([scope.product, scope.workspaceId, scope.ownerUserId]);
}
function safeNamePart(value) {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  return normalized.slice(0, 80) || "unknown";
}
function defaultKeyName(identity, product, operationId2) {
  return `agent-app:${safeNamePart(product)}:${safeNamePart(identity.workspaceId)}:${safeNamePart(identity.platformUserId)}:${operationId2}`;
}
function sourceKeyId(identity) {
  return identity.sourceKeyId?.trim() || null;
}
function sameIdentity(row, identity, product) {
  return row.workspaceId === identity.workspaceId && row.ownerUserId === identity.ownerUserId && row.product === product && row.platformUserId === identity.platformUserId && row.sourceKeyId === sourceKeyId(identity) && row.sourceKeyFingerprint === identity.sourceKeyFingerprint;
}
function sameRowIdentity(a, b) {
  return a.workspaceId === b.workspaceId && a.ownerUserId === b.ownerUserId && a.product === b.product && a.platformUserId === b.platformUserId && a.sourceKeyId === b.sourceKeyId && a.sourceKeyFingerprint === b.sourceKeyFingerprint;
}
function errorMessage(error, fallback) {
  return (error instanceof Error ? error.message : fallback).replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]").replace(/((?:authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*)(?!Bearer\b)[^\s,;]+/gi, "$1[redacted]").slice(0, 240);
}
function isProvisioningId(value) {
  return value.startsWith("provisioning:");
}
async function markProvisioningRemote(store, input) {
  if (store.conditionalWrites) return store.conditionalWrites.markProvisioningRemote(input);
  await store.markProvisioningRemote(input);
  return true;
}
async function markActive(store, input) {
  if (store.conditionalWrites) return store.conditionalWrites.markActive(input);
  await store.markActive(input);
  return true;
}
function usageFromRemote(row, remote, now) {
  const budgetUsd = remote.budgetUsd ?? row.budgetUsd;
  const budgetSpent = remote.budgetSpent ?? 0;
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("workspace child key budget is malformed");
  if (!Number.isFinite(budgetSpent) || budgetSpent < 0) throw new Error("workspace child key usage is malformed");
  const expiresAt = remote.expiresAt ?? row.expiresAt.toISOString();
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) throw new Error("workspace child key expiry is malformed");
  const budgetRemaining = Math.max(0, budgetUsd - budgetSpent);
  return {
    keyId: row.keyId,
    budgetUsd,
    budgetSpent,
    budgetRemaining,
    expiresAt,
    exhausted: budgetRemaining <= 0 || expiryMs <= now.getTime()
  };
}
function defaultRemoteMissing(error) {
  const value = error;
  return value?.status === 404 || value?.code === "not_found";
}
function createIdentityBoundWorkspaceKeyManager(options) {
  const product = options.product.trim();
  if (!product) throw new Error("workspace child key product is required");
  const defaultBudgetUsd = requirePositive(options.defaultBudgetUsd, "defaultBudgetUsd");
  const keyLifetimeMs = requirePositive(options.keyLifetimeMs ?? DEFAULT_KEY_LIFETIME_MS, "keyLifetimeMs");
  const leaseMs = requirePositive(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
  const leaseWaitMs = requireNonNegative(options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS, "leaseWaitMs");
  const leasePollMs = requirePositive(options.leasePollMs ?? DEFAULT_LEASE_POLL_MS, "leasePollMs");
  const leaseRenewIntervalMs = requirePositive(
    options.leaseRenewIntervalMs ?? Math.min(DEFAULT_LEASE_RENEW_INTERVAL_MS, Math.floor(leaseMs / 3)),
    "leaseRenewIntervalMs"
  );
  if (leaseRenewIntervalMs >= leaseMs) throw new Error("leaseRenewIntervalMs must be shorter than leaseMs");
  const revocationRetryBaseMs = requirePositive(
    options.revocationRetryBaseMs ?? DEFAULT_REVOCATION_RETRY_BASE_MS,
    "revocationRetryBaseMs"
  );
  const revocationRetryMaxMs = requirePositive(
    options.revocationRetryMaxMs ?? DEFAULT_REVOCATION_RETRY_MAX_MS,
    "revocationRetryMaxMs"
  );
  if (revocationRetryMaxMs < revocationRetryBaseMs) throw new Error("revocationRetryMaxMs must cover the base delay");
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const isRemoteMissing = options.isRemoteMissing ?? defaultRemoteMissing;
  const recoveryProvisioner = options.recoveryProvisioner ?? options.provisioner;
  const localLocks = /* @__PURE__ */ new Map();
  async function withLocalLock(scope, work) {
    const previous = localLocks.get(scope) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    localLocks.set(scope, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (localLocks.get(scope) === current) localLocks.delete(scope);
    }
  }
  async function withDurableLease(scope, work, onLeaseLost) {
    const leaseOperationId = operationId();
    const startedAt = Date.now();
    let acquired = false;
    while (!acquired && Date.now() - startedAt <= leaseWaitMs) {
      acquired = await options.store.acquireLease(scope, leaseOperationId, now(), leaseMs);
      if (!acquired) await sleep(leasePollMs);
    }
    if (!acquired) throw new Error("workspace child-key issuance is busy; retry the request");
    let stopped = false;
    let leaseLost = null;
    let leaseTimer;
    let renewalPromise;
    const scheduleRenewal = () => {
      if (stopped || leaseLost) return;
      leaseTimer = setTimeout(() => {
        leaseTimer = void 0;
        const renewal = (async () => {
          try {
            if (!await options.store.renewLease(scope, leaseOperationId, now(), leaseMs)) {
              leaseLost = new Error("workspace child-key lease was lost during reconciliation");
              return;
            }
            scheduleRenewal();
          } catch (error) {
            leaseLost = error instanceof Error ? error : new Error("workspace child-key lease renewal failed");
          }
        })();
        renewalPromise = renewal;
        void renewal.finally(() => {
          if (renewalPromise === renewal) renewalPromise = void 0;
        }).catch(() => void 0);
      }, leaseRenewIntervalMs);
    };
    scheduleRenewal();
    let workError;
    let leaseLossCleanupError;
    try {
      const result = await work();
      if (leaseLost) throw leaseLost;
      return result;
    } catch (error) {
      workError = error;
      throw error;
    } finally {
      stopped = true;
      if (leaseTimer) clearTimeout(leaseTimer);
      if (renewalPromise) await renewalPromise;
      if (leaseLost && onLeaseLost) {
        try {
          await onLeaseLost();
        } catch (error) {
          leaseLossCleanupError = error;
        }
      }
      try {
        await options.store.releaseLease(scope, leaseOperationId);
      } catch (error) {
        if (workError === void 0) throw error;
      }
      if (workError === void 0 && leaseLossCleanupError) {
        throw new Error("workspace child-key lease was lost and cleanup failed", { cause: leaseLossCleanupError });
      }
      if (workError === void 0 && leaseLost) throw leaseLost;
    }
  }
  function retryDelay(attempts) {
    return Math.min(revocationRetryMaxMs, revocationRetryBaseMs * 2 ** Math.min(Math.max(attempts - 1, 0), 5));
  }
  async function markPending(id, error, incrementAttempts) {
    const delay = incrementAttempts ? retryDelay(1) : 0;
    await options.store.markRevocationPending({
      id,
      error: errorMessage(error, "remote key cleanup failed"),
      nextAttemptAt: new Date(now().getTime() + delay),
      incrementAttempts
    });
  }
  async function revokePending(row, identity) {
    if (!row.keyId || isProvisioningId(row.keyId)) return cleanupProvisioning(row, identity);
    const active = await options.store.getActive({
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
      product: row.product
    });
    if (active && active.id !== row.id && active.keyId === row.keyId) {
      await options.store.markRevoked(row.id, now());
      return true;
    }
    try {
      await recoveryProvisioner.revokeKey(row.keyId);
      await options.store.markRevoked(row.id, now());
      return true;
    } catch (error) {
      if (isRemoteMissing(error)) {
        await options.store.markRevoked(row.id, now());
        return true;
      }
      await options.store.markRevocationPending({
        id: row.id,
        error: errorMessage(error, "remote key revocation failed"),
        nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
        incrementAttempts: true
      });
      return false;
    }
  }
  async function provisioningCandidates(row) {
    if (row.keyId && !isProvisioningId(row.keyId)) {
      return { name: row.name?.trim() ?? "", candidates: [{ id: row.keyId }] };
    }
    const name = row.name?.trim() || options.legacyNameForRecord?.(row)?.trim();
    if (!name) return null;
    return {
      name,
      candidates: await recoveryProvisioner.findCreatedKeys({
        name,
        product: row.product,
        sourceKeyId: row.sourceKeyId
      })
    };
  }
  async function probeProvisioning(row, identity, name) {
    const idempotencyKey = row.idempotencyKey?.trim();
    if (!identity || !sameIdentity(row, identity, product) || !options.provisioner.supportsIdempotentCreate || !idempotencyKey) return [];
    try {
      const created = await options.provisioner.createKey({
        name,
        product: row.product,
        budgetUsd: row.budgetUsd,
        expiresAt: row.expiresAt.toISOString(),
        idempotencyKey
      });
      const remoteId = created.id?.trim();
      if (remoteId) return [{ id: remoteId }];
    } catch (error) {
      await options.store.markRevocationPending({
        id: row.id,
        error: errorMessage(error, "remote provisioning recovery failed"),
        nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
        incrementAttempts: true
      });
      return null;
    }
    return (await provisioningCandidates({ ...row, name, keyId: `provisioning:${idempotencyKey}` }))?.candidates ?? [];
  }
  async function cleanupProvisioning(row, identity) {
    const resolved = await provisioningCandidates(row);
    if (!resolved) {
      await options.store.markRevocationPending({
        id: row.id,
        error: "provisioning row has no recoverable remote name; migrate the row or configure legacyNameForRecord",
        nextAttemptAt: now(),
        incrementAttempts: false
      });
      return false;
    }
    let { name, candidates } = resolved;
    if (candidates.length === 0) {
      const probed = await probeProvisioning(row, identity, name);
      if (probed === null) return false;
      candidates = probed;
    }
    const scope = { workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, product: row.product };
    const active = await options.store.getActive(scope);
    const activeMatches = active && (identity ? sameIdentity(active, identity, product) : sameRowIdentity(active, row));
    const activeKeyId = activeMatches ? active.keyId : null;
    const toRevoke = candidates.map((candidate) => candidate.id.trim()).filter((candidateId) => candidateId && candidateId !== activeKeyId);
    for (const keyId of toRevoke) {
      try {
        await recoveryProvisioner.revokeKey(keyId);
      } catch (error) {
        if (isRemoteMissing(error)) continue;
        await options.store.markRevocationPending({
          id: row.id,
          error: errorMessage(error, "remote provisioning cleanup failed"),
          nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
          incrementAttempts: true
        });
        return false;
      }
    }
    if (candidates.length > 0) {
      await options.store.markRevoked(row.id, now());
    } else {
      await options.store.markRevocationPending({
        id: row.id,
        error: "no remote child matched the durable provisioning record; retrying crash recovery",
        nextAttemptAt: new Date(now().getTime() + retryDelay(row.revocationAttempts + 1)),
        incrementAttempts: true
      });
      return false;
    }
    return true;
  }
  async function reconcileProvisioning(identity) {
    const scope = scopeFor(identity, product);
    const rows = await options.store.listProvisioning(scope);
    for (const row of rows) {
      if (!await cleanupProvisioning(row, identity)) {
        throw new Error("a previous workspace child-key cleanup is pending; issuance is blocked until it completes");
      }
    }
  }
  async function retryPendingRevocationsUnlocked(scopeFilter, activeIdentity) {
    const rows = await options.store.listPendingRevocations({
      product,
      workspaceId: scopeFilter?.workspaceId,
      ownerUserId: scopeFilter?.ownerUserId,
      now: now(),
      limit: PENDING_REVOCATION_BATCH_SIZE
    });
    let completed = 0;
    let pending = 0;
    for (const row of rows) {
      if (row.product !== product) continue;
      if (scopeFilter && (row.workspaceId !== scopeFilter.workspaceId || row.ownerUserId !== scopeFilter.ownerUserId)) continue;
      if (await revokePending(row, activeIdentity)) completed += 1;
      else pending += 1;
    }
    return { completed, pending };
  }
  async function assertNoPendingRevocations(identity) {
    const rows = await options.store.listPendingRevocations({
      product,
      workspaceId: identity.workspaceId,
      ownerUserId: identity.ownerUserId,
      now: now(),
      limit: PENDING_REVOCATION_BATCH_SIZE,
      includeFuture: true
    });
    if (rows.some((row) => row.product === product && row.workspaceId === identity.workspaceId && row.ownerUserId === identity.ownerUserId)) {
      throw new Error("a previous workspace child-key cleanup is pending; issuance is blocked until it completes");
    }
  }
  async function retryPendingRevocations(scopeInput, identityInput) {
    const identity = identityInput ? normalizeIdentity(identityInput) : void 0;
    if (identity && scopeInput && (identity.workspaceId !== scopeInput.workspaceId || identity.ownerUserId !== scopeInput.ownerUserId)) {
      throw new Error("workspace child key retry identity does not match its scope");
    }
    if (scopeInput) {
      const workspaceId = scopeInput.workspaceId.trim();
      const ownerUserId = scopeInput.ownerUserId.trim();
      if (!workspaceId || !ownerUserId) throw new Error("workspace child key retry scope is incomplete");
      const scope = scopeKey({ workspaceId, ownerUserId, product });
      return withLocalLock(scope, () => withDurableLease(scope, async () => (await retryPendingRevocationsUnlocked({ workspaceId, ownerUserId }, identity)).completed));
    }
    if (identity) {
      const scope = scopeKey(scopeFor(identity, product));
      return withLocalLock(scope, () => withDurableLease(scope, async () => (await retryPendingRevocationsUnlocked({ workspaceId: identity.workspaceId, ownerUserId: identity.ownerUserId }, identity)).completed));
    }
    const rows = await options.store.listPendingRevocations({ product, now: now(), limit: PENDING_REVOCATION_BATCH_SIZE });
    let completed = 0;
    const scopes = /* @__PURE__ */ new Set();
    for (const row of rows) {
      if (row.product !== product) continue;
      const scope = scopeKey({ workspaceId: row.workspaceId, ownerUserId: row.ownerUserId, product });
      if (scopes.has(scope)) continue;
      scopes.add(scope);
      completed += await withLocalLock(scope, () => withDurableLease(scope, async () => (await retryPendingRevocationsUnlocked({
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId
      })).completed));
    }
    return completed;
  }
  async function readActive(identity) {
    const row = await options.store.getActive(scopeFor(identity, product));
    if (!row) return null;
    if (!sameIdentity(row, identity, product)) {
      await options.store.markRevocationPending({
        id: row.id,
        error: "active child key identity does not match the authenticated owner and source",
        nextAttemptAt: now(),
        incrementAttempts: false
      });
      return null;
    }
    let remote;
    try {
      remote = await recoveryProvisioner.getKey(row.keyId);
    } catch (error) {
      if (isRemoteMissing(error)) {
        await options.store.markRevoked(row.id, now());
        return null;
      }
      throw error;
    }
    const usage = usageFromRemote(row, remote, now());
    if (usage.exhausted) {
      await options.store.markRevocationPending({
        id: row.id,
        error: "active child key is expired or exhausted",
        nextAttemptAt: now(),
        incrementAttempts: false
      });
      return null;
    }
    return { row, usage };
  }
  async function mint(identity, budgetUsd, onRemoteKey) {
    await assertWorkspaceKeyCryptoUsable(options.crypto);
    const mintOperationId = operationId();
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + keyLifetimeMs);
    const name = (options.nameForIdentity?.(identity, mintOperationId) ?? defaultKeyName(identity, product, mintOperationId)).trim();
    if (!name) throw new Error("workspace child key remote name is required");
    const rowId = operationId();
    const idempotencyKey = `workspace-key:${rowId}`;
    const provisioningRow = {
      id: rowId,
      workspaceId: identity.workspaceId,
      ownerUserId: identity.ownerUserId,
      product,
      platformUserId: identity.platformUserId,
      sourceKeyId: sourceKeyId(identity),
      sourceKeyFingerprint: identity.sourceKeyFingerprint,
      name,
      idempotencyKey,
      keyId: `provisioning:${mintOperationId}`,
      keyEncrypted: "",
      budgetUsd,
      expiresAt,
      status: "provisioning",
      revocationAttempts: 0,
      nextRevocationAt: null,
      lastRevocationError: null,
      createdAt
    };
    await options.store.insertProvisioning(provisioningRow);
    let created;
    try {
      created = await options.provisioner.createKey({
        name,
        product,
        budgetUsd,
        expiresAt: expiresAt.toISOString(),
        idempotencyKey
      });
    } catch (error) {
      try {
        await markPending(rowId, error, false);
      } catch {
      }
      try {
        await cleanupProvisioning({ ...provisioningRow, status: "revocation_pending" }, identity);
      } catch (cleanupError) {
        throw new Error("remote create failed and its cleanup could not be completed", { cause: cleanupError });
      }
      throw error;
    }
    const remoteId = created.id?.trim() ?? "";
    const secret = created.key?.trim() ?? "";
    if (!remoteId || !secret) {
      if (remoteId) {
        try {
          await markProvisioningRemote(options.store, { id: rowId, keyId: remoteId });
        } catch {
        }
      }
      try {
        await markPending(rowId, new Error("remote create returned no usable child key"), false);
      } catch {
      }
      const pendingRow = { ...provisioningRow, keyId: remoteId || provisioningRow.keyId, status: "revocation_pending" };
      await revokePending(pendingRow, identity);
      throw new Error("remote create returned no usable child key");
    }
    let cleanupRow = provisioningRow;
    onRemoteKey?.(cleanupRow, remoteId);
    async function retainRetiredCreatorCleanup() {
      const retainedRow = { ...provisioningRow, id: operationId(), keyId: remoteId };
      try {
        await options.store.insertProvisioning(retainedRow);
      } catch (cause) {
        throw new Error("returned child cleanup record could not be persisted", { cause });
      }
      cleanupRow = retainedRow;
      onRemoteKey?.(cleanupRow, remoteId);
    }
    try {
      const recorded = await markProvisioningRemote(options.store, { id: rowId, keyId: remoteId });
      if (!recorded) {
        await retainRetiredCreatorCleanup();
        throw new Error("workspace child-key provisioning row was retired before the remote id was recorded");
      }
      const keyEncrypted = await options.crypto.encrypt(secret);
      const remoteExpiresAt = created.expiresAt?.trim();
      const activeExpiresAt = remoteExpiresAt ? new Date(remoteExpiresAt) : expiresAt;
      if (!Number.isFinite(activeExpiresAt.getTime())) throw new Error("remote child key expiry is malformed");
      const activeBudgetUsd = created.budgetUsd ?? budgetUsd;
      if (!Number.isFinite(activeBudgetUsd) || activeBudgetUsd < 0) throw new Error("remote child key budget is malformed");
      const activated = await markActive(options.store, {
        id: rowId,
        keyId: remoteId,
        keyEncrypted,
        expiresAt: activeExpiresAt,
        budgetUsd: activeBudgetUsd
      });
      if (!activated) {
        await retainRetiredCreatorCleanup();
        throw new Error("workspace child-key provisioning row was retired before activation");
      }
    } catch (error) {
      try {
        await markPending(cleanupRow.id, error, false);
      } catch {
      }
      await revokePending({ ...cleanupRow, keyId: remoteId, status: "revocation_pending" }, identity);
      throw error;
    }
    const row = await options.store.getActive(scopeFor(identity, product));
    if (!row || row.keyId !== remoteId || !sameIdentity(row, identity, product)) {
      const error = new Error("workspace child key was not persisted as active");
      try {
        await options.store.markRevocationPending({
          id: rowId,
          error: error.message,
          nextAttemptAt: now(),
          incrementAttempts: false
        });
      } catch {
      }
      await revokePending({ ...provisioningRow, keyId: remoteId, status: "revocation_pending" }, identity);
      throw error;
    }
    const usage = usageFromRemote(row, {
      budgetUsd: created.budgetUsd,
      budgetSpent: 0,
      expiresAt: created.expiresAt ?? expiresAt.toISOString()
    }, now());
    return { key: secret, usage, refreshed: true };
  }
  async function ensureKey(identityInput, keyOptions) {
    const identity = normalizeIdentity(identityInput);
    const budgetUsd = keyOptions?.budgetUsd ?? defaultBudgetUsd;
    requirePositive(budgetUsd, "budgetUsd");
    const scope = scopeKey(scopeFor(identity, product));
    let mintedRemote = null;
    return withLocalLock(scope, () => withDurableLease(scope, async () => {
      const initialCleanup = await retryPendingRevocationsUnlocked(identity, identity);
      if (initialCleanup.pending > 0) throw new Error("a previous workspace child-key cleanup is pending; issuance is blocked until it completes");
      await reconcileProvisioning(identity);
      const active = await readActive(identity);
      if (active) {
        const key = await options.crypto.decrypt(active.row.keyEncrypted);
        if (!key.trim()) throw new Error("workspace child key secret is empty");
        return { key, usage: active.usage, refreshed: false };
      }
      const finalCleanup = await retryPendingRevocationsUnlocked(identity, identity);
      if (finalCleanup.pending > 0) throw new Error("a previous workspace child-key cleanup is pending; issuance is blocked until it completes");
      await assertNoPendingRevocations(identity);
      return mint(identity, budgetUsd, (row, remoteId) => {
        mintedRemote = { row, remoteId };
      });
    }, async () => {
      const remote = mintedRemote;
      if (!remote) return;
      const cleaned = await revokePending({
        ...remote.row,
        keyId: remote.remoteId,
        status: "revocation_pending"
      }, identity);
      if (!cleaned) throw new Error("lease-loss child-key cleanup is pending");
    }));
  }
  async function getUsage(identityInput) {
    const identity = normalizeIdentity(identityInput);
    const scope = scopeKey(scopeFor(identity, product));
    return withLocalLock(scope, () => withDurableLease(scope, async () => {
      const active = await readActive(identity);
      return active?.usage ?? null;
    }));
  }
  return { ensureKey, getUsage, retryPendingRevocations };
}

// src/billing/index.ts
function createTcloudKeyProvisioner(client) {
  return {
    createKey: async (input) => {
      const created = await client.createKey(input);
      return { id: created.id, key: created.key };
    },
    revokeKey: (keyId) => client.revokeKey(keyId),
    getKey: async (keyId) => {
      const info = await client.getKey(keyId);
      return {
        budgetUsd: info.budgetUsd ?? void 0,
        budgetSpent: info.budgetSpent ?? void 0,
        expiresAt: info.expiresAt ?? null
      };
    }
  };
}
function nextPeriodEnd(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}
function createPlatformBalanceManager(opts) {
  const { client, planLimits, freePlan, productSlug } = opts;
  const getState = async (userId) => {
    const identity = await client.resolveIdentity(userId);
    if (!identity || !identity.apiKey) {
      const limits2 = planLimits[freePlan];
      return {
        platformUserId: identity?.platformUserId ?? null,
        plan: freePlan,
        monthlyBalanceUsd: limits2.monthlyBalanceUsd,
        remainingBalanceUsd: 0,
        lifetimeSpentUsd: 0,
        concurrency: limits2.concurrency,
        overageAllowed: limits2.overageAllowed
      };
    }
    const [plan, balance] = await Promise.all([client.getPlan(identity.apiKey), client.getBalance(identity.apiKey)]);
    const limits = planLimits[plan];
    return {
      platformUserId: identity.platformUserId,
      plan,
      monthlyBalanceUsd: limits.monthlyBalanceUsd,
      remainingBalanceUsd: balance.balance,
      lifetimeSpentUsd: balance.lifetimeSpent,
      concurrency: limits.concurrency,
      overageAllowed: limits.overageAllowed
    };
  };
  const canStartBillableTurn = async (userId) => {
    const state = await getState(userId);
    if (!state.platformUserId) return { allowed: false, state };
    const allowed = state.overageAllowed || state.remainingBalanceUsd > 0;
    return { allowed, state };
  };
  const deduct = async (userId, params) => {
    const identity = await client.resolveIdentity(userId);
    if (!identity) throw new Error("Shared billing requires a platform-linked user");
    await client.deduct({
      platformUserId: identity.platformUserId,
      amountUsd: params.amountUsd,
      type: params.type,
      description: params.description,
      referenceId: params.referenceId
    });
  };
  const getProductUsage = async (userId) => {
    const identity = await client.resolveIdentity(userId);
    if (!identity?.apiKey) return { spentUsd: 0, transactionCount: 0 };
    const rows = await client.getUsageByProduct(identity.apiKey);
    const product = rows.find((row) => row.product === productSlug);
    return { spentUsd: product?.totalSpent ?? 0, transactionCount: product?.count ?? 0 };
  };
  return { getState, canStartBillableTurn, deduct, getProductUsage };
}
function createWorkspaceKeyManager(opts) {
  const clock = opts.now ?? (() => /* @__PURE__ */ new Date());
  const product = opts.product ?? "router";
  const getUsage = async (workspaceId) => {
    const active = await opts.store.getActive(workspaceId);
    if (!active) return null;
    const info = await opts.provisioner.getKey(active.keyId);
    const budgetUsd = info.budgetUsd ?? active.budgetUsd;
    const budgetSpent = info.budgetSpent ?? 0;
    const budgetRemaining = Math.max(0, budgetUsd - budgetSpent);
    return {
      keyId: active.keyId,
      budgetUsd,
      budgetSpent,
      budgetRemaining,
      expiresAt: info.expiresAt ?? (active.expiresAt ? active.expiresAt.toISOString() : null),
      exhausted: budgetRemaining <= 0
    };
  };
  const rotateKey = async (workspaceId, ropts) => {
    const now = clock();
    const allowance = ropts?.budgetUsd ?? opts.defaultBudgetUsd;
    let budgetUsd = allowance;
    if (ropts?.rollover) {
      const prior = await getUsage(workspaceId).catch(() => null);
      budgetUsd = allowance + (prior?.budgetRemaining ?? 0);
      if (ropts.rolloverCapUsd != null) budgetUsd = Math.min(budgetUsd, ropts.rolloverCapUsd);
    }
    await assertWorkspaceKeyCryptoUsable(opts.crypto);
    const expiresAt = nextPeriodEnd(now);
    const created = await opts.provisioner.createKey({ name: `ws:${workspaceId}`, product, budgetUsd, expiresAt: expiresAt.toISOString() });
    if (!created.key || !created.id) throw new Error("tcloud createKey returned no key");
    const mintedKeyId = created.id;
    let keyEncrypted;
    let priors;
    try {
      keyEncrypted = await opts.crypto.encrypt(created.key);
      priors = await opts.store.listActive(workspaceId);
      await opts.store.insert({ workspaceId, keyId: mintedKeyId, keyEncrypted, budgetUsd, expiresAt });
    } catch (err) {
      try {
        await opts.provisioner.revokeKey(mintedKeyId);
      } catch (revokeErr) {
        console.error(
          `[workspace-key-manager] FAILED to revoke orphaned child key ${mintedKeyId} for workspace ${workspaceId} after a post-mint failure \u2014 it now leaks parent-key budget. Revoke error:`,
          revokeErr
        );
      }
      throw err;
    }
    for (const p of priors) {
      await opts.store.markRevoked(p.id, now);
      try {
        await opts.provisioner.revokeKey(p.keyId);
      } catch {
      }
    }
    return created.key;
  };
  const ensureKey = async (workspaceId, eopts) => {
    const now = clock();
    const active = await opts.store.getActive(workspaceId);
    if (active && (!active.expiresAt || active.expiresAt.getTime() > now.getTime())) {
      return opts.crypto.decrypt(active.keyEncrypted);
    }
    return rotateKey(workspaceId, { budgetUsd: eopts?.budgetUsd });
  };
  return { ensureKey, rotateKey, getUsage };
}

export {
  createIdentityBoundWorkspaceKeyManager,
  createTcloudKeyProvisioner,
  createPlatformBalanceManager,
  createWorkspaceKeyManager
};
//# sourceMappingURL=chunk-4ZJYNI53.js.map