// src/model-resolution/failover.ts
var UPSTREAM_UNAVAILABLE_CODES = [
  "provider_inference_unavailable",
  "upstream_unavailable",
  "insufficient_quota",
  "model_not_available",
  "server_error",
  "bad_gateway",
  "service_unavailable"
];
var UPSTREAM_UNAVAILABLE_STATUSES = [429, 500, 502, 503, 504];
var REQUEST_ERROR_STATUSES = [400, 401, 403, 405, 413, 422];
var UPSTREAM_UNAVAILABLE_MESSAGES = [
  "bad gateway",
  "service unavailable",
  "inference temporarily unavailable",
  "provider inference is unavailable",
  "insufficient balance",
  "usage limits",
  "quota exceeded",
  "rate limit",
  "overloaded",
  "temporarily unavailable",
  // Model-SCOPED unavailability. A different model in the chain can still
  // serve, so this belongs here and not with the client errors. Measured on a
  // real box 2026-07-27: the sandbox now reports an unservable model as a
  // terminal `error` whose data is `{"message":"Session error:
  // {\"error\":{\"name\":\"UnknownError\",\"data\":{\"message\":\"Model not
  // found: openai-compat/zai/glm-4.7.\"}}}"}` — no `code`, no numeric status,
  // and none of the fragments above. The shipped live product-path proof went
  // red on exactly this: `usedFallback:false`, `failed:true`, an error row to
  // the customer where a fallback was available and would have answered.
  "model not found",
  "is not currently available"
];
var HTTP_STATUS_HINT_PATTERNS = [
  /\berror\s+code:?\s*([1-5]\d{2})\b/i,
  /\bhttp(?:\/[\d.]+)?[\s:]\s*([1-5]\d{2})\b/i,
  /\bstatus(?:\s*code)?[\s:=]\s*([1-5]\d{2})\b/i,
  /\b(?:returned|responded(?:\s+with)?)\s+([1-5]\d{2})\b/i,
  /\b([1-5]\d{2})\s+(?:bad\s+gateway|service\s+unavailable|gateway\s+time-?out|internal\s+server\s+error|too\s+many\s+requests)\b/i
];
function readHttpStatusHint(text) {
  for (const pattern of HTTP_STATUS_HINT_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return Number(match[1]);
  }
  return void 0;
}
function readString(source, key) {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function isUpstreamUnavailable(signal) {
  if (signal === null || typeof signal !== "object") return false;
  const record = signal;
  if (record.success === true) return false;
  const nested = record.error;
  const nestedRecord = nested !== null && typeof nested === "object" ? nested : void 0;
  const code = readString(record, "errorCode") ?? readString(record, "code") ?? (nestedRecord ? readString(nestedRecord, "code") ?? readString(nestedRecord, "type") : void 0);
  if (code && UPSTREAM_UNAVAILABLE_CODES.includes(code)) return true;
  for (const key of ["status", "statusCode", "httpStatus"]) {
    const value = record[key];
    if (typeof value === "number" && UPSTREAM_UNAVAILABLE_STATUSES.includes(value)) return true;
  }
  const message = readString(record, "message") ?? readString(record, "error") ?? (nestedRecord ? readString(nestedRecord, "message") : void 0);
  if (!message) return false;
  const hinted = readHttpStatusHint(message);
  if (hinted !== void 0) {
    if (UPSTREAM_UNAVAILABLE_STATUSES.includes(hinted)) return true;
    if (REQUEST_ERROR_STATUSES.includes(hinted)) return false;
  }
  const lowered = message.toLowerCase();
  return UPSTREAM_UNAVAILABLE_MESSAGES.some((fragment) => lowered.includes(fragment));
}
var ModelFailoverExhaustedError = class extends Error {
  attempts;
  constructor(attempts) {
    const trail = attempts.map((a) => `${a.model}: ${a.reason ?? "failed"}`).join(" | ");
    super(`All ${attempts.length} model(s) failed. ${trail}`);
    this.name = "ModelFailoverExhaustedError";
    this.attempts = attempts;
  }
};
function describe(signal) {
  if (signal instanceof Error) return signal.message;
  if (signal !== null && typeof signal === "object") {
    const record = signal;
    const message = readString(record, "error") ?? readString(record, "message") ?? readString(record, "errorCode");
    if (message) return message;
  }
  return String(signal);
}
async function runWithModelFailover(input) {
  const models = input.models.map((m) => m.trim()).filter((m) => m.length > 0);
  if (models.length === 0) throw new Error("runWithModelFailover requires at least one model");
  const isUnavailableResult = input.isUnavailableResult ?? ((r) => isUpstreamUnavailable(r));
  const isUnavailableError = input.isUnavailableError ?? isUpstreamUnavailable;
  const attempts = [];
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    let result;
    try {
      result = await input.run(model);
    } catch (error) {
      if (!isUnavailableError(error)) throw error;
      const attempt = { model, ok: false, reason: describe(error) };
      attempts.push(attempt);
      const next = models[index + 1];
      if (next) input.onFallback?.(attempt, next);
      continue;
    }
    if (isUnavailableResult(result)) {
      const attempt = { model, ok: false, reason: describe(result) };
      attempts.push(attempt);
      const next = models[index + 1];
      if (next) input.onFallback?.(attempt, next);
      continue;
    }
    attempts.push({ model, ok: true });
    return { value: result, model, attempts, usedFallback: index > 0 };
  }
  throw new ModelFailoverExhaustedError(attempts);
}
function buildModelChain(preferred, fallbacks) {
  const chain = [];
  for (const model of [preferred, ...fallbacks]) {
    const cleaned = typeof model === "string" ? model.trim() : "";
    if (cleaned.length > 0 && !chain.includes(cleaned)) chain.push(cleaned);
  }
  return chain;
}

export {
  UPSTREAM_UNAVAILABLE_CODES,
  UPSTREAM_UNAVAILABLE_STATUSES,
  readHttpStatusHint,
  isUpstreamUnavailable,
  ModelFailoverExhaustedError,
  runWithModelFailover,
  buildModelChain
};
//# sourceMappingURL=chunk-DEXBRUZR.js.map