// src/web/rate-limit.ts
async function checkRateLimit(kv, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1e3);
  const windowStart = now - windowSeconds;
  const kvKey = `rl:${key}`;
  const raw = await kv.get(kvKey);
  const parsed = parseRateLimitState(raw);
  if (parsed === POISONED_STATE) {
    return { allowed: false, remaining: 0, resetAt: now + windowSeconds };
  }
  const valid = parsed.filter((t) => t > windowStart);
  if (valid.length >= limit) return { allowed: false, remaining: 0, resetAt: (valid[0] ?? now) + windowSeconds };
  valid.push(now);
  await kv.put(kvKey, JSON.stringify(valid), { expirationTtl: windowSeconds * 2 });
  return { allowed: true, remaining: limit - valid.length, resetAt: now + windowSeconds };
}
var POISONED_STATE = /* @__PURE__ */ Symbol("rate-limit-poisoned-state");
function parseRateLimitState(raw) {
  if (raw === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return POISONED_STATE;
  }
  if (!Array.isArray(parsed)) return POISONED_STATE;
  return parsed.filter((t) => typeof t === "number" && Number.isFinite(t));
}

// src/web/free-route-limit.ts
var FREE_ROUTE_BUDGETS = Object.freeze({
  interactive: Object.freeze({ limit: 120, windowSeconds: 60 }),
  compute: Object.freeze({ limit: 30, windowSeconds: 60 }),
  heavy: Object.freeze({ limit: 10, windowSeconds: 300 })
});
var WORKSPACE_BUDGET_MULTIPLIER = 5;
var FreeRouteLimitError = class extends Error {
  reason;
  status;
  retryAfterSeconds;
  dimension;
  route;
  constructor(init) {
    super(init.message, init.cause === void 0 ? void 0 : { cause: init.cause });
    this.name = "FreeRouteLimitError";
    this.reason = init.reason;
    this.status = init.status;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.dimension = init.dimension;
    this.route = init.route;
  }
};
function limitKey(route, dimension, id) {
  return `free:${encodeURIComponent(route)}:${dimension}:${encodeURIComponent(id)}`;
}
function assertBudget(budget, label) {
  const valid = Number.isInteger(budget.limit) && budget.limit >= 1 && Number.isInteger(budget.windowSeconds) && budget.windowSeconds >= 1;
  if (!valid) {
    throw new Error(
      `${label} must be positive integers (got limit=${budget.limit}, windowSeconds=${budget.windowSeconds})`
    );
  }
}
function secondsUntil(resetAt) {
  return Math.max(1, resetAt - Math.floor(Date.now() / 1e3));
}
async function runWindow(kv, route, dimension, id, budget) {
  try {
    const value = await checkRateLimit(kv, limitKey(route, dimension, id), budget.limit, budget.windowSeconds);
    return { succeeded: true, value };
  } catch (cause) {
    return {
      succeeded: false,
      error: new FreeRouteLimitError({
        reason: "limiter-unavailable",
        status: 503,
        retryAfterSeconds: Math.min(budget.windowSeconds, 30),
        dimension,
        route,
        message: `Rate limiter unavailable for route '${route}' \u2014 the request is refused rather than admitted unmetered`,
        cause
      })
    };
  }
}
async function checkFreeRouteLimit(input) {
  const budget = input.budget ?? FREE_ROUTE_BUDGETS[input.costClass ?? "compute"];
  assertBudget(budget, `Free-route budget for '${input.route}'`);
  const workspaceBudget = input.workspaceBudget ?? { limit: budget.limit * WORKSPACE_BUDGET_MULTIPLIER, windowSeconds: budget.windowSeconds };
  if (input.workspace) assertBudget(workspaceBudget, `Free-route workspace budget for '${input.route}'`);
  const subject = input.subject?.trim();
  if (!subject) {
    return {
      succeeded: false,
      error: new FreeRouteLimitError({
        reason: "unidentified",
        status: 401,
        // Not correctable by waiting: the caller must authenticate.
        retryAfterSeconds: 0,
        dimension: null,
        route: input.route,
        message: `Route '${input.route}' is authenticated-only \u2014 an unidentified caller cannot be rate limited, so it is refused`
      })
    };
  }
  const subjectWindow = await runWindow(input.kv, input.route, "subject", subject, budget);
  if (!subjectWindow.succeeded) return subjectWindow;
  if (!subjectWindow.value.allowed) {
    return { succeeded: false, error: rateLimited(input.route, "subject", subjectWindow.value) };
  }
  let tightest = {
    result: subjectWindow.value,
    budget,
    dimension: "subject"
  };
  if (input.workspace) {
    const workspaceWindow = await runWindow(input.kv, input.route, "workspace", input.workspace, workspaceBudget);
    if (!workspaceWindow.succeeded) return workspaceWindow;
    if (!workspaceWindow.value.allowed) {
      return { succeeded: false, error: rateLimited(input.route, "workspace", workspaceWindow.value) };
    }
    if (workspaceWindow.value.remaining < tightest.result.remaining) {
      tightest = { result: workspaceWindow.value, budget: workspaceBudget, dimension: "workspace" };
    }
  }
  return {
    succeeded: true,
    value: {
      remaining: tightest.result.remaining,
      resetAt: tightest.result.resetAt,
      budget: tightest.budget,
      dimension: tightest.dimension
    }
  };
}
function rateLimited(route, dimension, result) {
  const retryAfterSeconds = secondsUntil(result.resetAt);
  return new FreeRouteLimitError({
    reason: "rate-limited",
    status: 429,
    retryAfterSeconds,
    dimension,
    route,
    message: `Route '${route}' rate limit reached for this ${dimension}; retry in ${retryAfterSeconds}s`
  });
}
function freeRouteLimitResponse(error, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (error.retryAfterSeconds > 0) headers.set("Retry-After", String(error.retryAfterSeconds));
  return new Response(
    JSON.stringify({
      error: options.message ?? error.message,
      reason: error.reason,
      retryAfterSeconds: error.retryAfterSeconds
    }),
    { status: error.status, headers }
  );
}
function withFreeRouteLimit(options, handler) {
  return async (args) => {
    const identity = await options.identify(args);
    const outcome = await checkFreeRouteLimit({
      kv: options.kv(args),
      route: options.route,
      subject: identity?.subject,
      workspace: identity?.workspace,
      costClass: options.costClass,
      budget: options.budget,
      workspaceBudget: options.workspaceBudget
    });
    if (!outcome.succeeded) {
      return options.onDenied ? await options.onDenied(outcome.error, args) : freeRouteLimitResponse(outcome.error);
    }
    return await handler(args);
  };
}

