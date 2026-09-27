import {
  DEFAULT_HARNESS,
  assertHarnessModelCompatible,
  isHarness
} from "./chunk-MCYJON3F.js";
import {
  assertProfilePromptWithinBudget,
  fingerprintAgentProfile
} from "./chunk-LWSJK546.js";
import {
  buildAppToolMcpServer
} from "./chunk-6A7MYOUI.js";
import {
  resolveTangleExecutionEnvironment,
  trimOrNull
} from "./chunk-JML7WKWU.js";

// src/sandbox/index.ts
import {
  Sandbox
} from "@tangle-network/sandbox/core";
import { createHash } from "crypto";
import { mergeAgentProfiles } from "@tangle-network/agent-interface";

// src/sandbox/outcome.ts
var ok = (value) => ({ succeeded: true, value });
var fail = (error) => ({
  succeeded: false,
  error: error instanceof Error ? error : new Error(String(error))
});

// src/sandbox/model.ts
function resolveModelSelection(config, override) {
  const c = config ?? {};
  const explicitBaseUrl = trimOrNull(c.routerBaseUrl);
  const explicitApiKey = trimOrNull(override?.modelApiKey) ?? trimOrNull(c.apiKey);
  const providerName = trimOrNull(c.providerName);
  const openaiApiKey = trimOrNull(c.openaiApiKey);
  const provider = providerName ?? (explicitApiKey ? "openai-compat" : openaiApiKey ? "openai" : void 0);
  const overrideModel = trimOrNull(override?.model);
  const configModel = trimOrNull(c.modelName);
  const defaultModel = trimOrNull(c.defaultModel);
  const modelName = overrideModel ?? configModel ?? (provider === "openai" || provider === "openai-compat" ? defaultModel : null);
  if (!modelName) return { succeeded: true, value: void 0 };
  const source = overrideModel ? "override" : configModel ? "config" : "default";
  if (!provider) return { succeeded: false, error: "no_provider", model: modelName, source };
  const apiKey = explicitApiKey ?? (provider === "openai" ? openaiApiKey : void 0);
  if (!apiKey && !c.allowKeylessModel) {
    return { succeeded: false, error: "no_api_key", model: modelName, provider, source };
  }
  return {
    succeeded: true,
    value: {
      model: modelName,
      provider,
      ...apiKey ? { apiKey } : {},
      ...explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}
    }
  };
}
function resolveModel(config, override) {
  const selection = resolveModelSelection(config, override);
  return selection.succeeded ? selection.value : void 0;
}
var SandboxModelResolutionError = class extends Error {
  code;
  model;
  provider;
  source;
  constructor(failure, context) {
    const missing = failure.error === "no_provider" ? "no provider could be resolved for it" : `provider "${failure.provider}" resolved but no API key is configured`;
    const fix = failure.error === "no_provider" ? "set providerName explicitly (provider cannot be inferred without one)" : 'set apiKey (or openaiApiKey when provider is "openai"), or pass allowKeylessModel:true to mint a keyless box';
    super(
      `${context}: model "${failure.model}" (from ${failure.source}) is not transportable \u2014 ${missing}. Fix: ${fix}. The requested model was NOT sent to the box.`
    );
    this.name = "SandboxModelResolutionError";
    this.code = failure.error;
    this.model = failure.model;
    if (failure.error === "no_api_key") this.provider = failure.provider;
    this.source = failure.source;
  }
};
function requireTransportableModel(selection, context) {
  if (selection.succeeded) return selection.value;
  if (selection.source === "override") {
    throw new SandboxModelResolutionError(selection, context);
  }
  const reason = selection.error === "no_api_key" ? `provider "${selection.provider}" has no api key` : "no provider resolved";
  if (selection.source === "config") {
    console.error(
      `[sandbox] ${context}: dropping configured provider.modelName "${selection.model}" (${reason}); the box will use its own default model \u2014 set allowKeylessModel:true to bake a keyless model, or configure an api key`
    );
  } else {
    console.error(
      `[sandbox] ${context}: dropping provider.defaultModel "${selection.model}" (${reason}); using the box default`
    );
  }
  return void 0;
}

