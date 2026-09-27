// src/runtime/model.ts
var DEFAULT_TANGLE_ROUTER_BASE_URL = "https://router.tangle.tools/v1";
var DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR = "TANGLE_BILLING_ENFORCEMENT";
function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function trimOrNull(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function isTangleExecutionKeyErrorCode(value) {
  return value === "local_tangle_api_key_required" || value === "tangle_account_not_connected";
}
var TangleExecutionKeyError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "TangleExecutionKeyError";
    this.code = code;
    this.status = status;
  }
};
function isTangleExecutionKeyError(error) {
  return error instanceof TangleExecutionKeyError || typeof error === "object" && error !== null && error.name === "TangleExecutionKeyError" && typeof error.message === "string" && isTangleExecutionKeyErrorCode(error.code) && typeof error.status === "number";
}
function resolveTangleExecutionEnvironment(env = process.env) {
  const raw = (env.APP_ENV ?? env.NODE_ENV ?? "").trim().toLowerCase();
  if (raw === "development" || raw === "dev" || raw === "local") return "development";
  if (raw === "staging") return "staging";
  if (raw === "test") return "test";
  return "production";
}
function isTangleBillingEnforcementDisabled(opts = {}) {
  const env = opts.env ?? process.env;
  const enforcementEnvVar = opts.enforcementEnvVar ?? DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR;
  const override = env[enforcementEnvVar]?.trim().toLowerCase();
  if (override === "disabled") return true;
  if (override === "enabled") return false;
  return resolveTangleExecutionEnvironment(env) === "development";
}
function tangleExecutionKeyHttpError(error) {
  if (!isTangleExecutionKeyError(error)) return null;
  return {
    status: error.status,
    body: {
      error: error.message,
      code: error.code
    }
  };
}
async function resolveTangleDevOrUserKey(opts) {
  const env = opts.env ?? process.env;
  const environment = opts.environment ?? resolveTangleExecutionEnvironment(env);
  if (environment === "development") {
    const apiKey2 = trimOrNull(env.TANGLE_API_KEY);
    if (apiKey2) return { apiKey: apiKey2, source: "local-env" };
  }
  const apiKey = trimOrNull(await opts.getUserApiKey());
  if (apiKey) return { apiKey, source: "user" };
  return null;
}
async function resolveUserTangleExecutionKey(opts) {
  const env = opts.env ?? process.env;
  const environment = opts.environment ?? resolveTangleExecutionEnvironment(env);
  const resolved = await resolveTangleDevOrUserKey({ environment, env, getUserApiKey: opts.getUserApiKey });
  if (resolved) return resolved;
  if (environment === "development") {
    throw new TangleExecutionKeyError(
      "local_tangle_api_key_required",
      "TANGLE_API_KEY or a linked Tangle account is required for local Tangle model execution.",
      503
    );
  }
  throw new TangleExecutionKeyError(
    "tangle_account_not_connected",
    "Connect your Tangle account before invoking this agent.",
    401
  );
}
async function resolveUserTangleExecutionKeyForUser(opts) {
  return resolveUserTangleExecutionKey({
    environment: opts.environment,
    env: opts.env,
    getUserApiKey: () => opts.getUserApiKey(opts.userId)
  });
}
function createTangleRouterModelConfig(opts) {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error("apiKey is required");
  const model = opts.model.trim();
  if (!model) throw new Error("model is required");
  return {
    provider: "openai-compat",
    model,
    apiKey,
    baseUrl: (opts.baseUrl?.trim() || DEFAULT_TANGLE_ROUTER_BASE_URL).replace(/\/+$/, "")
  };
}
function resolveTangleModelConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const provider = env.MODEL_PROVIDER?.trim() || "openai-compat";
  const model = requireEnv(env, "MODEL_NAME");
  if (provider === "openai-compat" || provider === "tangle-router" || provider === "tcloud") {
    return {
      provider: "openai-compat",
      model,
      apiKey: requireEnv(env, "TANGLE_API_KEY"),
      baseUrl: (env.TANGLE_ROUTER_BASE_URL?.trim() || opts.defaultRouterBaseUrl || DEFAULT_TANGLE_ROUTER_BASE_URL).replace(/\/+$/, "")
    };
  }
  if (provider === "anthropic") {
    return {
      provider,
      model,
      apiKey: requireEnv(env, "ANTHROPIC_API_KEY"),
      baseUrl: requireEnv(env, "ANTHROPIC_BASE_URL")
    };
  }
  throw new Error(`Unsupported MODEL_PROVIDER: ${provider} (use openai-compat for the Tangle Router, or anthropic for BYOK)`);
}

export {
  DEFAULT_TANGLE_ROUTER_BASE_URL,
  DEFAULT_TANGLE_BILLING_ENFORCEMENT_ENV_VAR,
  trimOrNull,
  TangleExecutionKeyError,
  isTangleExecutionKeyError,
  resolveTangleExecutionEnvironment,
  isTangleBillingEnforcementDisabled,
  tangleExecutionKeyHttpError,
  resolveTangleDevOrUserKey,
  resolveUserTangleExecutionKey,
  resolveUserTangleExecutionKeyForUser,
  createTangleRouterModelConfig,
  resolveTangleModelConfig
};
//# sourceMappingURL=chunk-JML7WKWU.js.map