// src/web/core.ts
async function parseJsonObjectBody(request) {
  let raw;
  try {
    raw = await request.json();
  } catch {
    return [null, Response.json({ error: "Invalid JSON body" }, { status: 400 })];
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [null, Response.json({ error: "Body must be a JSON object" }, { status: 400 })];
  }
  return [raw, null];
}
function requireString(body, field) {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) {
    return Response.json({ error: `Missing or non-string field: ${field}` }, { status: 400 });
  }
  return v;
}
function extractRequestContext(request) {
  const ipAddress = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "0.0.0.0";
  return {
    ipAddress,
    userAgent: request.headers.get("User-Agent") ?? "",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    requestId: crypto.randomUUID()
  };
}
function serializeCookie(value, opts) {
  if (opts.sameSite === "None" && !opts.secure) {
    throw new Error("SameSite=None cookies require secure: true (browsers reject them otherwise)");
  }
  const parts = [`${opts.name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? "/"}`];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.maxAgeSeconds !== void 0) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
function clearCookieHeader(opts) {
  return serializeCookie("", { ...opts, maxAgeSeconds: 0 });
}
function readCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(/;\s*/)) {
    const [cookieName, ...rest] = part.split("=");
    if (cookieName === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}
var STANDARD_SECURITY_HEADERS = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "same-origin",
  "X-XSS-Protection": "1; mode=block"
});
function addSecurityHeaders(response, opts = {}) {
  for (const [name, value] of Object.entries(STANDARD_SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  if (opts.disclaimer) response.headers.set("X-AI-Disclaimer", opts.disclaimer);
  if (opts.retention) response.headers.set("X-Data-Retention", opts.retention);
  for (const [k, v] of Object.entries(opts.extra ?? {})) response.headers.set(k, v);
  return response;
}
var REJECTED_MEDIA_SCHEMES = ["file:", "data:", "blob:", "javascript:", "vbscript:"];
function assertMediaUrl(url, what = "media url") {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return;
  if (trimmed.startsWith("/api/")) return;
  const shown = trimmed.length > 96 ? `${trimmed.slice(0, 96)}\u2026` : trimmed;
  const lower = trimmed.toLowerCase();
  if (REJECTED_MEDIA_SCHEMES.some((scheme) => lower.startsWith(scheme)) || lower.startsWith("/tmp/") || lower.startsWith("/home/")) {
    throw new Error(`${what} must reference a provider http(s) URL or a rooted /api/ path, not a local sandbox file (${shown})`);
  }
  throw new Error(`${what} must be http(s) or a rooted /api/ path (${shown})`);
}

// src/web/message-groups.ts
function groupConversationMessages(items = []) {
  let speaker = null;
  let conversation;
  let groupId;
  return items.map((item, index) => {
    if (item.conversationId !== void 0 && item.conversationId !== conversation) {
      conversation = item.conversationId;
      speaker = null;
      groupId = void 0;
    }
    const role = item.kind === "thinking" ? "assistant" : !item.kind || item.kind === "message" ? item.role : void 0;
    if (role === "user") {
      speaker = null;
      groupId = void 0;
      return { ...item, isContinuation: false };
    }
    if (role !== "assistant") return item;
    const current = item.speakerId ?? "assistant";
    const isContinuation = speaker === current;
    if (!isContinuation) groupId = String(item.id ?? `assistant-${index}`);
    speaker = current;
    return { ...item, isContinuation, groupId };
  });
}

// src/web/api-key-fetch.ts
function createApiKeyFetch(options) {
  const origin = new URL(options.origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback && options.allowHttpLoopback)) {
    throw new TypeError("API origin must be HTTPS without credentials, path, query, or fragment");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const getApiKey = options.getApiKey;
  return async (path, init = {}) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) {
      throw new TypeError("API requests require a root-relative path without whitespace or backslashes");
    }
    const target = new URL(path, origin);
    if (target.origin !== origin.origin || target.username || target.password || target.hash) {
      throw new TypeError("API requests must stay on the configured origin without a fragment");
    }
    const headers = new Headers(init.headers);
    if (headers.has("authorization") || headers.has("cookie") || headers.has("proxy-authorization")) {
      throw new TypeError("Authentication headers must come from the configured secret resolver");
    }
    init.signal?.throwIfAborted();
    let apiKey;
    try {
      apiKey = await getApiKey();
    } catch {
      throw new Error("API credential is unavailable");
    }
    if (typeof apiKey !== "string" || !apiKey || /\s|[^\x21-\x7e]/.test(apiKey)) {
      throw new TypeError("API credential must be a nonempty printable token without whitespace");
    }
    init.signal?.throwIfAborted();
    headers.set("Authorization", `Bearer ${apiKey}`);
    let response;
    try {
      response = await fetchImpl(target.href, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer"
      });
    } catch {
      init.signal?.throwIfAborted();
      throw new Error("API transport failed; inspect retained state before retrying a write");
    }
    if (response.type === "opaqueredirect" || response.redirected || response.status >= 300 && response.status < 400 && response.status !== 304) {
      try {
        await response.body?.cancel();
      } catch {
      }
      throw new Error("API redirects are not allowed");
    }
    return response;
  };
}

export {
  checkRateLimit,
  FREE_ROUTE_BUDGETS,
  WORKSPACE_BUDGET_MULTIPLIER,
  FreeRouteLimitError,
  checkFreeRouteLimit,
  freeRouteLimitResponse,
  withFreeRouteLimit,
  parseJsonObjectBody,
  requireString,
  extractRequestContext,
  serializeCookie,
  clearCookieHeader,
  readCookieValue,
  STANDARD_SECURITY_HEADERS,
  addSecurityHeaders,
  assertMediaUrl,
  groupConversationMessages,
  createApiKeyFetch
};
//# sourceMappingURL=chunk-EA4UVS4T.js.map