// src/sandbox/binary-read.ts
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function execInSandbox(box, command, options) {
  return options?.sessionId ? box.exec(command, { sessionId: options.sessionId }) : box.exec(command);
}
async function statSandboxFileSize(box, absolutePath, options) {
  const quotedPath = shellQuote(absolutePath);
  let result;
  try {
    result = await execInSandbox(box, `wc -c < ${quotedPath}`, options);
  } catch (err) {
    return { succeeded: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.exitCode !== 0) {
    return { succeeded: false, error: result.stderr || "unknown error" };
  }
  const size = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(size)) {
    return { succeeded: false, error: `could not parse file size from "${result.stdout.trim()}"` };
  }
  return { succeeded: true, value: size };
}
async function readSandboxBinaryBytes(box, absolutePath, expectedSize, options) {
  const quotedPath = shellQuote(absolutePath);
  let result;
  try {
    result = await execInSandbox(box, `base64 ${quotedPath}`, options);
  } catch (err) {
    return { succeeded: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.exitCode !== 0) {
    return { succeeded: false, error: result.stderr || "unknown error" };
  }
  const cleaned = result.stdout.replace(/\s+/g, "");
  let bytes;
  try {
    bytes = base64ToBytes(cleaned);
  } catch (err) {
    return {
      succeeded: false,
      error: `could not decode file contents: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (bytes.byteLength !== expectedSize) {
    return {
      succeeded: false,
      error: `read returned ${bytes.byteLength} bytes, expected ${expectedSize} \u2014 output truncated in transit`
    };
  }
  return { succeeded: true, value: { bytes, size: expectedSize } };
}

// src/sandbox/recovery.ts
var EGRESS_PROXY_RECOVERY_REQUIRED = "EGRESS_PROXY_RECOVERY_REQUIRED";
var EGRESS_PROXY_RECOVERY_PHASE = "egress_proxy_recovery";
var WORKSPACE_SANDBOX_MISSING = "WORKSPACE_SANDBOX_MISSING";
var WORKSPACE_SANDBOX_HOST_EXHAUSTED = "WORKSPACE_SANDBOX_HOST_EXHAUSTED";
var WORKSPACE_SANDBOX_UNRECOVERABLE = "WORKSPACE_SANDBOX_UNRECOVERABLE";
var WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var CODES = {
  [EGRESS_PROXY_RECOVERY_REQUIRED]: { snapshotUsable: true },
  [WORKSPACE_SANDBOX_MISSING]: { snapshotUsable: false },
  [WORKSPACE_SANDBOX_HOST_EXHAUSTED]: { snapshotUsable: false },
  [WORKSPACE_SANDBOX_UNRECOVERABLE]: { snapshotUsable: false }
};
var ACTIONS = {
  confirmation_required: { replacementChosen: false },
  deletion_declined: { replacementChosen: false },
  replacement_authorized: { replacementChosen: false },
  snapshot_replacement_authorized: { replacementChosen: false },
  replacement_started: { replacementChosen: true },
  replacement_completed: { replacementChosen: true },
  snapshot_replacement_started: { replacementChosen: true },
  snapshot_restore_failed: { replacementChosen: true },
  snapshot_replacement_completed: { replacementChosen: true },
  missing_replacement_started: { replacementChosen: true },
  missing_replacement_completed: { replacementChosen: true },
  unrecoverable_replacement_started: { replacementChosen: true },
  unrecoverable_replacement_completed: { replacementChosen: true }
};
var WorkspaceSandboxRecoveryRequiredError = class extends Error {
  code = EGRESS_PROXY_RECOVERY_REQUIRED;
  status = 409;
  phase = EGRESS_PROXY_RECOVERY_PHASE;
  recovery;
  constructor(recovery, cause) {
    super(workspaceSandboxRecoveryMessage(recovery), { cause });
    this.name = "WorkspaceSandboxRecoveryRequiredError";
    this.recovery = recovery;
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function asNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function errorChain(error) {
  const pending = [error];
  const visited = /* @__PURE__ */ new Set();
  const chain = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === void 0 || current === null || visited.has(current)) continue;
    visited.add(current);
    chain.push(current);
    if (!isRecord(current)) continue;
    if (current.cause !== void 0) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return chain;
}
function isEgressProxyRecoveryRequiredError(error) {
  return errorChain(error).some(
    (current) => isRecord(current) && current.code === EGRESS_PROXY_RECOVERY_REQUIRED
  );
}
function isWorkspaceSandboxSnapshotRestoreError(error) {
  return errorChain(error).some((current) => {
    const message = current instanceof Error ? current.message : isRecord(current) && typeof current.message === "string" ? current.message : "";
    return /snapshot|fromSnapshot|restore/i.test(message);
  });
}
function assessWorkspaceSandboxSnapshot(snapshot, sandboxId, now = Date.now()) {
  if (!snapshot) return { availability: "missing", freshness: "unknown" };
  const createdAt = Date.parse(snapshot.createdAt);
  const ageMs = now - createdAt;
  const isFresh = snapshot.fromSandboxId === sandboxId && Number.isFinite(createdAt) && ageMs >= 0 && ageMs <= WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS;
  return isFresh ? { availability: "available", freshness: "fresh", snapshot } : { availability: "stale", freshness: "stale", snapshot };
}
function isSnapshotAssessment(value) {
  if (!isRecord(value)) return false;
  const availability = value.availability;
  const freshness = value.freshness;
  return (availability === "available" || availability === "missing" || availability === "stale") && (freshness === "fresh" || freshness === "stale" || freshness === "unknown");
}
function isWorkspaceSandboxRecoveryAction(value) {
  return typeof value === "string" && Object.hasOwn(ACTIONS, value);
}
function isWorkspaceSandboxRecoveryCode(value) {
  return typeof value === "string" && Object.hasOwn(CODES, value);
}
function isWorkspaceSandboxRecoveryState(value) {
  if (!isRecord(value)) return false;
  return isWorkspaceSandboxRecoveryCode(value.code) && !!asNonEmptyString(value.sandboxId) && !!asNonEmptyString(value.detectedAt) && isSnapshotAssessment(value.snapshot) && isWorkspaceSandboxRecoveryAction(value.action);
}
function workspaceSandboxRecoveryFromError(error) {
  for (const current of errorChain(error)) {
    if (!isRecord(current) || !isWorkspaceSandboxRecoveryState(current.recovery)) continue;
    return current.recovery;
  }
  return void 0;
}
function workspaceSandboxRecoveryMessage(recovery) {
  if (recovery.code === WORKSPACE_SANDBOX_MISSING) {
    return "The sandbox behind this workspace no longer exists on the platform. A replacement is being provisioned and your saved work is restored into it.";
  }
  if (!CODES[recovery.code].snapshotUsable) {
    return "The sandbox behind this workspace could not be started again. A replacement is being provisioned and your saved work is restored into it.";
  }
  if (recovery.action === "deletion_declined") {
    return "Sandbox recovery remains paused because replacement was declined. The stopped sandbox has not been deleted.";
  }
  if (recovery.action === "confirmation_required") {
    const snapshotReason = recovery.snapshot.availability === "missing" ? "No restorable sandbox snapshot is available." : "The available sandbox snapshot is stale.";
    return `Sandbox recovery requires owner confirmation before replacement. ${snapshotReason} The stopped sandbox has not been deleted.`;
  }
  if (recovery.action === "snapshot_restore_failed") {
    return "Sandbox replacement could not restore its verified snapshot, and an empty fallback was not created because it could lose workspace state.";
  }
  return "Sandbox recovery is required before chat can continue. The stopped sandbox has not been deleted.";
}
function workspaceSandboxRecoveryRecommendedActions(recovery) {
  if (!CODES[recovery.code].snapshotUsable) {
    return ["Retry after the replacement sandbox finishes provisioning."];
  }
  if (recovery.action === "deletion_declined") {
    return ["Keep the stopped sandbox for support or ask a workspace owner to authorize replacement."];
  }
  if (recovery.action === "confirmation_required") {
    return ["An owner can explicitly replace the sandbox after accepting loss of unsnapshotted sandbox-local changes."];
  }
  if (recovery.action === "snapshot_restore_failed") {
    return ["Retry snapshot restoration or contact support. An empty replacement is not created automatically."];
  }
  return ["Retry after sandbox recovery completes."];
}
function workspaceSandboxRecoveryDiagnostic(recovery) {
  return {
    sandboxId: recovery.sandboxId,
    recoveryCode: recovery.code,
    snapshotAvailability: recovery.snapshot.availability,
    snapshotFreshness: recovery.snapshot.freshness,
    selectedRecoveryAction: recovery.action,
    replacementSandboxId: recovery.replacementSandboxId
  };
}
function preferredWorkspaceSandboxRecoveryBoxKey(recovery) {
  if (!recovery?.replacementBoxKey) return void 0;
  return ACTIONS[recovery.action].replacementChosen ? recovery.replacementBoxKey : void 0;
}
function shouldRestoreWorkspaceSandboxRecovery(recovery) {
  if (!recovery) return false;
  if (!CODES[recovery.code].snapshotUsable) return false;
  return !!preferredWorkspaceSandboxRecoveryBoxKey(recovery) && recovery.snapshot.availability === "available";
}
function createWorkspaceSandboxRecoveryManager(store) {
  async function record(workspaceId, recovery) {
    await store.write(workspaceId, recovery);
  }
  return {
    read: store.read,
    record,
    async decide({ workspaceId, sandboxId, decision, replacementBoxKey }) {
      const current = await store.read(workspaceId);
      if (!current || current.sandboxId !== sandboxId) return void 0;
      const next = {
        ...current,
        action: decision === "replace" ? current.snapshot.availability === "available" ? "snapshot_replacement_authorized" : "replacement_authorized" : "deletion_declined",
        confirmedAt: (/* @__PURE__ */ new Date()).toISOString(),
        ...decision === "replace" && replacementBoxKey ? { replacementBoxKey } : {}
      };
      await record(workspaceId, next);
      return next;
    },
    async complete({ workspaceId, replacementSandboxId }) {
      const current = await store.read(workspaceId);
      if (!current) return void 0;
      const next = {
        ...current,
        action: completionFor(current.action),
        replacementSandboxId
      };
      await record(workspaceId, next);
      return next;
    }
  };
}
function completionFor(action) {
  switch (action) {
    case "missing_replacement_started":
      return "missing_replacement_completed";
    case "unrecoverable_replacement_started":
      return "unrecoverable_replacement_completed";
    case "snapshot_replacement_started":
    case "snapshot_replacement_authorized":
      return "snapshot_replacement_completed";
    default:
      return "replacement_completed";
  }
}
var WORKSPACE_SANDBOX_RECOVERY_ACTIONS = Object.keys(
  ACTIONS
);
var WORKSPACE_SANDBOX_RECOVERY_CODES = Object.keys(
  CODES
);

// src/sandbox/diagnostics.ts
var SAFE_ERROR_FIELDS = [
  "code",
  "status",
  "phase",
  "endpoint",
  "origin",
  "retryAfterMs",
  "sidecarVersion",
  "containerImage"
];
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function asSafeScalar(value) {
  if (typeof value === "string" && value.length > 0) return redactDiagnosticText(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return void 0;
}
function redactDiagnosticText(value) {
  const secretKeyPattern = "(?:(?:[A-Z0-9]+_)*(?:api_?key|auth_?token|access_?token|refresh_?token|key|token|password|secret|credential)|apiKey|authToken|accessToken|refreshToken)";
  return value.replace(/(['"]authorization['"]\s*:\s*)(['"])[^'"]*\2/gi, "$1$2[REDACTED]$2").replace(/\b(authorization\s*[:=]\s*)(['"])[^'"]*\2/gi, "$1$2[REDACTED]$2").replace(/\b(authorization\s*[:=]\s*)Digest\b[^;}\n]*(?:\r?\n[ \t]+[^;}\n]*)*/gi, "$1[REDACTED]").replace(/\b(authorization\s*[:=]\s*)(?:Basic|Bearer|Negotiate)\s+[^\s;,&}\n]+(?:\r?\n[ \t]+[^\s;,&}\n]+)*/gi, "$1[REDACTED]").replace(new RegExp(`\\b(authorization\\s*[:=]\\s*)(?!(?:Basic|Bearer|Digest|Negotiate)\\b)([A-Za-z][A-Za-z0-9._-]+)\\s+(?!(?:authorization|${secretKeyPattern})\\s*[:=]|['"](?:authorization|${secretKeyPattern})['"]\\s*:)([^}\\n]*(?:\\r?\\n[ \\t]+[^}\\n]*)*)`, "gi"), (_match, prefix, _scheme, valuePart) => {
    if (valuePart.includes(";") || /\r?\n[ \t]+/.test(valuePart)) return `${prefix}[REDACTED]`;
    const tokenMatch = valuePart.match(/^\S+(.*)$/);
    return `${prefix}[REDACTED]${tokenMatch?.[1] ?? ""}`;
  }).replace(/\b(authorization\s*[:=]\s*)[A-Za-z][\w.-]+\s+[^\s;,&}\n]+(?=[;&}\n]|$)/gi, "$1[REDACTED]").replace(/\b(authorization\s*[:=]\s*)(?!\[REDACTED\])[^'"\s&}]+(?:[;,][^'"\s&}]+)*/gi, "$1[REDACTED]").replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "sk-[REDACTED]").replace(
    /([?&][^=&#\s]*(?:token|key|secret|password|authorization)[^=&#\s]*=)[^&#\s]+/gi,
    "$1[REDACTED]"
  ).replace(
    new RegExp(`(['"])(${secretKeyPattern})\\1\\s*:\\s*(['"])[^'"]+\\3`, "gi"),
    "$1$2$1:$3[REDACTED]$3"
  ).replace(
    new RegExp(`\\b(${secretKeyPattern})\\s*([:=])(\\s*)(['"]?)(?!Bearer\\b)[^'"\\s;,&}]+(?:[;,]\\s*[^'"\\s;,&}]+)*`, "gi"),
    "$1$2$3$4[REDACTED]"
  );
}
function readMessage(value) {
  if (value instanceof Error) return redactDiagnosticText(value.message);
  if (typeof value === "string" && value.length > 0) return redactDiagnosticText(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (!isRecord2(value)) return void 0;
  const message = value.message;
  return typeof message === "string" && message.length > 0 ? redactDiagnosticText(message) : void 0;
}
function readName(value) {
  if (value instanceof Error) return redactDiagnosticText(value.name);
  if (!isRecord2(value)) return void 0;
  const name = value.name;
  return typeof name === "string" && name.length > 0 ? redactDiagnosticText(name) : void 0;
}
function readCause(value) {
  if (!isRecord2(value)) return void 0;
  return value.cause;
}
function serializeSandboxProvisioningError(error, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const causes = [];
  const seen = /* @__PURE__ */ new Set();
  let truncatedAtDepth;
  let cycle = false;
  let current = error;
  let depth = 0;
  for (; depth < maxDepth && current !== void 0 && current !== null; depth += 1) {
    if (seen.has(current)) {
      cycle = true;
      causes.push({
        name: "CauseChainCycle",
        message: `cause chain cycle detected after ${depth} entries`
      });
      break;
    }
    if (isRecord2(current)) seen.add(current);
    const cause = {};
    const name = readName(current);
    const message = readMessage(current);
    if (name) cause.name = name;
    if (message) cause.message = message;
    if (isRecord2(current)) {
      for (const field of SAFE_ERROR_FIELDS) {
        const safeValue = asSafeScalar(current[field]);
        if (safeValue !== void 0) {
          Object.assign(cause, { [field]: safeValue });
        }
      }
    }
    if (Object.keys(cause).length > 0) causes.push(cause);
    current = readCause(current);
  }
  if (!cycle && isRecord2(current) && seen.has(current)) {
    cycle = true;
    causes.push({
      name: "CauseChainCycle",
      message: `cause chain cycle detected after ${depth} entries`
    });
  } else if (current !== void 0 && current !== null && depth >= maxDepth) {
    truncatedAtDepth = maxDepth;
    causes.push({
      name: "CauseChainTruncated",
      message: `cause chain truncated after ${maxDepth} entries`
    });
  }
  return {
    message: readMessage(error) ?? "Sandbox unavailable",
    causes,
    truncated: truncatedAtDepth !== void 0,
    truncatedAtDepth,
    cycle
  };
}
function formatSandboxProvisioningSupportDetails(diagnostics) {
  const actionableCause = diagnostics.causes.find(
    (cause) => cause.code !== void 0 || cause.status !== void 0 || cause.phase !== void 0 || cause.endpoint !== void 0 || cause.origin !== void 0 || cause.retryAfterMs !== void 0 || cause.sidecarVersion !== void 0 || cause.containerImage !== void 0
  ) ?? diagnostics.causes[1];
  if (!actionableCause) return "Support details: no nested sandbox cause details were available.";
  const details = [
    typeof actionableCause.name === "string" ? redactDiagnosticText(actionableCause.name) : void 0,
    actionableCause.code !== void 0 ? `code=${actionableCause.code}` : void 0,
    actionableCause.status !== void 0 ? `status=${actionableCause.status}` : void 0,
    actionableCause.phase !== void 0 ? `phase=${redactDiagnosticText(actionableCause.phase)}` : void 0,
    actionableCause.endpoint !== void 0 ? `endpoint=${redactDiagnosticText(actionableCause.endpoint)}` : void 0,
    actionableCause.origin !== void 0 ? `origin=${redactDiagnosticText(actionableCause.origin)}` : void 0,
    actionableCause.retryAfterMs !== void 0 ? `retryAfterMs=${actionableCause.retryAfterMs}` : void 0,
    actionableCause.sidecarVersion !== void 0 ? `sidecarVersion=${redactDiagnosticText(actionableCause.sidecarVersion)}` : void 0,
    actionableCause.containerImage !== void 0 ? `containerImage=${redactDiagnosticText(actionableCause.containerImage)}` : void 0,
    typeof actionableCause.message === "string" ? redactDiagnosticText(actionableCause.message) : void 0
  ].filter(Boolean);
  if (details.length === 0) return "Support details: no nested sandbox cause details were available.";
  return `Support details: ${details.join("; ")}`;
}
function isSandboxAuthFailure(diagnostics) {
  return diagnostics.causes.some((cause) => {
    const code = typeof cause.code === "string" ? cause.code.toUpperCase() : void 0;
    const status = typeof cause.status === "number" ? cause.status : typeof cause.status === "string" ? Number.parseInt(cause.status, 10) : void 0;
    const name = typeof cause.name === "string" ? cause.name.toLowerCase() : "";
    const message = typeof cause.message === "string" ? cause.message.toLowerCase() : "";
    return code === "AUTH_ERROR" || status === 401 || name.includes("autherror") || message.includes("missing or invalid authentication");
  });
}
function isSandboxApiBearerAuthFailure(diagnostics) {
  return diagnostics.causes.some((cause) => {
    const status = typeof cause.status === "number" ? cause.status : typeof cause.status === "string" ? Number.parseInt(cause.status, 10) : void 0;
    if (status !== 401) return false;
    if (cause.origin !== "sandbox-api") return false;
    if (typeof cause.endpoint !== "string") return false;
    const endpointPath = sandboxApiEndpointPath(cause.endpoint);
    if (!endpointPath) return false;
    return /^\/v1\/sandboxes\/[^/?#]+(?:\/(?!runtime(?:[/?#]|$))[^?#]*)?(?:[?#].*)?$/.test(endpointPath);
  });
}
var SANDBOX_BACKING_CONTAINER_MISSING_CODE = "BACKING_CONTAINER_MISSING";
function isLegacySandboxBackingContainerMissingMessage(message) {
  return /host-agent startcontainer failed \(404\):/i.test(message) && /container not found/i.test(message) && /"code"\s*:\s*"not_found"/i.test(message);
}
function isSandboxApiSandboxMissingFailure(diagnostics) {
  return diagnostics.causes.some((cause) => {
    const status = typeof cause.status === "number" ? cause.status : typeof cause.status === "string" ? Number.parseInt(cause.status, 10) : void 0;
    if (cause.origin !== "sandbox-api") return false;
    if (typeof cause.endpoint !== "string") return false;
    const endpointPath = sandboxApiEndpointPath(cause.endpoint);
    if (!endpointPath) return false;
    const sandboxResource = /^\/v1\/sandboxes\/[^/?#]+(?:\/(?!runtime(?:[/?#]|$))[^?#]*)?(?:[?#].*)?$/.test(endpointPath);
    if (!sandboxResource) return false;
    if (status === 404) return true;
    if (status !== 500 || !/^\/v1\/sandboxes\/[^/?#]+\/resume(?:[?#].*)?$/.test(endpointPath)) {
      return false;
    }
    const code = typeof cause.code === "string" ? cause.code.toUpperCase() : void 0;
    if (code === SANDBOX_BACKING_CONTAINER_MISSING_CODE) return true;
    if (code !== void 0 && code !== "SERVER_ERROR") return false;
    const message = typeof cause.message === "string" ? cause.message : "";
    return isLegacySandboxBackingContainerMissingMessage(message);
  });
}
function isSandboxHostCapacityFailure(diagnostics) {
  return diagnostics.causes.some((cause) => {
    if (cause.origin !== "sandbox-api") return false;
    if (typeof cause.message !== "string") return false;
    return /host has no available slot|host capacity reservation failed/i.test(cause.message);
  });
}
function isSandboxBoxConfigFailure(diagnostics) {
  return diagnostics.causes.some((cause) => {
    if (cause.origin !== "sandbox-api") return false;
    if (cause.code === "SANDBOX_ATTRIBUTION_MISMATCH") return true;
    if (typeof cause.message !== "string") return false;
    return /has no recorded egress policy|cannot rebuild the proxy config/i.test(cause.message);
  });
}
function sandboxApiEndpointPath(endpoint) {
  if (endpoint.startsWith("/")) return endpoint;
  try {
    const url = new URL(endpoint);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
function formatSandboxProvisioningUserMessage(diagnostics) {
  if (diagnostics.causes.some((cause) => cause.code === EGRESS_PROXY_RECOVERY_REQUIRED)) {
    return "Sandbox recovery is required before chat can continue. The stopped sandbox has not been deleted.";
  }
  if (diagnostics.causes.some((cause) => cause.code === "vault.hydration_incomplete")) {
    return "I couldn't finish copying your Vault into the sandbox, so I stopped rather than work from a partial copy. The copy resumes where it left off \u2014 try again in a moment.";
  }
  if (isSandboxApiBearerAuthFailure(diagnostics)) {
    return "I'm unable to reconnect to the sandbox because its sandbox API credential was rejected. Another request may have rotated the bearer used for this operation.";
  }
  if (isSandboxAuthFailure(diagnostics)) {
    return "I'm unable to reconnect to the sandbox because its runtime authentication failed. This can happen when an existing sandbox is reused with stale credentials.";
  }
  if (diagnostics.causes.some((cause) => cause.code === "PAYLOAD_TOO_LARGE" || cause.code === "FILE_TOO_LARGE" || cause.status === 413 || cause.status === "413")) {
    return "An attachment is too large for the sandbox to accept. Use a smaller file and try again.";
  }
  if (diagnostics.causes.some((cause) => cause.code === "UPLOAD_BUDGET_EXHAUSTED")) {
    return "Too much attachment data is staged in the sandbox at once. Retry shortly.";
  }
  return "I'm unable to connect to the sandbox right now. This usually means the sandbox service is not configured or is temporarily unavailable.";
}

// src/sandbox/workspace-sandbox-manager.ts
function createWorkspaceSandboxManager(opts) {
  return {
    async ensureWorkspaceSandbox(workspaceId, userId, options) {
      if (!workspaceId) throw new Error("workspaceId is required");
      if (!userId) throw new Error("userId is required");
      const ctx = { workspaceId, userId };
      const client = await opts.getClient(ctx);
      const name = opts.nameForWorkspace(workspaceId, ctx);
      let listError;
      let existing = [];
      try {
        existing = await opts.listSandboxes(client, ctx);
      } catch (err) {
        listError = err;
        opts.onListError?.(err, ctx);
      }
      const found = existing.find((box) => box.name === name);
      if (found) {
        return await opts.prepareExisting?.(found, ctx, options) ?? found;
      }
      const created = await opts.createSandbox({
        client,
        ctx,
        name,
        options,
        listError
      });
      await opts.waitForRunning?.(created, ctx);
      return await opts.prepareCreated?.(created, ctx, options) ?? created;
    }
  };
}

// src/sandbox/terminal-connection.ts
var DEFAULT_TTL_MINUTES = 15;
var TERMINAL_SCOPE = "session-runtime";
function defaultResolveConnectionId(ctx) {
  return ctx.requested;
}
function createSandboxTerminalConnectionRoute(opts) {
  const resolveConnectionId = opts.resolveConnectionId ?? defaultResolveConnectionId;
  return async function handleSandboxTerminalConnection(request) {
    const user = await opts.requireUser(request);
    if (user instanceof Response) return user;
    let box;
    try {
      box = await opts.ensureSandbox(user, request);
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to provision sandbox" },
        { status: 500 }
      );
    }
    const runtimeUrl = box.connection?.runtimeUrl;
    if (!runtimeUrl) {
      return Response.json(
        {
          error: "Sandbox runtime not ready. The sandbox is still initializing -- retry in a few seconds.",
          status: box.status
        },
        { status: 503 }
      );
    }
    const requested = new URL(request.url).searchParams.get("connectionId");
    const connectionId = await resolveConnectionId({ request, user, box, requested });
    if (!connectionId) {
      return Response.json(
        {
          error: "connectionId is required \u2014 pass the same id TerminalView dials (tabTerminalConnectionId()) as the 'connectionId' query parameter"
        },
        { status: 400 }
      );
    }
    let scoped;
    try {
      scoped = await box.mintScopedToken({
        scope: TERMINAL_SCOPE,
        ttlMinutes: opts.ttlMinutes ?? DEFAULT_TTL_MINUTES,
        sessionId: connectionId
      });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : "Failed to mint sandbox token" },
        { status: 503 }
      );
    }
    return Response.json({
      sidecarUrl: scoped.sidecarProxyUrl,
      token: scoped.token,
      expiresAt: scoped.expiresAt.toISOString(),
      status: box.status,
      sandboxId: box.id,
      connectionId
    });
  };
}

// src/sandbox/prewarm.ts
function sandboxPrewarmClaimKey(scope) {
  return `${scope.workspaceId}::${scope.harness}`;
}
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}
function createSandboxPrewarmer(shell, options) {
  const mode = options.mode ?? "resume-only";
  const claimTtlSeconds = options.claimTtlSeconds ?? 180;
  const failureCooldownMs = options.failureCooldownMs ?? 6e4;
  const now = options.now ?? (() => Date.now());
  const claim = options.claim === "single-isolate-only" ? null : options.claim;
  const inFlight = /* @__PURE__ */ new Map();
  const failures = /* @__PURE__ */ new Map();
  const emit = (event) => {
    try {
      options.onEvent?.(event);
    } catch {
    }
  };
  async function releaseClaim(key) {
    if (!claim) return;
    try {
      await claim.release(key);
    } catch {
    }
  }
  async function runWarm(key, scope, holdsClaim) {
    const startedAt = now();
    emit({ type: "started", key, workspaceId: scope.workspaceId });
    try {
      const box = await ensureWorkspaceSandbox(shell, {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        harness: scope.harness,
        billingOwnerId: scope.billingOwnerId
      });
      const ms = now() - startedAt;
      failures.delete(key);
      emit({ type: "succeeded", key, workspaceId: scope.workspaceId, boxId: box.id, ms });
      return { ok: true, boxId: box.id, ms };
    } catch (err) {
      const ms = now() - startedAt;
      const error = errText(err);
      failures.set(key, { error, until: now() + failureCooldownMs });
      emit({ type: "failed", key, workspaceId: scope.workspaceId, error, ms });
      return { ok: false, error, ms };
    } finally {
      inFlight.delete(key);
      if (holdsClaim) await releaseClaim(key);
    }
  }
  return {
    async prewarm(scope) {
      const key = sandboxPrewarmClaimKey(scope);
      if (inFlight.has(key)) {
        emit({ type: "skipped", key, workspaceId: scope.workspaceId, outcome: "already-warming" });
        return { outcome: "already-warming" };
      }
      const failure = failures.get(key);
      if (failure && now() < failure.until) {
        emit({ type: "skipped", key, workspaceId: scope.workspaceId, outcome: "cooling-down" });
        return { outcome: "cooling-down" };
      }
      let settle = () => {
      };
      const reservation = new Promise((resolve) => {
        settle = resolve;
      });
      inFlight.set(key, reservation);
      const abandon = (outcome) => {
        inFlight.delete(key);
        settle({ ok: false, error: outcome, ms: 0 });
        emit({ type: "skipped", key, workspaceId: scope.workspaceId, outcome });
        return { outcome };
      };
      try {
        const peek = await peekWorkspaceSandbox(shell, {
          workspaceId: scope.workspaceId,
          userId: scope.userId
        });
        if (peek.status === "running") return abandon("already-running");
        if (peek.status === "warming") return abandon("already-warming");
        if (peek.status === "absent" && mode === "resume-only") {
          return abandon("absent-and-resume-only");
        }
        if (options.shouldPrewarm) {
          const allowed = await options.shouldPrewarm(scope);
          if (!allowed) return abandon("declined-by-policy");
        }
        let holdsClaim = false;
        if (claim) {
          holdsClaim = await claim.acquire(key, claimTtlSeconds);
          if (!holdsClaim) return abandon("warming-elsewhere");
        }
        const warm = runWarm(key, scope, holdsClaim);
        void warm.then(settle);
        return { outcome: "started", completion: warm };
      } catch (err) {
        const error = errText(err);
        inFlight.delete(key);
        failures.set(key, { error, until: now() + failureCooldownMs });
        settle({ ok: false, error, ms: 0 });
        emit({ type: "failed", key, workspaceId: scope.workspaceId, error, ms: 0 });
        return { outcome: "cooling-down" };
      }
    },
    async readiness(scope) {
      const key = sandboxPrewarmClaimKey(scope);
      const peek = await peekWorkspaceSandbox(shell, {
        workspaceId: scope.workspaceId,
        userId: scope.userId
      });
      if (peek.status === "running") return { status: "ready", boxId: peek.box.id };
      if (peek.status === "warming") return { status: "warming" };
      if (inFlight.has(key)) return { status: "warming" };
      if (claim?.isHeld) {
        try {
          if (await claim.isHeld(key)) return { status: "warming" };
        } catch {
        }
      }
      const failure = failures.get(key);
      if (failure && now() < failure.until) {
        return { status: "failed", error: failure.error, retryAfterMs: failure.until - now() };
      }
      return { status: "absent" };
    },
    clearFailure(scope) {
      failures.delete(sandboxPrewarmClaimKey(scope));
    }
  };
}

// src/sandbox/prewarm-claim-d1.ts
var DEFAULT_PREWARM_CLAIM_TABLE = "sandbox_prewarm_claims";
var PREWARM_CLAIM_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DEFAULT_PREWARM_CLAIM_TABLE} (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
)`;
var SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function createD1PrewarmClaimStore(db, options = {}) {
  const table = options.table ?? DEFAULT_PREWARM_CLAIM_TABLE;
  if (!SAFE_IDENTIFIER.test(table)) {
    throw new Error(`Invalid prewarm claim table name: ${JSON.stringify(table)}`);
  }
  const now = options.now ?? (() => Date.now());
  const acquireSql = `INSERT INTO ${table} (key, expires_at) VALUES (?1, ?2)
ON CONFLICT(key) DO UPDATE SET expires_at = ?2 WHERE ${table}.expires_at <= ?3
RETURNING key`;
  const acquireLeaseSql = `INSERT INTO ${table} (key, expires_at) VALUES (?1, ?2)
ON CONFLICT(key) DO UPDATE SET expires_at = MAX(?2, ABS(${table}.expires_at) + 1)
WHERE ${table}.expires_at <= ?3
RETURNING key, expires_at`;
  const releaseSql = `DELETE FROM ${table} WHERE key = ?1`;
  const releaseLeaseSql = `UPDATE ${table}
SET expires_at = CASE WHEN expires_at = 0 THEN -1 ELSE -expires_at END
WHERE key = ?1 AND expires_at = ?2`;
  const inspectSql = `SELECT expires_at FROM ${table} WHERE key = ?1`;
  async function inspect(key) {
    const row = await db.prepare(inspectSql).bind(key).first();
    if (!row || row.expires_at < 0) return { status: "absent" };
    return row.expires_at > now() ? { status: "held", expiresAt: row.expires_at } : { status: "expired", expiresAt: row.expires_at };
  }
  return {
    async acquire(key, ttlSeconds) {
      const at = now();
      const row = await db.prepare(acquireSql).bind(key, at + ttlSeconds * 1e3, at).first();
      return row != null;
    },
    async acquireLease(key, ttlSeconds) {
      const at = now();
      const requestedExpiry = Math.max(1, at + ttlSeconds * 1e3);
      const row = await db.prepare(acquireLeaseSql).bind(key, requestedExpiry, at).first();
      if (!row) return null;
      return Object.freeze({ key: row.key, expiresAt: row.expires_at });
    },
    async release(key) {
      await db.prepare(releaseSql).bind(key).run();
    },
    async releaseLease(lease) {
      await db.prepare(releaseLeaseSql).bind(lease.key, lease.expiresAt).run();
    },
    async isHeld(key) {
      return (await inspect(key)).status === "held";
    },
    inspect
  };
}

// src/sandbox/foreground-single-flight.ts
var DEFAULT_FOREGROUND_PROVISION_CLAIM_TTL_SECONDS = 180;
var DEFAULT_FOREGROUND_PROVISION_POLL_INTERVAL_MS = 5e3;
var SandboxProvisioningFailedElsewhereError = class extends Error {
  constructor(workspaceId, state) {
    super(
      `Sandbox provisioning for workspace ${workspaceId} failed in another request (state=${state})`
    );
    this.workspaceId = workspaceId;
    this.state = state;
    this.name = "SandboxProvisioningFailedElsewhereError";
  }
  workspaceId;
  state;
  code = "sandbox.provisioning_failed_elsewhere";
};
var SandboxFilesystemNotReadyError = class extends Error {
  constructor(workspaceId, readiness) {
    super(`Sandbox filesystem for workspace ${workspaceId} is ${readiness}`);
    this.workspaceId = workspaceId;
    this.readiness = readiness;
    this.name = "SandboxFilesystemNotReadyError";
  }
  workspaceId;
  readiness;
  code = "sandbox.filesystem_not_ready";
  retryable = true;
};
function failedState(peek) {
  return peek.status === "not-running" ? peek.state : "absent";
}
function isReadyRunningSandbox(peek) {
  return peek.status === "running" && peek.box.filesystemIncarnationReadiness === "ready";
}
function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}
function safeErrorText(error) {
  try {
    if (error instanceof Error) {
      const message = error.message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
  }
  try {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      const message = Reflect.get(error, "message");
      if (typeof message === "string" && message) return message;
    }
  } catch {
  }
  try {
    const text = typeof error === "string" ? error : String(error);
    return text || "unknown error";
  } catch {
    return "unknown error";
  }
}
async function runForegroundSandboxSingleFlight(options) {
  const key = sandboxPrewarmClaimKey(options);
  const ttlSeconds = positiveNumber(
    options.claimTtlSeconds ?? DEFAULT_FOREGROUND_PROVISION_CLAIM_TTL_SECONDS,
    "claimTtlSeconds"
  );
  const pollIntervalMs = positiveNumber(
    options.pollIntervalMs ?? DEFAULT_FOREGROUND_PROVISION_POLL_INTERVAL_MS,
    "pollIntervalMs"
  );
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const emit = (event) => {
    try {
      options.onEvent?.(event);
    } catch {
    }
  };
  const provisionAsOwner = async (lease) => {
    try {
      return await options.provision();
    } finally {
      try {
        await options.claim.releaseLease(lease);
      } catch (error) {
        emit({
          type: "release-failed",
          key,
          workspaceId: options.workspaceId,
          error: safeErrorText(error)
        });
      }
    }
  };
  const initialLease = await options.claim.acquireLease(key, ttlSeconds);
  if (initialLease) return provisionAsOwner(initialLease);
  emit({ type: "waiting", key, workspaceId: options.workspaceId });
  while (true) {
    await wait(pollIntervalMs);
    const [peek, claim] = await Promise.all([
      options.peek(),
      options.claim.inspect(key)
    ]);
    if (claim.status === "held") continue;
    if (peek.status === "warming") {
      throw new SandboxFilesystemNotReadyError(options.workspaceId, "transitioning");
    }
    if (isReadyRunningSandbox(peek)) return options.adopt(peek);
    if (peek.status === "running") {
      throw new SandboxFilesystemNotReadyError(
        options.workspaceId,
        peek.box.filesystemIncarnationReadiness === "transitioning" ? "transitioning" : "missing"
      );
    }
    if (claim.status === "absent") {
      throw new SandboxProvisioningFailedElsewhereError(
        options.workspaceId,
        failedState(peek)
      );
    }
    const takeoverLease = await options.claim.acquireLease(key, ttlSeconds);
    if (takeoverLease) return provisionAsOwner(takeoverLease);
  }
}

// src/sandbox/index.ts
var DEFAULT_SANDBOX_DIRECT_KEY_NAMES = [
  "TCLOUD_SANDBOX_API_KEY",
  "SANDBOX_API_KEY",
  "TANGLE_API_KEY"
];
var DEFAULT_SANDBOX_BASE_URL_NAMES = ["SANDBOX_GATEWAY_URL", "SANDBOX_API_URL"];
function normalizeBaseUrl(value) {
  return value.trim().replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}
function processEnv() {
  return typeof process === "undefined" ? {} : process.env;
}
function directEnvCredentialsAllowed(environment, allow) {
  if (typeof allow === "function") return allow(environment);
  if (typeof allow === "boolean") return allow;
  return environment === "development" || environment === "test";
}
function resolveSandboxBaseUrl(env, names, defaultBaseUrl) {
  for (const name of names) {
    const value2 = trimOrNull(env[name]);
    if (value2) return normalizeBaseUrl(value2);
  }
  const value = trimOrNull(defaultBaseUrl);
  if (value) return normalizeBaseUrl(value);
  throw new Error(
    `Sandbox base URL is required (set one of ${names.join(", ")} or pass defaultBaseUrl).`
  );
}
function resolveDirectSandboxCredentials(env, keyNames, baseUrlNames, defaultBaseUrl) {
  for (const name of keyNames) {
    const apiKey = trimOrNull(env[name]);
    if (!apiKey) continue;
    return {
      apiKey,
      baseUrl: resolveSandboxBaseUrl(env, baseUrlNames, defaultBaseUrl)
    };
  }
  return null;
}
async function resolveSandboxClientCredentials(options = {}) {
  const env = options.env ?? processEnv();
  const environment = options.environment ?? resolveTangleExecutionEnvironment(env);
  const keyNames = options.directKeyNames ?? DEFAULT_SANDBOX_DIRECT_KEY_NAMES;
  const baseUrlNames = options.baseUrlNames ?? DEFAULT_SANDBOX_BASE_URL_NAMES;
  const directAllowed = directEnvCredentialsAllowed(environment, options.allowDirectEnvCredentials);
  const direct = () => directAllowed ? resolveDirectSandboxCredentials(env, keyNames, baseUrlNames, options.defaultBaseUrl) : null;
  if (environment === "development" || environment === "test") {
    const credentials2 = direct();
    if (credentials2) return credentials2;
  }
  const provisioned = await options.provision?.({ environment, env });
  if (provisioned) {
    return {
      apiKey: provisioned.apiKey,
      baseUrl: normalizeBaseUrl(provisioned.baseUrl)
    };
  }
  const credentials = direct();
  if (credentials) return credentials;
  const directHint = directAllowed ? ` or set one of ${keyNames.join(", ")}` : "";
  throw new Error(
    `Sandbox credentials are required for ${environment} (provide a provision callback${directHint}).`
  );
}
function isWellFormedDomainPattern(pattern) {
  if (!pattern || pattern.startsWith(".") || pattern.includes("..")) return false;
  const labels = pattern.split(".");
  if (labels.some((label) => label.length === 0)) return false;
  for (let index = 1; index < labels.length; index += 1) {
    if (labels[index].includes("*")) return false;
  }
  const head = labels[0];
  if (head === "*" || head === "**") return labels.length >= 2;
  return !head.includes("*");
}
var PYPI_EGRESS_DOMAINS = ["pypi.org", "files.pythonhosted.org", "pypi.python.org"];
function buildProductEgressPolicy(publicOrigin, extraDomains = []) {
  const origin = typeof publicOrigin === "string" ? new URL(publicOrigin) : publicOrigin;
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error(`Product egress origin must use http or https: ${origin.protocol}`);
  }
  if (!origin.hostname) throw new Error("Product egress origin must include a hostname");
  const domains = /* @__PURE__ */ new Set([origin.hostname.toLowerCase(), "models.dev"]);
  for (const value of extraDomains) {
    const domain = value.trim().toLowerCase().replace(/\.$/, "");
    if (!domain || domain.includes("://") || domain.includes("/") || domain.includes(":") || !isWellFormedDomainPattern(domain)) {
      throw new Error(`Product egress domain must be a hostname or wildcard: ${value}`);
    }
    domains.add(domain);
  }
  return {
    mode: "strict",
    allowDomains: [...domains],
    includeImplicitDomains: false
  };
}
var DEFAULT_SANDBOX_RESOURCES = {
  image: "universal",
  cpuCores: 2,
  memoryMB: 4096,
  diskGB: 10,
  maxLifetimeSeconds: 86400,
  idleTimeoutSeconds: 3600
};
var _cached = null;
var livenessVerifiedAt = /* @__PURE__ */ new Map();
function getClientFromCreds(creds) {
  const fingerprint = `${creds.apiKey} ${creds.baseUrl}`;
  if (_cached && _cached.fingerprint === fingerprint) return _cached.client;
  const client = new Sandbox({ apiKey: creds.apiKey, baseUrl: creds.baseUrl });
  _cached = { client, fingerprint };
  return client;
}
function getClient(shell) {
  const creds = shell.credentials();
  if (creds && typeof creds.then === "function") {
    throw new Error("getClient: scoped (async) credentials require the async sandbox path");
  }
  if (!creds) throw new Error("sandbox credentials are required (apiKey/baseUrl)");
  return getClientFromCreds(creds);
}
function resetClientCache() {
  _cached = null;
  livenessVerifiedAt.clear();
}
function buildAppToolMcpServers(options) {
  const entries = {};
  for (const { tool, key, description } of options.tools) {
    entries[key] = buildAppToolMcpServer({
      tool,
      baseUrl: options.baseUrl,
      tokenEnvKey: options.tokenEnvKey,
      ctx: options.ctx,
      description,
      headerNames: options.headerNames
    });
  }
  return entries;
}
function emitSandboxActivity(spend, box) {
  if (!spend?.onActivity) return;
  try {
    spend.onActivity({ sandboxId: box.id, at: Date.now() });
  } catch {
  }
}
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
var DEFAULT_SANDBOX_TOOL_BASE_DIR = "/home/agent/tools";
var SAFE_TOOL_SEGMENT = /^[A-Za-z0-9._-]+$/;
function normalizeSandboxToolSegment(value, label) {
  const segment = value.trim();
  if (!segment || segment === "." || segment === ".." || !SAFE_TOOL_SEGMENT.test(segment)) {
    throw new Error(`${label} must contain only letters, numbers, dots, underscores, or hyphens.`);
  }
  return segment;
}
function normalizeSandboxToolDir(value, label) {
  const dir = value.trim().replace(/\/+$/, "");
  if (!dir || !dir.startsWith("/") || dir.includes("\0") || dir.includes("\n")) {
    throw new Error(`${label} must be an absolute sandbox path.`);
  }
  return dir === "" ? "/" : dir;
}
function sandboxToolRootDir(options) {
  const appName = normalizeSandboxToolSegment(options.appName, "sandbox tool appName");
  const baseDir = normalizeSandboxToolDir(
    options.baseDir ?? DEFAULT_SANDBOX_TOOL_BASE_DIR,
    "sandbox tool baseDir"
  );
  return `${baseDir}/${appName}`;
}
function sandboxToolBinDir(options) {
  normalizeSandboxToolSegment(options.appName, "sandbox tool appName");
  if (options.binDir) return normalizeSandboxToolDir(options.binDir, "sandbox tool binDir");
  return `${sandboxToolRootDir(options)}/bin`;
}
function sandboxToolPath(options) {
  const toolName = normalizeSandboxToolSegment(options.toolName, "sandbox tool name");
  return `${sandboxToolBinDir(options)}/${toolName}`;
}
function buildSandboxToolFileMounts(options) {
  return options.tools.map((tool) => {
    const name = normalizeSandboxToolSegment(tool.name, "sandbox tool name");
    return {
      path: sandboxToolPath({ ...options, toolName: name }),
      resource: { kind: "inline", name, content: tool.content },
      executable: tool.executable ?? true
    };
  });
}
function buildSandboxToolBinDirsEnv(apps) {
  if (apps.length === 0) {
    throw new Error(
      "buildSandboxToolBinDirsEnv: name at least one app whose tool bin dir belongs on PATH."
    );
  }
  const binDirs = /* @__PURE__ */ new Set();
  for (const app of apps) {
    const binDir = sandboxToolBinDir(app);
    if (binDir.includes(":")) {
      throw new Error(
        `sandbox tool bin dir ${binDir} contains ':', which separates entries in SANDBOX_TOOL_BIN_DIRS and in PATH. Place the tools under a colon-free directory.`
      );
    }
    binDirs.add(binDir);
  }
  return { SANDBOX_TOOL_BIN_DIRS: [...binDirs].join(":") };
}
function buildSandboxToolBinDirScript(options) {
  return ["set -eu", `mkdir -p ${shellSingleQuote(sandboxToolBinDir(options))}`].join("\n");
}
function buildSandboxToolPathSetupScript(options) {
  return buildSandboxToolBinDirScript(options);
}
async function ensureSandboxToolBinDir(box, options) {
  try {
    const res = await box.exec(buildSandboxToolBinDirScript(options));
    if (res.exitCode !== 0) {
      return fail(
        new Error(
          `ensureSandboxToolBinDir: failed to create the tool bin dir ${sandboxToolBinDir(options)} (exit ${res.exitCode}): ${res.stderr.slice(0, 500)}`
        )
      );
    }
    return ok(void 0);
  } catch (err) {
    return fail(new Error("ensureSandboxToolBinDir: exec failed", { cause: err }));
  }
}
async function runSandboxToolPathSetup(box, options) {
  return ensureSandboxToolBinDir(box, options);
}
function shellPath(path) {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) {
    const rest = path.slice(2);
    return rest ? `"$HOME"/${shellSingleQuote(rest)}` : '"$HOME"';
  }
  return shellSingleQuote(path);
}
function splitDeferredProfileFiles(profile) {
  const files = profile.resources?.files ?? [];
  const deferredFiles = [];
  const keptFiles = [];
  for (const mount of files) {
    if (mount.resource.kind === "inline") deferredFiles.push(mount);
    else keptFiles.push(mount);
  }
  if (deferredFiles.length === 0) return { leanProfile: profile, deferredFiles };
  const leanProfile = {
    ...profile,
    resources: { ...profile.resources ?? {}, files: keptFiles }
  };
  return { leanProfile, deferredFiles };
}
var PROFILE_WRITE_B64_CHUNK_CHARS = 3e3;
var PROFILE_WRITE_MAX_RETRIES = 4;
var PROFILE_WRITE_RETRY_BASE_MS = 250;
var PROFILE_WRITE_RETRY_MAX_MS = 2e3;
var PROFILE_WRITE_EXEC_TIMEOUT_MS = 3e4;
var PROFILE_WRITE_PACE_MS = 150;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var PROFILE_BIN_DIR_RE = /(^|\/)(s?bin)\//;
var ProfileWriteExecTimeoutError = class extends Error {
  constructor(timeoutMs) {
    super(`exec exceeded ${timeoutMs}ms (proxy hang/wedge)`);
    this.name = "ProfileWriteExecTimeoutError";
  }
};
function execWithTimeout(box, cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ProfileWriteExecTimeoutError(timeoutMs));
    }, timeoutMs);
    box.exec(cmd, { timeoutMs }).then(
      (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
var TRANSIENT_EXEC_STATUS_CODES = /* @__PURE__ */ new Set([408, 409, 425, 429, 500, 502, 503, 504]);
var TRANSIENT_EXEC_CODE_RE = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ECONNABORTED)$/i;
var TRANSIENT_EXEC_MESSAGE_RE = /\b(408|409|425|429|500|502|503|504)\b|rate.?limit|too many requests|\bfetch failed\b|network error|connection reset|socket hang up|timed? out|service unavailable|bad gateway|gateway timeout|internal server error|\b(?:sidecar|runtime|exec(?:ution)?|terminal|sandbox|service|command(?:s)?|proxy)\b.{0,80}\bnot ready\b|\bnot ready\b.{0,80}\b(?:sidecar|runtime|exec(?:ution)?|terminal|sandbox|service|command(?:s)?|proxy)\b/i;
var RUNTIME_AUTH_REFRESH_SKEW_MS = 6e4;
function errorStatus(err) {
  const rawStatus = err.status ?? err.statusCode ?? (err.response && typeof err.response === "object" ? err.response.status : void 0);
  if (typeof rawStatus === "number") return rawStatus;
  if (typeof rawStatus === "string" && /^\d+$/.test(rawStatus)) return Number(rawStatus);
  return void 0;
}
function retryAfterMs(err, seen = /* @__PURE__ */ new Set()) {
  if (!err || typeof err !== "object") return void 0;
  if (seen.has(err)) return void 0;
  seen.add(err);
  const e = err;
  if (typeof e.retryAfterMs === "number") return e.retryAfterMs;
  return retryAfterMs(e.cause, seen);
}
function isTransientExecError(err, seen = /* @__PURE__ */ new Set()) {
  if (!err || typeof err !== "object") return false;
  if (seen.has(err)) return false;
  seen.add(err);
  const e = err;
  const status = errorStatus(e);
  if (status !== void 0 && TRANSIENT_EXEC_STATUS_CODES.has(status)) return true;
  if (typeof e.code === "string") {
    if (TRANSIENT_EXEC_CODE_RE.test(e.code)) return true;
    if (/rate.?limit|too.?many.?requests|429|server.?error|service.?unavailable/i.test(e.code)) return true;
  }
  if (typeof e.message === "string" && TRANSIENT_EXEC_MESSAGE_RE.test(e.message)) return true;
  return isTransientExecError(e.cause, seen);
}
function isRuntimeExecAuthError(err, seen = /* @__PURE__ */ new Set()) {
  if (!err || typeof err !== "object") return false;
  if (seen.has(err)) return false;
  seen.add(err);
  const e = err;
  if (errorStatus(e) === 401) return true;
  if (typeof e.code === "string" && /^(AUTH_ERROR|AUTHENTICATION_ERROR|UNAUTHORIZED|UNAUTHENTICATED|ERR_UNAUTHORIZED|ERR_UNAUTHENTICATED|401)$/i.test(e.code)) {
    return true;
  }
  if (typeof e.name === "string" && /^(AuthError|AuthenticationError|UnauthorizedError|UnauthenticatedError|SandboxAuthError)$/i.test(e.name)) {
    return true;
  }
  return isRuntimeExecAuthError(e.cause, seen);
}
function isRuntimeAuthRefreshDenied(err) {
  if (!err || typeof err !== "object") return false;
  return isRuntimeExecAuthError(err) || errorStatus(err) === 403;
}
function transientExecError(err) {
  if (err instanceof ProfileWriteExecTimeoutError) return { retryable: true };
  if (isTransientExecError(err)) return { retryable: true, retryAfterMs: retryAfterMs(err) };
  return { retryable: false };
}
function deferredProfileWriteFailed(stage, name, cause) {
  return new Error(`deferred file write failed on ${stage} box ${name}: ${cause.message}`, { cause });
}
var SandboxEgressPolicyMismatchError = class extends Error {
  stage;
  boxName;
  currentPolicy;
  currentSource;
  desiredPolicy;
  constructor(stage, boxName, currentPolicy, currentSource, desiredPolicy) {
    super(
      `egress policy mismatch on ${stage} box ${boxName}: current ${currentPolicy.mode} policy from ${currentSource} does not explicitly match desired ${desiredPolicy.mode} policy; the existing box was preserved and egress was not updated.`
    );
    this.name = "SandboxEgressPolicyMismatchError";
    this.stage = stage;
    this.boxName = boxName;
    this.currentPolicy = currentPolicy;
    this.currentSource = currentSource;
    this.desiredPolicy = desiredPolicy;
  }
};
var SandboxRuntimeAuthRefreshError = class extends Error {
  constructor(stage, name, detail, cause) {
    super(`${stage} sandbox auth refresh failed for ${name}: ${detail}`, { cause });
    this.name = "SandboxRuntimeAuthRefreshError";
  }
};
var SandboxRecoveryFailedError = class extends Error {
  boxKey;
  stage;
  phase;
  constructor(stage, boxKey, phase, detail, cause) {
    super(
      `${stage} sandbox ${boxKey} failed liveness recovery at ${phase}: ${detail}. The workspace is preserved; pass forceNew to replace the box.`,
      { cause }
    );
    this.name = "SandboxRecoveryFailedError";
    this.boxKey = boxKey;
    this.stage = stage;
    this.phase = phase;
  }
};
function fileApiTarget(mount) {
  if (mount.resource.kind !== "inline") return null;
  let rel;
  if (mount.path.startsWith("~/")) rel = mount.path.slice(2);
  else if (mount.path.startsWith("/home/agent/")) rel = mount.path.slice("/home/agent/".length);
  else if (mount.path.startsWith("/") || mount.path.startsWith("~")) return null;
  else rel = mount.path;
  if (rel.length === 0 || rel.startsWith("/") || rel.split("/").some((seg) => seg === ".." || seg === ".sidecar")) {
    return null;
  }
  return rel;
}
function isExecutableProfileFile(mount) {
  return mount.executable ?? PROFILE_BIN_DIR_RE.test(mount.path);
}
function profileFileMode(mount) {
  return isExecutableProfileFile(mount) ? 493 : void 0;
}
function fileApiSupportsMode(box) {
  const fs = box.fs;
  return fs?.supportsWriteMode === true;
}
async function writeProfileFilesToBox(box, files, options = {}) {
  const execTimeoutMs = options.execTimeoutMs ?? PROFILE_WRITE_EXEC_TIMEOUT_MS;
  const paceMs = options.paceMs ?? PROFILE_WRITE_PACE_MS;
  const maxRetries = options.maxRetries ?? PROFILE_WRITE_MAX_RETRIES;
  const fileApiAvailable = typeof box.fs?.writeMany === "function";
  const modeAwareFileApi = fileApiSupportsMode(box);
  const viaFileApi = [];
  const viaExec = [];
  for (const mount of files) {
    if (mount.resource.kind !== "inline") continue;
    const fileApiPath = fileApiAvailable ? fileApiTarget(mount) : null;
    const executable = isExecutableProfileFile(mount);
    if (fileApiPath !== null && (!executable || modeAwareFileApi)) {
      const mode = profileFileMode(mount);
      viaFileApi.push({
        path: fileApiPath,
        content: mount.resource.content ?? "",
        ...mode !== void 0 ? { mode } : {}
      });
    } else viaExec.push(mount);
  }
  if (viaFileApi.length > 0) {
    try {
      await box.fs.writeMany(viaFileApi, { paceMs, maxRetries });
    } catch (err) {
      return fail(new Error("writeProfileFilesToBox: file-API batch write failed", { cause: err }));
    }
  }
  let execStarted = false;
  const paceAndRetry = async (run, path) => {
    for (let attempt = 0; ; attempt++) {
      if (execStarted && paceMs > 0) await sleep(paceMs);
      execStarted = true;
      try {
        return ok(await run());
      } catch (err) {
        const { retryable, retryAfterMs: retryAfterMs2 } = transientExecError(err);
        if (retryable && attempt < maxRetries) {
          const backoff = Math.min(PROFILE_WRITE_RETRY_BASE_MS * 2 ** attempt, PROFILE_WRITE_RETRY_MAX_MS);
          await sleep(retryAfterMs2 ?? backoff);
          continue;
        }
        return fail(new Error(`writeProfileFilesToBox: exec failed for ${path}`, { cause: err }));
      }
    }
  };
  for (const mount of viaExec) {
    if (mount.resource.kind !== "inline") continue;
    const content = mount.resource.content ?? "";
    const path = mount.path;
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const b64Chunks = [];
    for (let i = 0; i < b64.length; i += PROFILE_WRITE_B64_CHUNK_CHARS) {
      b64Chunks.push(b64.slice(i, i + PROFILE_WRITE_B64_CHUNK_CHARS));
    }
    const expectedSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const dir = path.replace(/\/[^/]*$/, "");
    const executable = isExecutableProfileFile(mount);
    const q = shellPath(path);
    const qb64 = shellPath(`${path}.b64`);
    const qtmp = shellPath(`${path}.tmp`);
    const qpartPrefix = shellPath(`${path}.b64.part.`);
    const step = async (cmd) => {
      const res2 = await paceAndRetry(() => execWithTimeout(box, cmd, execTimeoutMs), path);
      if (!res2.succeeded) return res2;
      const exec = res2.value;
      if (exec.exitCode !== 0) {
        return fail(
          new Error(
            `writeProfileFilesToBox: failed to write ${path} (exit ${exec.exitCode}): ${exec.stderr.slice(0, 500)}`
          )
        );
      }
      return ok(void 0);
    };
    const mkdir = dir && dir !== path ? `mkdir -p ${shellPath(dir)}` : ":";
    let res = await step(mkdir);
    if (!res.succeeded) return res;
    for (let i = 0; i < b64Chunks.length; i++) {
      const slice = b64Chunks[i];
      res = await step(`printf '%s' '${slice}' > ${shellPath(`${path}.b64.part.${i}`)}`);
      if (!res.succeeded) return res;
    }
    const chmod = executable ? `chmod +x ${q} || exit 1; ` : "";
    const checksumMismatch = shellSingleQuote(`writeProfileFilesToBox: checksum mismatch for ${path}`);
    const finalCmd = `expected='${expectedSha256}'; if [ -f ${q} ] && [ "$(sha256sum ${q} | awk '{print $1}')" = "$expected" ]; then ${chmod}rm -f ${qb64} ${qtmp}; i=0; while [ "$i" -lt ${b64Chunks.length} ]; do rm -f ${qpartPrefix}$i; i=$((i+1)); done; exit 0; fi; : > ${qb64} && i=0; while [ "$i" -lt ${b64Chunks.length} ]; do cat ${qpartPrefix}$i >> ${qb64} || exit 1; i=$((i+1)); done && base64 -d < ${qb64} > ${qtmp} && [ "$(sha256sum ${qtmp} | awk '{print $1}')" = "$expected" ] || { echo ${checksumMismatch} >&2; exit 1; }; mv ${qtmp} ${q} && ${executable ? `chmod +x ${q} && ` : ""}[ "$(sha256sum ${q} | awk '{print $1}')" = "$expected" ] || { echo ${checksumMismatch} >&2; exit 1; }; rm -f ${qb64} ${qtmp}; i=0; while [ "$i" -lt ${b64Chunks.length} ]; do rm -f ${qpartPrefix}$i; i=$((i+1)); done`;
    res = await step(finalCmd);
    if (!res.succeeded) return res;
  }
  return ok(void 0);
}
var DEFERRED_CORPUS_HASH_KEY = "agentAppDeferredCorpusHash";
function deferredCorpusHash(files) {
  const norm = files.map((f) => ({
    p: f.path,
    c: f.resource.kind === "inline" ? f.resource.content ?? "" : `ref:${f.resource.kind}`
  })).sort((a, b) => a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(norm), "utf8").digest("hex");
}
async function materializeDeferredFilesForExistingBox(shell, client, box, stage, name, workspaceId, userId, harness) {
  if (!shell.deferProfileFiles) return ok(box);
  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId);
  const buildCtx = {
    workspaceId,
    connectedIntegrationIds,
    ...userId ? { userId } : {}
  };
  const files = await shell.files(buildCtx);
  const fullProfile = shell.profile({ extraFiles: files, harness });
  const { deferredFiles } = splitDeferredProfileFiles(fullProfile);
  if (deferredFiles.length === 0) return ok(box);
  const stampedHash = box.metadata?.[DEFERRED_CORPUS_HASH_KEY];
  if (typeof stampedHash === "string" && stampedHash === deferredCorpusHash(deferredFiles)) return ok(box);
  return writeDeferredFilesWithRuntimeAuthRefresh(client, box, deferredFiles, stage, name);
}
async function listRunning(client, name) {
  try {
    const running = await client.list({ status: "running" });
    return ok(running.find((s) => s.name === name) ?? null);
  } catch (err) {
    return fail(err);
  }
}
async function listStopped(client, name) {
  try {
    const stopped = await client.list({ status: "stopped" });
    return ok(stopped.find((s) => s.name === name) ?? null);
  } catch (err) {
    return fail(err);
  }
}
async function deleteBox(box) {
  try {
    const acknowledgement = await box.delete({ until: "removed" });
    livenessVerifiedAt.delete(box.id);
    if (acknowledgement.removal === "pending") {
      return fail(new Error(`sandbox ${box.id} removal is still pending; retry replacement after removal completes`));
    }
    return ok(void 0);
  } catch (err) {
    return fail(err);
  }
}
var SHELL_PROMPT_BUDGET_HINT = "If this prompt size is a decision you already made at compose time, mirror it on the shell as `promptBudget: { maxSystemPromptBytes, overBudgetReason }` \u2014 the shell gate is the one that sees the profile actually sent.";
var PROVISION_PAYLOAD_MAX_BYTES = 24e4;
var ENV_VALUE_MAX_BYTES = 12e4;
var DEFAULT_PROVISION_TIMEOUT_MS = 12e4;
var ENV_TOTAL_MAX_BYTES = 2e5;
function utf8ByteLength(value) {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value ?? null)).byteLength;
}
function assertProvisionPayloadWithinCap(payload) {
  const total = utf8ByteLength(payload);
  if (total <= PROVISION_PAYLOAD_MAX_BYTES) return;
  const profile = payload.backend?.profile;
  const files = (typeof profile === "string" ? void 0 : profile?.resources?.files) ?? [];
  const breakdown = `profile=${utf8ByteLength(profile ?? null)}B (files=${utf8ByteLength(files)}B), env=${utf8ByteLength(payload.env ?? {})}B, secrets=${utf8ByteLength(payload.secrets ?? [])}B`;
  throw new Error(
    `sandbox provision payload is ${total} bytes \u2014 over the ${PROVISION_PAYLOAD_MAX_BYTES}-byte gate (the platform caps the create body at 256 KiB; an over-cap payload can never create a sandbox). Breakdown: ${breakdown}. Hint: set deferProfileFiles: true or move content to resources.`
  );
}
function assertEnvWithinLimits(env) {
  let total = 0;
  let largest = null;
  for (const [name, value] of Object.entries(env)) {
    const bytes = utf8ByteLength(`${name}=${value}`);
    total += bytes;
    if (!largest || bytes > largest.bytes) largest = { name, bytes };
    if (bytes > ENV_VALUE_MAX_BYTES) {
      throw new Error(
        `sandbox env var ${name} is ${bytes} bytes \u2014 over the ${ENV_VALUE_MAX_BYTES}-byte gate (kernel MAX_ARG_STRLEN is 131072 bytes per env entry; anything larger E2BIGs every exec). Write large content to a file mount or resource instead of an env var.`
      );
    }
  }
  if (total > ENV_TOTAL_MAX_BYTES) {
    const worst = largest ? ` Largest: ${largest.name} (${largest.bytes}B).` : "";
    throw new Error(
      `sandbox env block is ${total} bytes total \u2014 over the ${ENV_TOTAL_MAX_BYTES}-byte gate.${worst} Write large content to a file mount or resource instead of env vars.`
    );
  }
}
async function isBoxAlive(box, probe) {
  if (!probe) return ok(void 0);
  try {
    const alive = await box.exec("echo alive", { timeoutMs: probe.execTimeoutMs ?? 5e3 });
    if (alive.exitCode !== 0 || alive.stdout.trim() !== "alive") {
      return fail(new Error("alive check did not return a successful alive marker"));
    }
    return ok(void 0);
  } catch (cause) {
    return fail(new Error("alive check failed", { cause }));
  }
}
var DEFAULT_LIVENESS_CACHE_TTL_MS = 5e3;
function hasRecentLivenessVerification(box, probe, now = Date.now()) {
  const ttlMs = probe.cacheTtlMs ?? DEFAULT_LIVENESS_CACHE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  const verifiedAt = livenessVerifiedAt.get(box.id);
  if (verifiedAt !== void 0 && now - verifiedAt < ttlMs) return true;
  livenessVerifiedAt.delete(box.id);
  return false;
}
var RUNTIME_CONNECTION_WAIT_MS = 3e4;
var RUNTIME_CONNECTION_POLL_MS = 1e3;
function sandboxRuntimeUrl(box) {
  const connection = box.connection;
  return connection?.sidecarUrl ?? connection?.runtimeUrl;
}
function runtimeAuthExpiresAtMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value.trim() === "") return void 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? void 0 : parsed;
}
function hasFreshRuntimeExecAuth(box, now = Date.now()) {
  const connection = box.connection;
  const token = connection?.authToken ?? connection?.sidecarToken;
  if (!sandboxRuntimeUrl(box) || !token) return false;
  const expiresAt = runtimeAuthExpiresAtMs(
    connection?.authTokenExpiresAt ?? connection?.sidecarTokenExpiresAt
  );
  return expiresAt === void 0 || expiresAt > now + RUNTIME_AUTH_REFRESH_SKEW_MS;
}
function sandboxEdgeFailed(box) {
  const connection = box.connection;
  return connection?.edgeStatus === "failed" || Boolean(connection?.edgeError);
}
async function refreshRuntimeConnection(client, box) {
  let current = box;
  if (sandboxRuntimeUrl(current)) return current;
  const deadline = Date.now() + RUNTIME_CONNECTION_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await current.refresh();
      if (sandboxRuntimeUrl(current)) return current;
      const latest = await client.get(current.id);
      if (latest) current = latest;
      if (sandboxRuntimeUrl(current)) return current;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, RUNTIME_CONNECTION_POLL_MS));
  }
  return current;
}
async function bestEffortRefreshRuntimeExecAuth(client, box, stage, name) {
  let current = box;
  try {
    await current.refresh();
    if (hasFreshRuntimeExecAuth(current)) return ok(current);
  } catch (err) {
    if (isRuntimeAuthRefreshDenied(err)) {
      return fail(
        new SandboxRuntimeAuthRefreshError(
          stage,
          name,
          "runtime exec auth refresh was unauthorized",
          err
        )
      );
    }
  }
  try {
    const latest = await client.get(current.id);
    if (latest) current = latest;
    if (hasFreshRuntimeExecAuth(current)) return ok(current);
  } catch (err) {
    if (isRuntimeAuthRefreshDenied(err)) {
      return fail(
        new SandboxRuntimeAuthRefreshError(
          stage,
          name,
          "runtime exec auth re-fetch was unauthorized",
          err
        )
      );
    }
  }
  return ok(current);
}
async function refreshRuntimeExecAuth(client, box, stage, name) {
  let current = box;
  let lastError;
  const deadline = Date.now() + RUNTIME_CONNECTION_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await current.refresh();
      if (hasFreshRuntimeExecAuth(current)) return ok(current);
      const latest = await client.get(current.id);
      if (latest) current = latest;
      if (hasFreshRuntimeExecAuth(current)) return ok(current);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, RUNTIME_CONNECTION_POLL_MS));
  }
  const detail = sandboxRuntimeUrl(current) ? "runtime exec credentials are missing or expired after refresh" : "runtime connection is missing after refresh";
  return fail(new SandboxRuntimeAuthRefreshError(stage, name, detail, lastError));
}
async function writeDeferredFilesWithRuntimeAuthRefresh(client, box, files, stage, name) {
  let writeBox = box;
  if (!hasFreshRuntimeExecAuth(writeBox)) {
    const refreshed2 = await bestEffortRefreshRuntimeExecAuth(client, writeBox, stage, name);
    if (!refreshed2.succeeded) return fail(refreshed2.error);
    writeBox = refreshed2.value;
  }
  const first = await writeProfileFilesToBox(writeBox, files);
  if (first.succeeded) return ok(writeBox);
  if (!isRuntimeExecAuthError(first.error)) return fail(first.error);
  const refreshed = await refreshRuntimeExecAuth(client, writeBox, stage, name);
  if (!refreshed.succeeded) return fail(refreshed.error);
  const second = await writeProfileFilesToBox(refreshed.value, files);
  if (second.succeeded) return ok(refreshed.value);
  if (!isRuntimeExecAuthError(second.error)) return fail(second.error);
  return fail(
    new SandboxRuntimeAuthRefreshError(
      stage,
      name,
      "runtime exec remained unauthorized after auth refresh",
      second.error
    )
  );
}
async function isReusableBox(box, probe) {
  if (sandboxEdgeFailed(box) || !sandboxRuntimeUrl(box)) {
    livenessVerifiedAt.delete(box.id);
    return fail(new Error(sandboxEdgeFailed(box) ? "runtime edge readiness failed" : "runtime URL is missing"));
  }
  if (!probe) return ok(void 0);
  if (hasRecentLivenessVerification(box, probe)) return ok(void 0);
  const alive = await isBoxAlive(box, probe);
  if (alive.succeeded) livenessVerifiedAt.set(box.id, Date.now());
  else livenessVerifiedAt.delete(box.id);
  return alive;
}
function stoppedBoxResumeError(box, cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const code = error.code;
  if (code === SANDBOX_BACKING_CONTAINER_MISSING_CODE) return cause;
  if (code !== void 0 && code !== "SERVER_ERROR") return cause;
  if (!isLegacySandboxBackingContainerMissingMessage(error.message)) return cause;
  const status = typeof cause === "object" && cause !== null ? cause.status : void 0;
  if (typeof status !== "number" && typeof status !== "string") return cause;
  const wrapped = new Error(error.message, { cause: error });
  wrapped.name = error.name;
  return Object.assign(wrapped, {
    status,
    origin: "sandbox-api",
    endpoint: `/v1/sandboxes/${encodeURIComponent(box.id)}/resume`,
    ...typeof code === "number" || typeof code === "string" ? { code } : {}
  });
}
async function resumeStoppedBox(box, timeoutMs, onProgress) {
  try {
    livenessVerifiedAt.delete(box.id);
    await box.resume({ timeoutMs });
    await box.waitFor("running", { timeoutMs, ...onProgress ? { onProgress } : {} });
    return ok(box);
  } catch (cause) {
    return fail(stoppedBoxResumeError(box, cause));
  }
}
async function recoverUnresponsiveBox(client, box, probe, stage, name, resumeTimeout, onProgress) {
  try {
    await box.stop();
  } catch (err) {
    throw new SandboxRecoveryFailedError(
      stage,
      name,
      "stop",
      "the platform could not stop the box for a state-preserving restart",
      err
    );
  }
  const resumed = await resumeStoppedBox(box, resumeTimeout, onProgress);
  if (!resumed.succeeded) {
    throw new SandboxRecoveryFailedError(
      stage,
      name,
      "resume",
      "the box did not reach running after a state-preserving restart",
      resumed.error
    );
  }
  const recovered = await refreshRuntimeConnection(client, resumed.value);
  const reusable = await isReusableBox(recovered, probe);
  if (!reusable.succeeded) {
    throw new SandboxRecoveryFailedError(
      stage,
      name,
      "probe",
      `the box is still unresponsive after a state-preserving restart: ${reusable.error.message}`,
      reusable.error
    );
  }
  return recovered;
}
async function resolveWorkspaceSandboxClient(shell, workspaceId, userId) {
  const scope = { workspaceId, ...userId ? { userId } : {} };
  const creds = await shell.credentials(scope);
  if (!creds) throw new Error("sandbox credentials are required (apiKey/baseUrl)");
  return {
    scope,
    client: getClientFromCreds(creds),
    name: shell.boxKey ? shell.boxKey(scope) : shell.name(workspaceId)
  };
}
async function peekWorkspaceSandbox(shell, options) {
  const { client, name } = await resolveWorkspaceSandboxClient(shell, options.workspaceId, options.userId);
  const displayName = shell.name(options.workspaceId);
  const boxes = await client.list();
  const match = boxes.find((box) => box.name === name) ?? boxes.find((box) => box.name === displayName);
  if (!match) return { status: "absent" };
  if (match.status !== "running") return { status: "not-running", state: match.status, box: match };
  if (match.filesystemIncarnationReadiness === "transitioning") {
    return { status: "warming", readiness: "transitioning", box: match };
  }
  if (match.filesystemIncarnationReadiness !== "ready") {
    throw new Error(`sandbox ${match.id} is running without filesystem incarnation readiness`);
  }
  return { status: "running", box: match };
}
async function resolveWorkspaceRuntimeEnv(shell, scope) {
  const env = await shell.runtimeEnv?.(scope) ?? {};
  assertEnvWithinLimits(env);
  return env;
}
async function finalizeExistingBox(shell, client, box, stage, name, workspaceId, userId, harness, scope) {
  await assertExistingBoxEgress(box, shell.egressPolicy, shell.migrateEgressPolicy, stage, name);
  const written = await materializeDeferredFilesForExistingBox(
    shell,
    client,
    box,
    stage,
    name,
    workspaceId,
    userId,
    harness
  );
  if (!written.succeeded) {
    throw deferredProfileWriteFailed(stage, name, written.error);
  }
  const finalBox = written.value;
  const runtimeEnv = await resolveWorkspaceRuntimeEnv(shell, scope);
  if (Object.keys(runtimeEnv).length > 0) {
    await finalBox.setRuntimeEnv(runtimeEnv);
  }
  if (shell.bootstrap) {
    const boot = await shell.bootstrap(finalBox, scope);
    if (!boot.succeeded) {
      throw new Error(`bootstrap failed on ${stage} box ${name}`, { cause: boot.error });
    }
  }
  return finalBox;
}
function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonicalizeJson(entry)])
  );
}
function normalizedEgressPolicy(policy) {
  const normalized = { ...policy };
  if (policy.mode === "strict") {
    normalized.allowDomains = [...new Set(
      (policy.allowDomains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean)
    )].sort();
    normalized.includeImplicitDomains = policy.includeImplicitDomains !== false;
  } else {
    delete normalized.allowDomains;
    delete normalized.includeImplicitDomains;
  }
  return JSON.stringify(canonicalizeJson(normalized));
}
function existingBoxEgressError(operation, box, stage, name, cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const status = error.status;
  const suffix = operation === "migration" ? "/egress" : "";
  return Object.assign(
    new Error(`egress policy ${operation} failed on ${stage} box ${name}: ${error.message}`, {
      cause: error
    }),
    {
      origin: "sandbox-api",
      endpoint: `/v1/sandboxes/${encodeURIComponent(box.id)}${suffix}`,
      ...typeof status === "number" || typeof status === "string" ? { status } : {}
    }
  );
}
async function assertExistingBoxEgress(box, desired, migrate, stage, name) {
  if (!desired) return;
  let current;
  try {
    current = await box.egress.get();
  } catch (cause) {
    throw existingBoxEgressError("read", box, stage, name, cause);
  }
  const matchingPolicy = normalizedEgressPolicy(current.policy) === normalizedEgressPolicy(desired);
  const explicitSource = current.source !== "platform";
  if (matchingPolicy && explicitSource) return;
  if (migrate) {
    try {
      await box.egress.update(desired);
      const migrated = await box.egress.get();
      const migratedPolicy = normalizedEgressPolicy(migrated.policy) === normalizedEgressPolicy(desired);
      if (migratedPolicy && migrated.source !== "platform") return;
      current = migrated;
    } catch (cause) {
      throw existingBoxEgressError("migration", box, stage, name, cause);
    }
  }
  throw new SandboxEgressPolicyMismatchError(
    stage,
    name,
    current.policy,
    current.source,
    desired
  );
}
async function ensureWorkspaceSandbox(shell, options) {
  await options.spend?.beforeProvision?.({
    workspaceId: options.workspaceId,
    ...options.userId ? { userId: options.userId } : {}
  });
  const box = await bringUpWorkspaceSandbox(shell, options);
  await observeProvisionedBox(shell, options, box);
  return box;
}
async function observeProvisionedBox(shell, options, box) {
  if (!options.spend?.onProvisioned) return;
  const resources = shell.resources ?? DEFAULT_SANDBOX_RESOURCES;
  try {
    await options.spend.onProvisioned({
      workspaceId: options.workspaceId,
      ...options.userId ? { userId: options.userId } : {},
      sandboxId: box.id,
      boxKey: box.name,
      idleTimeoutSeconds: resources.idleTimeoutSeconds,
      maxLifetimeSeconds: resources.maxLifetimeSeconds,
      at: Date.now()
    });
  } catch {
  }
}
async function bringUpWorkspaceSandbox(shell, options) {
  try {
    return await provisionWorkspaceSandbox(shell, options);
  } catch (err) {
    if (!shell.replaceUnbringableBox) throw err;
    if (options.forceNew) throw err;
    if (!isUnbringableBoxError(err)) throw err;
    return await provisionWorkspaceSandbox(shell, { ...options, forceNew: true });
  }
}
function isUnbringableBoxError(error) {
  if (error instanceof SandboxRecoveryFailedError) return true;
  const diagnostics = serializeSandboxProvisioningError(error);
  return isSandboxHostCapacityFailure(diagnostics) || isSandboxBoxConfigFailure(diagnostics);
}
async function requestSandboxReplacement(recover, failure, label) {
  if (!recover) throw failure.error;
  const recovery = await recover(failure);
  if (!recovery.succeeded) throw recovery.error;
  if (!recovery.value) throw failure.error;
  const replacementBoxKey = recovery.value.replacementBoxKey.trim();
  if (!replacementBoxKey || replacementBoxKey === failure.boxKey) {
    throw new Error(
      `${label} must return a fresh replacement box key for ${failure.boxKey}`,
      { cause: failure.error }
    );
  }
  return { ...recovery.value, replacementBoxKey };
}
async function requestMissingSandboxReplacement(shell, failure) {
  if (failure.error instanceof SandboxRecoveryFailedError && failure.error.phase === "probe") {
    throw failure.error;
  }
  const diagnostics = serializeSandboxProvisioningError(failure.error);
  if (!isSandboxApiSandboxMissingFailure(diagnostics)) throw failure.error;
  return requestSandboxReplacement(
    shell.recoverMissingSandbox,
    failure,
    "missing sandbox recovery"
  );
}
async function provisionWorkspaceSandbox(shell, options) {
  const execTimeoutMs = shell.livenessProbe?.execTimeoutMs;
  if (execTimeoutMs !== void 0 && (!Number.isInteger(execTimeoutMs) || execTimeoutMs < 100 || execTimeoutMs > 6e5)) {
    throw new Error("livenessProbe.execTimeoutMs must be an integer between 100 and 600000");
  }
  const { workspaceId, userId, harness, forceNew, onProgress, billingOwnerId } = options;
  const resolved = await resolveWorkspaceSandboxClient(shell, workspaceId, userId);
  const { scope, client } = resolved;
  let name = resolved.name;
  let recoveryRestore;
  let replacementRequested = false;
  const resources = shell.resources ?? DEFAULT_SANDBOX_RESOURCES;
  const resumeTimeout = shell.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
  let existing = await listRunning(client, name);
  if (forceNew && existing.succeeded && !existing.value) {
    existing = await listStopped(client, name);
  }
  if (forceNew && !existing.succeeded) throw existing.error;
  if (existing.succeeded && existing.value) {
    const found = existing.value;
    if (forceNew) {
      const dropped = await deleteBox(found);
      if (!dropped.succeeded) {
        throw new Error(`forceNew: sandbox ${name} could not be deleted`, { cause: dropped.error });
      }
    } else if (found.metadata?.harness === harness) {
      try {
        const ready = await refreshRuntimeConnection(client, found);
        if ((await isReusableBox(ready, shell.livenessProbe)).succeeded) {
          return await finalizeExistingBox(shell, client, ready, "reused", name, workspaceId, userId, harness, scope);
        }
        const recovered = await recoverUnresponsiveBox(
          client,
          ready,
          shell.livenessProbe,
          "reused",
          name,
          resumeTimeout,
          onProgress
        );
        return await finalizeExistingBox(shell, client, recovered, "reused", name, workspaceId, userId, harness, scope);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const recovery = await requestMissingSandboxReplacement(shell, {
          box: found,
          error,
          scope,
          boxKey: name,
          stage: "reused"
        });
        name = recovery.replacementBoxKey;
        recoveryRestore = recovery.restore;
        replacementRequested = true;
      }
    } else {
      const dropped = await deleteBox(found);
      if (!dropped.succeeded) {
        throw new Error(
          `sandbox ${name} (was ${String(found.metadata?.harness ?? "unknown")}, want ${harness}) could not be deleted`,
          { cause: dropped.error }
        );
      }
    }
  }
  if (!replacementRequested && !forceNew && shell.resumeStopped !== false) {
    const stopped = await listStopped(client, name);
    if (!stopped.succeeded) throw stopped.error;
    if (stopped.value) {
      const resumed = await resumeStoppedBox(stopped.value, resumeTimeout, onProgress);
      if (!resumed.succeeded) {
        const recovery = await requestSandboxReplacement(
          shell.recoverStoppedSandbox,
          { box: stopped.value, error: resumed.error, scope, boxKey: name },
          "stopped sandbox recovery"
        );
        name = recovery.replacementBoxKey;
        recoveryRestore = recovery.restore;
      } else {
        try {
          const box2 = await refreshRuntimeConnection(client, resumed.value);
          if ((await isReusableBox(box2, shell.livenessProbe)).succeeded) {
            return await finalizeExistingBox(shell, client, box2, "resumed", name, workspaceId, userId, harness, scope);
          }
          const recovered = await recoverUnresponsiveBox(
            client,
            box2,
            shell.livenessProbe,
            "resumed",
            name,
            resumeTimeout,
            onProgress
          );
          return await finalizeExistingBox(shell, client, recovered, "resumed", name, workspaceId, userId, harness, scope);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          const recovery = await requestMissingSandboxReplacement(shell, {
            box: stopped.value,
            error,
            scope,
            boxKey: name,
            stage: "resumed"
          });
          name = recovery.replacementBoxKey;
          recoveryRestore = recovery.restore;
        }
      }
    }
  }
  const connectedIntegrationIds = await shell.connectedIntegrationIds(workspaceId);
  const buildCtx = {
    workspaceId,
    connectedIntegrationIds,
    ...userId ? { userId } : {}
  };
  const [secrets, creationEnv, runtimeEnv, files] = await Promise.all([
    shell.secrets(workspaceId),
    shell.env(buildCtx),
    resolveWorkspaceRuntimeEnv(shell, scope),
    shell.files(buildCtx)
  ]);
  const env = { ...creationEnv, ...runtimeEnv };
  const fullProfile = shell.profile({ extraFiles: files, harness });
  const { leanProfile, deferredFiles } = shell.deferProfileFiles ? splitDeferredProfileFiles(fullProfile) : { leanProfile: fullProfile, deferredFiles: [] };
  const profile = leanProfile;
  const role = userId && shell.permissionRole ? shell.permissionRole("developer") : void 0;
  let model = shell.backendModelAtCreate ? requireTransportableModel(resolveModelSelection(shell.provider), `backendModelAtCreate for ${name}`) : void 0;
  if (model && shell.childKeyMint && model.provider === "openai-compat") {
    const minted = await shell.childKeyMint(scope);
    if (minted.succeeded) model = { ...model, apiKey: minted.value };
    else {
      console.error(
        `[sandbox] childKeyMint failed for ${workspaceId}; using parent key:`,
        minted.error.message
      );
    }
  }
  const storage = shell.storage?.(buildCtx);
  const restore = recoveryRestore === void 0 ? shell.restore?.(buildCtx) : recoveryRestore;
  const payload = {
    name,
    image: resources.image,
    // Stamp the deferred-corpus hash so a later REUSE can skip re-writing an
    // unchanged skill corpus (materializeDeferredFilesForExistingBox reads it).
    metadata: {
      ...shell.metadata(harness),
      ...deferredFiles.length > 0 ? { [DEFERRED_CORPUS_HASH_KEY]: deferredCorpusHash(deferredFiles) } : {}
    },
    idempotencyKey: name,
    // Passed through untyped (the SDK payload type predates it); the platform
    // authz-gates it server-side and ignores it when unsupported.
    ...billingOwnerId ? { billingOwnerId } : {},
    ...userId ? { permissions: { initialUsers: [{ userId, role }] } } : {},
    env,
    secrets,
    backend: { type: harness, profile, ...model ? { model } : {} },
    ...storage ? { storage } : {},
    ...restore ? restore : {},
    ...shell.egressPolicy ? { egressPolicy: shell.egressPolicy } : {},
    ...shell.cwd !== void 0 ? { cwd: shell.cwd } : {},
    ...shell.webTerminalEnabled ? { webTerminalEnabled: true } : {},
    maxLifetimeSeconds: resources.maxLifetimeSeconds,
    idleTimeoutSeconds: resources.idleTimeoutSeconds,
    resources: {
      cpuCores: resources.cpuCores,
      memoryMB: resources.memoryMB,
      diskGB: resources.diskGB
    }
  };
  assertEnvWithinLimits(env);
  assertProfilePromptWithinBudget(
    profile,
    shell.promptBudget ?? {},
    `provision profile systemPrompt for ${name}`,
    SHELL_PROMPT_BUDGET_HINT
  );
  assertProvisionPayloadWithinCap(payload ?? {});
  let box = await client.create(payload);
  await box.waitFor("running", {
    timeoutMs: shell.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS,
    ...onProgress ? { onProgress } : {}
  });
  box = await refreshRuntimeConnection(client, box);
  if (deferredFiles.length > 0) {
    const written = await writeProfileFilesToBox(box, deferredFiles);
    if (!written.succeeded) {
      throw deferredProfileWriteFailed("new", name, written.error);
    }
  }
  if (shell.bootstrap) {
    const boot = await shell.bootstrap(box, scope);
    if (!boot.succeeded) {
      throw new Error(`bootstrap failed on new box ${name}`, { cause: boot.error });
    }
  }
  return box;
}
function historyTranscript(history) {
  return history.map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.content}`).join("\n\n");
}
function flattenHistory(message, history) {
  if (!history?.length) return message;
  return `${historyTranscript(history)}

User: ${message}`;
}
function mergeHistoryIntoParts(parts, history) {
  if (!history?.length) return parts;
  const textIndex = parts.findIndex((part) => part.type === "text");
  if (textIndex === -1) {
    throw new Error("mergeHistoryIntoParts requires at least one text part to carry the history");
  }
  const textPart = parts[textIndex];
  const merged = [...parts];
  merged[textIndex] = { ...textPart, text: `${historyTranscript(history)}

User: ${textPart.text}` };
  return merged;
}
function mergeExtraMcp(appToolMcp, baseProfileMcp, extra) {
  for (const key of Object.keys(extra ?? {})) {
    if (key in appToolMcp || key in baseProfileMcp) {
      throw new Error(`extraMcp key '${key}' collides with an existing profile MCP server`);
    }
  }
  return { ...appToolMcp, ...extra ?? {} };
}
function attachReasoningEffort(profile, _harness, effort) {
  if (!effort || effort === "auto") return profile;
  return {
    ...profile,
    model: {
      ...profile.model,
      reasoningEffort: effort
    }
  };
}
function positiveSafeInteger(value, field) {
  if (value === void 0) return void 0;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}
function lowerCeiling(current, requested) {
  if (current === void 0) return requested;
  if (requested === void 0) return current;
  return Math.min(current, requested);
}
function applyPromptTokenLimits(profile, limits) {
  const requestedVisible = positiveSafeInteger(
    limits.maxVisibleOutputTokens,
    "maxVisibleOutputTokens"
  );
  const requestedReasoning = positiveSafeInteger(
    limits.maxReasoningTokens,
    "maxReasoningTokens"
  );
  const requestedTotal = positiveSafeInteger(
    limits.maxTotalOutputTokens,
    "maxTotalOutputTokens"
  );
  if (requestedVisible === void 0 && requestedReasoning === void 0 && requestedTotal === void 0) return profile;
  const maxTotalOutputTokens = lowerCeiling(
    profile.model?.maxTotalOutputTokens,
    requestedTotal
  );
  let maxVisibleOutputTokens = lowerCeiling(
    profile.model?.maxVisibleOutputTokens,
    requestedVisible
  );
  let maxReasoningTokens = lowerCeiling(
    profile.model?.maxReasoningTokens,
    requestedReasoning
  );
  if (maxTotalOutputTokens !== void 0) {
    if (maxVisibleOutputTokens !== void 0) {
      maxVisibleOutputTokens = Math.min(maxVisibleOutputTokens, maxTotalOutputTokens);
    }
    if (maxReasoningTokens !== void 0) {
      maxReasoningTokens = Math.min(maxReasoningTokens, maxTotalOutputTokens);
    }
  }
  return {
    ...profile,
    model: {
      ...profile.model ?? {},
      ...maxVisibleOutputTokens !== void 0 ? { maxVisibleOutputTokens } : {},
      ...maxReasoningTokens !== void 0 ? { maxReasoningTokens } : {},
      ...maxTotalOutputTokens !== void 0 ? { maxTotalOutputTokens } : {}
    }
  };
}
function cachedSandboxPromptEvents(cached, fallbackExecutionId) {
  const cachedResult = cached.result;
  const executionId = typeof cachedResult.executionId === "string" && cachedResult.executionId.trim() ? cachedResult.executionId : fallbackExecutionId;
  const finalText = typeof cachedResult.finalText === "string" ? cachedResult.finalText : typeof cachedResult.response === "string" ? cachedResult.response : typeof cachedResult.text === "string" ? cachedResult.text : void 0;
  return [
    {
      type: "result",
      data: {
        ...cachedResult,
        ...finalText !== void 0 && cachedResult.finalText === void 0 ? { finalText } : {},
        sessionId: cached.sessionId,
        executionId
      }
    },
    {
      type: "done",
      data: {
        sessionId: cached.sessionId,
        executionId,
        status: "completed",
        outcome: { type: "completed" }
      }
    }
  ];
}
async function* detachedSandboxPromptEvents(box, prompt, options, backend) {
  const sessionId = options.sessionId?.trim();
  const executionId = options.executionId?.trim();
  if (!sessionId || !executionId) {
    throw new Error("streamSandboxPrompt detach requires stable sessionId and executionId");
  }
  const lastEventId = options.lastEventId?.trim() || void 0;
  const turnId = options.turnId?.trim() || executionId;
  const admission = lastEventId ? null : await box.dispatchPrompt(prompt, {
    sessionId,
    executionId,
    turnId,
    backend,
    ...options.requireVisibleAssistantOutput !== void 0 ? { requireVisibleAssistantOutput: options.requireVisibleAssistantOutput } : {},
    ...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {}
  });
  const admittedExecutionId = admission?.executionId ?? executionId;
  if (!admittedExecutionId) {
    throw new Error(`detached Sandbox dispatch for ${sessionId} returned no executionId`);
  }
  if (admission?.dispatched === false) {
    const cached = await box.findCompletedTurn(turnId, { sessionId });
    if (cached) {
      yield* cachedSandboxPromptEvents(cached, admittedExecutionId);
      return;
    }
  }
  yield* box.streamPrompt("", {
    sessionId: admission?.sessionId ?? sessionId,
    executionId: admittedExecutionId,
    lastEventId: lastEventId || "0",
    ...options.signal ? { signal: options.signal } : {}
  });
}
function optionalNonNegativeNumber(value, field) {
  if (value === void 0) return void 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`sandbox gateway event ${field} is invalid`);
  }
  return value;
}
function optionalNonNegativeSafeInteger(value, field) {
  const number = optionalNonNegativeNumber(value, field);
  if (number !== void 0 && !Number.isSafeInteger(number)) {
    throw new Error(`sandbox gateway event ${field} is invalid`);
  }
  return number;
}
function optionalGatewayRecord(value, field) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`sandbox gateway event ${field} is invalid`);
  }
  return value;
}
function adaptSandboxStream(events) {
  return (async function* () {
    for await (const rawEvent of events) {
      if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) continue;
      const event = rawEvent;
      const rawData = event.data;
      const dataRecord = rawData && typeof rawData === "object" && !Array.isArray(rawData) ? rawData : null;
      const data = {};
      const rawPart = dataRecord?.part;
      if (rawPart && typeof rawPart === "object" && !Array.isArray(rawPart)) {
        const part = rawPart;
        const normalizedPart = {};
        if (typeof part.type === "string") normalizedPart.type = part.type;
        if (typeof part.text === "string") normalizedPart.text = part.text;
        if (Object.keys(normalizedPart).length > 0) data.part = normalizedPart;
      }
      if (typeof dataRecord?.delta === "string") data.delta = dataRecord.delta;
      if (typeof dataRecord?.finalText === "string") data.finalText = dataRecord.finalText;
      if (typeof dataRecord?.code === "string") data.code = dataRecord.code;
      if (typeof dataRecord?.message === "string") data.message = dataRecord.message;
      const rawDetails = dataRecord?.details;
      if (rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)) {
        data.details = rawDetails;
      }
      const usageRecord = optionalGatewayRecord(dataRecord?.usage, "usage");
      if (usageRecord) {
        const usage = {};
        for (const field of [
          "inputTokens",
          "outputTokens",
          "reasoningTokens",
          "toolTokens",
          "toolCallCount"
        ]) {
          const value = optionalNonNegativeSafeInteger(usageRecord[field], `usage.${field}`);
          if (value !== void 0) usage[field] = value;
        }
        const providerCostUsd = optionalNonNegativeNumber(
          usageRecord.providerCostUsd,
          "usage.providerCostUsd"
        );
        if (providerCostUsd !== void 0) usage.providerCostUsd = providerCostUsd;
        if (usageRecord.budgetEnforced !== void 0) {
          if (typeof usageRecord.budgetEnforced !== "boolean") {
            throw new Error("sandbox gateway event usage.budgetEnforced is invalid");
          }
          usage.budgetEnforced = usageRecord.budgetEnforced;
        }
        if (Object.keys(usage).length > 0) data.usage = usage;
      }
      const toolRecord = optionalGatewayRecord(dataRecord?.tool, "tool");
      if (toolRecord) {
        const tool = {};
        if (typeof toolRecord.name === "string") tool.name = toolRecord.name;
        const inputTokens = optionalNonNegativeSafeInteger(toolRecord.inputTokens, "tool.inputTokens");
        const outputTokens = optionalNonNegativeSafeInteger(toolRecord.outputTokens, "tool.outputTokens");
        if (inputTokens !== void 0) tool.inputTokens = inputTokens;
        if (outputTokens !== void 0) tool.outputTokens = outputTokens;
        if (Object.keys(tool).length > 0) data.tool = tool;
      }
      const reasoningRecord = optionalGatewayRecord(dataRecord?.reasoning, "reasoning");
      if (reasoningRecord) {
        const tokens = optionalNonNegativeSafeInteger(
          reasoningRecord.tokens,
          "reasoning.tokens"
        );
        if (tokens !== void 0) data.reasoning = { tokens };
      }
      const rawInputRequired = dataRecord?.inputRequired;
      if (rawInputRequired && typeof rawInputRequired === "object" && !Array.isArray(rawInputRequired)) {
        const prompt = rawInputRequired.prompt;
        data.inputRequired = typeof prompt === "string" ? { prompt } : {};
      }
      yield {
        ...typeof event.type === "string" ? { type: event.type } : {},
        ...Object.keys(data).length > 0 ? { data } : {}
      };
    }
  })();
}
async function resolveSandboxPromptBackend(shell, options, operation = "sandbox prompt") {
  const initialHarness = options.harness ?? options.profile?.harness ?? DEFAULT_HARNESS;
  if (!isHarness(initialHarness)) throw new Error(`Unsupported sandbox harness: ${initialHarness}`);
  const extraMcp = mergeExtraMcp(
    options.appToolMcp ?? {},
    options.profile?.mcp ?? options.baseProfileMcp ?? {},
    options.extraMcp
  );
  const compose = (harness2) => {
    if (!shell.profile) throw new Error(`${operation}: supply a profile or a shell profile composer`);
    return shell.profile({ systemPrompt: options.systemPrompt, extraMcp, harness: harness2 });
  };
  let fullProfile = options.profile ? mergeAgentProfiles(options.profile, {
    ...options.systemPrompt !== void 0 ? { prompt: { systemPrompt: options.systemPrompt } } : {},
    ...Object.keys(extraMcp).length > 0 ? { mcp: extraMcp } : {}
  }) : compose(initialHarness);
  const harness = options.harness ?? fullProfile.harness ?? DEFAULT_HARNESS;
  if (!isHarness(harness)) throw new Error(`Unsupported sandbox harness: ${harness}`);
  if (!options.profile && harness !== initialHarness) fullProfile = compose(harness);
  const explicitModel = trimOrNull(options.model);
  const profileModel = trimOrNull(fullProfile.model?.default);
  const profileProvider = profileModel && (!explicitModel || explicitModel === profileModel) ? trimOrNull(fullProfile.model?.provider) : null;
  const model = requireTransportableModel(
    resolveModelSelection({
      ...shell.provider,
      providerName: trimOrNull(shell.provider?.providerName) ?? profileProvider ?? void 0
    }, {
      model: explicitModel ?? profileModel ?? void 0,
      modelApiKey: options.modelApiKey
    }),
    operation
  );
  if (model) assertHarnessModelCompatible(harness, {
    ...model,
    provider: profileProvider ?? model.provider
  });
  const selectedProfile = {
    ...fullProfile,
    harness,
    // The materializer compares the profile and transport as provider-qualified
    // identities. Authored provider evidence has already served preflight above.
    ...model ? { model: { ...fullProfile.model, provider: model.provider, default: model.model } } : {}
  };
  const executionProfile = shell.deferProfileFiles && !options.profile ? splitDeferredProfileFiles(selectedProfile).leanProfile : selectedProfile;
  const profile = applyPromptTokenLimits(
    attachReasoningEffort(executionProfile, harness, options.effort),
    {
      maxVisibleOutputTokens: options.maxOutputTokens,
      maxReasoningTokens: options.maxReasoningTokens,
      maxTotalOutputTokens: options.maxTotalOutputTokens
    }
  );
  assertProfilePromptWithinBudget(
    profile,
    shell.promptBudget ?? {},
    `${operation} profile systemPrompt`,
    SHELL_PROMPT_BUDGET_HINT
  );
  if (options.onProfileResolved) {
    options.onProfileResolved(await fingerprintAgentProfile(profile, { model: model?.model, harness }));
  }
  return {
    type: harness,
    profile,
    ...model ? { model } : {},
    ...options.interactions ? { interactions: options.interactions } : {}
  };
}
async function* streamSandboxPrompt(shell, box, message, options) {
  const backend = await resolveSandboxPromptBackend(shell, options ?? {}, "streamSandboxPrompt");
  const prompt = typeof message === "string" ? flattenHistory(message, options?.history) : mergeHistoryIntoParts(message, options?.history);
  const stream = options?.detach ? detachedSandboxPromptEvents(box, prompt, options, backend) : box.streamPrompt(prompt, {
    sessionId: options?.sessionId,
    executionId: options?.executionId,
    turnId: options?.turnId,
    lastEventId: options?.lastEventId,
    ...options?.signal ? { signal: options.signal } : {},
    ...options?.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
    ...options?.requireVisibleAssistantOutput !== void 0 ? { requireVisibleAssistantOutput: options.requireVisibleAssistantOutput } : {},
    backend
  });
  emitSandboxActivity(options?.spend, box);
  let severedFinishReason = null;
  try {
    for await (const event of stream) {
      const step = classifySeveredStream(event);
      if (step) severedFinishReason = step.kind === "step-finish" && step.severed ? step.reason : null;
      if (severedFinishReason && isTerminalPromptEvent(event)) {
        throw new Error(`sandbox model stream severed mid-turn (reason="${severedFinishReason}")`);
      }
      if (options?.disallowQuestions) {
        const q = detectInteractiveQuestion(event);
        if (q) {
          throw new Error(`sandbox agent asked an interactive question during an autonomous run: ${q}`);
        }
      }
      yield event;
    }
  } finally {
    emitSandboxActivity(options?.spend, box);
  }
  if (severedFinishReason) {
    throw new Error(`sandbox model stream severed mid-turn (reason="${severedFinishReason}")`);
  }
}
function textPartId(part, fallback) {
  for (const key of ["id", "partId", "messagePartId"]) {
    const value = part?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}
function dispatchedPromptTexts(message, history) {
  const raw = typeof message === "string" ? message : message.find((part) => part.type === "text")?.text ?? "";
  return [...new Set([raw, flattenHistory(raw, history)].map((text) => text.trim()))].filter(Boolean);
}
function lastNonPromptTextPart(parts, promptTexts) {
  const values = Array.from(parts.values()).map((value) => value.trim()).filter((value) => value && !promptTexts.includes(value));
  return values.at(-1) ?? "";
}
async function collectSandboxPromptText(events, message, history) {
  let finalText = "";
  const textParts = /* @__PURE__ */ new Map();
  let anonymousTextPart = 0;
  for await (const rawEvent of events) {
    const event = rawEvent;
    if (!event.type) continue;
    if (event.type === "message.part.updated") {
      const part = event.data?.part;
      const delta = typeof event.data?.delta === "string" ? event.data.delta : null;
      if (String(part?.type ?? "") === "text") {
        const partId = textPartId(part, delta ? "delta" : `text-${anonymousTextPart++}`);
        if (delta) textParts.set(partId, `${textParts.get(partId) ?? ""}${delta}`);
        else if (typeof part?.text === "string") textParts.set(partId, part.text);
      }
    } else if (event.type === "result") {
      const resultText = typeof event.data?.finalText === "string" ? event.data.finalText : null;
      if (resultText?.trim()) finalText = resultText;
    }
  }
  return finalText || lastNonPromptTextPart(textParts, dispatchedPromptTexts(message, history));
}
async function runSandboxPrompt(shell, box, message, options) {
  return collectSandboxPromptText(
    streamSandboxPrompt(shell, box, message, options),
    message,
    options?.history
  );
}
async function syncSandboxMemberAdd(box, seam, userId, role) {
  try {
    await box.permissions.add({ userId, role: seam.roleToSandboxRole(role) });
    return ok(void 0);
  } catch (err) {
    return fail(err);
  }
}
async function syncSandboxMemberRemove(box, userId) {
  try {
    await box.permissions.remove(userId, { preserveHomeDir: true });
    return ok(void 0);
  } catch (err) {
    return fail(err);
  }
}
async function syncSandboxMemberRole(box, seam, userId, role) {
  try {
    await box.permissions.update(userId, { role: seam.roleToSandboxRole(role) });
    return ok(void 0);
  } catch (err) {
    return fail(err);
  }
}
function secretStoreFromClient(shell) {
  const client = getClient(shell);
  return {
    create: async (name, value) => {
      await client.secrets.create(name, value);
    },
    // The API has no replace route, so a replacement is a delete followed by a
    // create. That pair is NOT atomic: if the create fails, the secret is left
    // deleted rather than at its previous value. `storeSecret` reports that
    // state instead of reporting a generic write failure, because a caller
    // retrying a lost secret needs to know it is now absent.
    update: async (name, value) => {
      await client.secrets.delete(name);
      await client.secrets.create(name, value);
    },
    delete: async (name) => {
      await client.secrets.delete(name);
    }
  };
}
async function storeSecret(store, name, value) {
  try {
    await store.create(name, value);
    return ok(void 0);
  } catch {
    try {
      await store.update(name, value);
      return ok(void 0);
    } catch (err) {
      return fail(
        new Error(
          `Failed to store sandbox secret ${name}. A replacement deletes before it creates, so ${name} may now be absent rather than holding its previous value.`,
          { cause: err }
        )
      );
    }
  }
}
async function deleteSecret(store, name) {
  try {
    await store.delete(name);
    return ok(void 0);
  } catch (err) {
    return fail(err);
  }
}
async function mintSandboxScopedToken(box, options) {
  try {
    const token = await box.mintScopedToken(options);
    return ok({ token: token.token, expiresAt: token.expiresAt, scope: token.scope });
  } catch (err) {
    return fail(err);
  }
}
async function driveSandboxTurn(shell, box, message, options) {
  const backend = await resolveSandboxPromptBackend(shell, options, "driveSandboxTurn");
  const prompt = typeof message === "string" ? flattenHistory(message, options.history) : mergeHistoryIntoParts(message, options.history);
  try {
    const drive = await box.driveTurn(prompt, {
      sessionId: options.sessionId,
      ...options.turnId ? { turnId: options.turnId } : {},
      ...options.wallCapMs !== void 0 ? { wallCapMs: options.wallCapMs } : {},
      ...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
      ...options.signal ? { signal: options.signal } : {},
      // Sandbox 0.37 drives through the session message lane, so a gateway
      // consumer can handle these events. Callers without one should omit
      // interactions so the run stays unattended.
      backend
    });
    emitSandboxActivity(options.spend, box);
    return ok(drive);
  } catch (err) {
    return fail(err);
  }
}
var SEVERED_FINISH_REASONS = /* @__PURE__ */ new Set(["error", "other", "unknown"]);
function asPlainRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function classifySeveredStream(event) {
  const root = asPlainRecord(event);
  if (!root || root.type !== "message.part.updated") return null;
  const body = asPlainRecord(root.properties) ?? asPlainRecord(root.data) ?? root;
  const part = asPlainRecord(body.part);
  if (!part) return null;
  if (part.type === "step-start") return { kind: "step-start" };
  if (part.type !== "step-finish") return null;
  const reason = typeof part.reason === "string" && part.reason ? part.reason : "unknown";
  return { kind: "step-finish", reason, severed: SEVERED_FINISH_REASONS.has(reason) };
}
function isTerminalPromptEvent(event) {
  const t = asPlainRecord(event)?.type;
  return t === "result" || t === "done";
}
function detectInteractiveQuestion(event) {
  const root = asPlainRecord(event);
  if (!root) return null;
  const type = typeof root.type === "string" ? root.type : void 0;
  const data = asPlainRecord(root.data);
  const props = asPlainRecord(root.properties);
  const body = props ?? data ?? root;
  if (type === "question.asked" || type === "question") return firstQuestionText(body);
  if (type === "interaction" && body.kind === "question") return firstQuestionText(body);
  const part = asPlainRecord(data?.part) ?? asPlainRecord(body.part);
  const tool = typeof part?.tool === "string" && part.tool || typeof part?.name === "string" && part.name || typeof body.tool === "string" && body.tool || void 0;
  const isQ = type === "message.part.updated" && (tool === "question" || asPlainRecord(part)?.type === "question");
  if (!isQ) return null;
  const state = asPlainRecord(asPlainRecord(part)?.state);
  return firstQuestionText(asPlainRecord(state?.input) ?? state ?? part ?? body);
}
function firstQuestionText(value) {
  const arr = Array.isArray(value?.questions) ? value.questions : Array.isArray(asPlainRecord(value?.input)?.questions) ? asPlainRecord(value.input).questions : [];
  const first = asPlainRecord(arr[0]);
  const q = typeof first?.question === "string" && first.question || typeof first?.prompt === "string" && first.prompt || void 0;
  return q ?? "interactive question";
}

export {
  resolveModelSelection,
  resolveModel,
  SandboxModelResolutionError,
  requireTransportableModel,
  shellQuote,
  statSandboxFileSize,
  readSandboxBinaryBytes,
  EGRESS_PROXY_RECOVERY_REQUIRED,
  EGRESS_PROXY_RECOVERY_PHASE,
  WORKSPACE_SANDBOX_MISSING,
  WORKSPACE_SANDBOX_HOST_EXHAUSTED,
  WORKSPACE_SANDBOX_UNRECOVERABLE,
  WORKSPACE_SANDBOX_SNAPSHOT_MAX_AGE_MS,
  WorkspaceSandboxRecoveryRequiredError,
  isEgressProxyRecoveryRequiredError,
  isWorkspaceSandboxSnapshotRestoreError,
  assessWorkspaceSandboxSnapshot,
  isWorkspaceSandboxRecoveryAction,
  isWorkspaceSandboxRecoveryCode,
  isWorkspaceSandboxRecoveryState,
  workspaceSandboxRecoveryFromError,
  workspaceSandboxRecoveryMessage,
  workspaceSandboxRecoveryRecommendedActions,
  workspaceSandboxRecoveryDiagnostic,
  preferredWorkspaceSandboxRecoveryBoxKey,
  shouldRestoreWorkspaceSandboxRecovery,
  createWorkspaceSandboxRecoveryManager,
  WORKSPACE_SANDBOX_RECOVERY_ACTIONS,
  WORKSPACE_SANDBOX_RECOVERY_CODES,
  serializeSandboxProvisioningError,
  formatSandboxProvisioningSupportDetails,
  isSandboxAuthFailure,
  isSandboxApiBearerAuthFailure,
  SANDBOX_BACKING_CONTAINER_MISSING_CODE,
  isSandboxApiSandboxMissingFailure,
  isSandboxHostCapacityFailure,
  formatSandboxProvisioningUserMessage,
  createWorkspaceSandboxManager,
  createSandboxTerminalConnectionRoute,
  sandboxPrewarmClaimKey,
  createSandboxPrewarmer,
  DEFAULT_PREWARM_CLAIM_TABLE,
  PREWARM_CLAIM_TABLE_DDL,
  createD1PrewarmClaimStore,
  DEFAULT_FOREGROUND_PROVISION_CLAIM_TTL_SECONDS,
  DEFAULT_FOREGROUND_PROVISION_POLL_INTERVAL_MS,
  SandboxProvisioningFailedElsewhereError,
  SandboxFilesystemNotReadyError,
  runForegroundSandboxSingleFlight,
  resolveSandboxClientCredentials,
  PYPI_EGRESS_DOMAINS,
  buildProductEgressPolicy,
  DEFAULT_SANDBOX_RESOURCES,
  getClient,
  resetClientCache,
  buildAppToolMcpServers,
  sandboxToolRootDir,
  sandboxToolBinDir,
  sandboxToolPath,
  buildSandboxToolFileMounts,
  buildSandboxToolBinDirsEnv,
  buildSandboxToolBinDirScript,
  buildSandboxToolPathSetupScript,
  ensureSandboxToolBinDir,
  runSandboxToolPathSetup,
  splitDeferredProfileFiles,
  SandboxEgressPolicyMismatchError,
  SandboxRuntimeAuthRefreshError,
  SandboxRecoveryFailedError,
  writeProfileFilesToBox,
  deferredCorpusHash,
  PROVISION_PAYLOAD_MAX_BYTES,
  ENV_VALUE_MAX_BYTES,
  DEFAULT_PROVISION_TIMEOUT_MS,
  ENV_TOTAL_MAX_BYTES,
  assertProvisionPayloadWithinCap,
  assertEnvWithinLimits,
  peekWorkspaceSandbox,
  ensureWorkspaceSandbox,
  flattenHistory,
  mergeHistoryIntoParts,
  mergeExtraMcp,
  attachReasoningEffort,
  applyPromptTokenLimits,
  adaptSandboxStream,
  resolveSandboxPromptBackend,
  streamSandboxPrompt,
  collectSandboxPromptText,
  runSandboxPrompt,
  syncSandboxMemberAdd,
  syncSandboxMemberRemove,
  syncSandboxMemberRole,
  secretStoreFromClient,
  storeSecret,
  deleteSecret,
  mintSandboxScopedToken,
  driveSandboxTurn,
  classifySeveredStream,
  isTerminalPromptEvent,
  detectInteractiveQuestion
};
//# sourceMappingURL=chunk-J42REVQJ.js.map