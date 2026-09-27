// src/vault/server.ts
var VAULT_DELETION_REFUSAL_RATIO = 0.75;
var VAULT_DELETION_REFUSAL_MIN_LIVE_FILES = 10;
function assessVaultDeletionBatch(input) {
  const refusalRatio = input.policy?.refusalRatio ?? VAULT_DELETION_REFUSAL_RATIO;
  const minLiveFiles = input.policy?.minLiveFiles ?? VAULT_DELETION_REFUSAL_MIN_LIVE_FILES;
  if (!Number.isFinite(refusalRatio) || refusalRatio <= 0 || refusalRatio > 1) {
    throw new RangeError(
      `vault deletion policy refusalRatio must be a finite number in (0, 1], got ${refusalRatio}`
    );
  }
  if (!Number.isFinite(minLiveFiles) || minLiveFiles < 0) {
    throw new RangeError(
      `vault deletion policy minLiveFiles must be a finite number >= 0, got ${minLiveFiles}`
    );
  }
  const manifestEmpty = input.manifestEmpty ?? false;
  const baselineLive = input.baselinePaths.length;
  const proposedSet = new Set(input.proposedDeletions);
  const wouldDeletePaths = manifestEmpty ? [...input.baselinePaths].sort() : input.baselinePaths.filter((p) => proposedSet.has(p)).sort();
  const wouldDelete = wouldDeletePaths.length;
  const deletionRatio = baselineLive > 0 ? wouldDelete / baselineLive : 0;
  const refusesEmptyManifest = manifestEmpty && baselineLive > 0;
  const refusesAllFiles = wouldDelete > 0 && wouldDelete === baselineLive;
  const refusesBlastRadius = wouldDelete > 0 && baselineLive >= minLiveFiles && deletionRatio >= refusalRatio;
  const reason = refusesEmptyManifest ? "empty-manifest" : refusesAllFiles ? "all-files" : refusesBlastRadius ? "ratio-exceeded" : void 0;
  return {
    allowed: reason === void 0,
    reason,
    deletionRatio,
    wouldDelete,
    wouldDeletePaths,
    baselineLive
  };
}
function compareIncarnationBaseline(baselineId, current) {
  const currentId = current.filesystemIncarnationId;
  const provenance = current.filesystemIncarnationProvenance;
  const isValidProvenance = provenance === "fresh" || provenance === "restored" || provenance === "unknown";
  if (typeof currentId !== "string" || currentId.length === 0 || !isValidProvenance) {
    return { verdict: "unidentified" };
  }
  if (current.filesystemIncarnationReadiness !== "ready") {
    return { verdict: "not-ready", readiness: current.filesystemIncarnationReadiness };
  }
  if (baselineId === void 0) {
    return { verdict: "no-baseline" };
  }
  if (baselineId !== currentId) {
    return { verdict: "mismatch", baselineId, currentId };
  }
  return { verdict: "match" };
}
export {
  VAULT_DELETION_REFUSAL_MIN_LIVE_FILES,
  VAULT_DELETION_REFUSAL_RATIO,
  assessVaultDeletionBatch,
  compareIncarnationBaseline
};
//# sourceMappingURL=server.js.map