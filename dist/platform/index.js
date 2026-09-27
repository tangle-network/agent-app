import {
  TangleSsoAccountConflictError,
  TangleSsoUserCreateError,
  assertBillableBalance,
  createAdminGuard,
  createAuthGuard,
  createBetterAuthSessionCookieMinter,
  createSignedSsoState,
  createTangleSsoHandlers,
  guardResolution,
  normalizeTangleSsoEmail,
  parseAdminEmails,
  resolveTangleSsoAccount,
  signSessionCookieValue,
  verifySignedSsoState
} from "../chunk-BNFR6YQF.js";
import {
  resolveTangleDevOrUserKey,
  resolveTangleExecutionEnvironment
} from "../chunk-JML7WKWU.js";
import "../chunk-EA4UVS4T.js";
import "../chunk-TXD5HXLE.js";

// src/platform/hub.ts
var TangleBearerMissingError = class extends Error {
  constructor(userId) {
    super(`No Tangle platform link for user ${userId}`);
    this.userId = userId;
    this.name = "TangleBearerMissingError";
  }
  userId;
};
async function resolveUserTangleHubBearer(opts) {
  const resolved = await resolveTangleDevOrUserKey({
    environment: opts.environment,
    env: opts.env,
    getUserApiKey: opts.getUserApiKey
  });
  if (resolved) return { bearer: resolved.apiKey, source: resolved.source };
  throw new TangleBearerMissingError(opts.userId);
}
async function resolveUserTangleHubBearerForUser(opts) {
  return resolveUserTangleHubBearer({
    userId: String(opts.userId),
    environment: opts.environment,
    env: opts.env,
    getUserApiKey: () => opts.getUserApiKey(opts.userId)
  });
}
function isTangleBearerMissingError(error) {
  return error instanceof Error && error.name === "TangleBearerMissingError" && typeof error.userId === "string";
}
function isPlatformHubErrorLike(error) {
  return error instanceof Error && error.name === "PlatformHubError" && typeof error.status === "number";
}
function createHubProxyRoutes(ctx) {
  async function proxy(request, call) {
    const userId = await ctx.requireUserId(request);
    try {
      const bearer = await ctx.getBearer(userId);
      return await call(ctx.createHubClient(bearer));
    } catch (err) {
      if (isTangleBearerMissingError(err)) {
        return Response.json({ error: "tangle_link_required" }, { status: 412 });
      }
      if (isPlatformHubErrorLike(err)) {
        return Response.json({ error: err.message, code: err.code }, { status: err.status });
      }
      throw err;
    }
  }
  return {
    catalog: ({ request }) => proxy(request, async (hub) => Response.json({ catalog: await hub.catalog() })),
    connections: ({ request }) => proxy(request, async (hub) => Response.json({ connections: await hub.listConnections() })),
    connectionDelete: async ({ request, params }) => {
      if (request.method !== "DELETE") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      return proxy(request, async (hub) => Response.json(await hub.revokeConnection(params.connectionId)));
    },
    healthchecks: ({ request }) => proxy(request, async (hub) => Response.json({ healthchecks: await hub.listHealthchecks() })),
    authStart: async ({ request }) => {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const userId = await ctx.requireUserId(request);
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      if (!body.providerId || !body.connectorId || !body.returnUrl) {
        return Response.json({ error: "providerId, connectorId, and returnUrl are required" }, { status: 400 });
      }
      try {
        const bearer = await ctx.getBearer(userId);
        const result = await ctx.createHubClient(bearer).startAuth({
          providerId: body.providerId,
          connectorId: body.connectorId,
          returnUrl: body.returnUrl,
          requestedScopes: body.requestedScopes
        });
        return Response.json({ authorizationUrl: result.authorizationUrl, state: result.state });
      } catch (err) {
        if (isTangleBearerMissingError(err)) {
          return Response.json({ error: "tangle_link_required" }, { status: 412 });
        }
        if (isPlatformHubErrorLike(err)) {
          return Response.json({ error: err.message, code: err.code }, { status: err.status });
        }
        throw err;
      }
    }
  };
}

// src/platform/billing.ts
function normalizeTanglePlanTier(plan) {
  return plan === "pro" || plan === "enterprise" ? plan : "free";
}
var PlatformBillingHttpError = class extends Error {
  constructor(status, detail) {
    super(`Platform request failed (${status}): ${detail}`);
    this.status = status;
    this.name = "PlatformBillingHttpError";
  }
  status;
};
function isPlatformBillingHttpError(error) {
  return error instanceof Error && error.name === "PlatformBillingHttpError" && typeof error.status === "number";
}
function productSeatOffer(value) {
  if (!value || typeof value !== "object") return void 0;
  const candidate = value;
  if (candidate.currency !== "usd" || candidate.interval !== "month") return void 0;
  const period = (input, allowZeroPrice) => {
    if (!input || typeof input !== "object") return void 0;
    const data = input;
    const priceCents = data.priceCents;
    const includedCreditsCents = data.includedCreditsCents;
    if (typeof priceCents !== "number" || !Number.isSafeInteger(priceCents) || (allowZeroPrice ? priceCents < 0 : priceCents <= 0) || typeof includedCreditsCents !== "number" || !Number.isSafeInteger(includedCreditsCents) || includedCreditsCents < 0) {
      return void 0;
    }
    return { priceCents, includedCreditsCents };
  };
  const recurring = period(candidate.recurring, false);
  const introductory = candidate.introductory === null ? null : period(candidate.introductory, true);
  if (!recurring || introductory === void 0) return void 0;
  return {
    currency: "usd",
    interval: "month",
    recurring,
    introductory
  };
}
function createPlatformBillingHttp(opts) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("PlatformBillingHttpOptions.baseUrl is required");
  if (!opts.productSlug) throw new Error("PlatformBillingHttpOptions.productSlug is required");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1e4;
  function resolveServiceToken() {
    const token = typeof opts.serviceToken === "function" ? opts.serviceToken() : opts.serviceToken;
    if (!token) throw new Error("A platform service token is required for deduct");
    return token;
  }
  async function request(path, init, headers) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new PlatformBillingHttpError(res.status, body?.error?.message ?? res.statusText);
    }
    return res.json();
  }
  function userRead(userApiKey, path) {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${userApiKey}`);
    return request(path, {}, headers);
  }
  return {
    async getSubscription(userApiKey) {
      const body = await userRead(userApiKey, "/v1/plans/current");
      const sub = body.data?.subscription ?? null;
      return { tier: normalizeTanglePlanTier(sub?.plan), status: sub?.status ?? null };
    },
    async getBalance(userApiKey) {
      const body = await userRead(userApiKey, "/v1/billing/balance");
      return {
        balance: body.data?.balance ?? 0,
        lifetimeSpent: body.data?.lifetimeSpent ?? 0,
        updatedAt: body.data?.updatedAt
      };
    },
    async getUsageByProduct(userApiKey) {
      const body = await userRead(userApiKey, "/v1/billing/usage");
      return (body.data ?? []).map((row) => ({
        product: row.product ?? null,
        totalSpent: row.totalSpent ?? 0,
        count: row.count ?? 0
      }));
    },
    async getProductEntitlement(userApiKey, productId) {
      const slug = encodeURIComponent(productId);
      const body = await userRead(userApiKey, `/v1/billing/product-entitlement?product=${slug}`);
      const data = body.data ?? {};
      const hasSeat = data.hasSeat === true;
      const offer = productSeatOffer(data.offer);
      return {
        seatStatus: data.seatStatus ?? "none",
        currentPeriodEnd: data.currentPeriodEnd ?? null,
        lifetimeSpentUsd: data.lifetimeSpentUsd ?? 0,
        hasSeat,
        ..."paidAccess" in data ? { paidAccess: data.paidAccess === true } : {},
        // Product-funded free access is retired. Ignore stale server signals.
        onFreeTier: false,
        ...offer ? { offer } : {}
      };
    },
    async deduct(input) {
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${resolveServiceToken()}`);
      headers.set("X-Service-Name", opts.productSlug);
      headers.set("Content-Type", "application/json");
      await request("/v1/billing/deduct", {
        method: "POST",
        body: JSON.stringify({
          userId: input.platformUserId,
          amount: input.amountUsd,
          type: input.type,
          product: opts.productSlug,
          description: input.description,
          referenceId: input.referenceId
        })
      }, headers);
    },
    billingUrl() {
      return `${baseUrl}/app/billing`;
    },
    seatCheckoutUrl(productId) {
      return seatCheckoutUrl(baseUrl, productId);
    }
  };
}
function seatCheckoutUrl(baseUrl, productId) {
  const root = baseUrl.replace(/\/+$/, "");
  return `${root}/app/billing/seat/checkout?product=${encodeURIComponent(productId)}`;
}
var DEFAULT_TANGLE_TIER_POLICY = {
  free: { concurrency: 1, overageAllowed: false },
  pro: { concurrency: Number.POSITIVE_INFINITY, overageAllowed: true },
  enterprise: { concurrency: Number.POSITIVE_INFINITY, overageAllowed: true }
};
async function readTangleTierState(http, userApiKey, policy = DEFAULT_TANGLE_TIER_POLICY) {
  if (!userApiKey) {
    return {
      tier: "free",
      subscriptionStatus: null,
      remainingBalanceUsd: 0,
      lifetimeSpentUsd: 0,
      ...policy.free
    };
  }
  const [subscription, balance] = await Promise.all([
    http.getSubscription(userApiKey),
    http.getBalance(userApiKey)
  ]);
  return {
    tier: subscription.tier,
    subscriptionStatus: subscription.status,
    remainingBalanceUsd: balance.balance,
    lifetimeSpentUsd: balance.lifetimeSpent,
    ...policy[subscription.tier]
  };
}
var FREE_TIER_SPEND_CAP_USD = 0;
var DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR = "SEAT_BILLING_ENABLED";
function isSeatBillingEnabled(opts = {}) {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : void 0);
  if (!env) return true;
  const flag = env[opts.flagEnvVar ?? DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR]?.trim().toLowerCase();
  if (flag) return !["false", "0", "off", "disabled", "no"].includes(flag);
  const environment = resolveTangleExecutionEnvironment(env);
  return environment !== "development" && environment !== "test";
}
async function getProductEntitlement(http, userApiKey, productId, flag = true) {
  if (!flag) return unavailableEntitlement();
  if (!userApiKey) return unavailableEntitlement();
  return http.getProductEntitlement(userApiKey, productId);
}
function unavailableEntitlement() {
  return {
    seatStatus: "none",
    currentPeriodEnd: null,
    lifetimeSpentUsd: 0,
    hasSeat: false,
    onFreeTier: false
  };
}
function isProductEntitled(ent) {
  return ent.paidAccess === void 0 ? ent.hasSeat === true : ent.paidAccess === true;
}
function createTanglePlatformBillingClient(http, identity) {
  return {
    resolveIdentity: (userId) => identity.resolveIdentity(userId),
    getPlan: async (apiKey) => (await http.getSubscription(apiKey)).tier,
    getBalance: async (apiKey) => {
      const snapshot = await http.getBalance(apiKey);
      return { balance: snapshot.balance, lifetimeSpent: snapshot.lifetimeSpent };
    },
    getUsageByProduct: (apiKey) => http.getUsageByProduct(apiKey),
    deduct: (input) => http.deduct(input)
  };
}

// src/platform/api-key-auth.ts
function createApiKeyRequestAuth(options) {
  return async (request) => {
    const authorization = request.headers.get("Authorization");
    if (authorization === null) return null;
    const bearer = /^Bearer +(\S+)$/i.exec(authorization);
    if (!bearer) {
      throw denied(401, "api_key.invalid", "Invalid API key");
    }
    const requiredScope = options.requiredScope(request);
    const requiredScopes = typeof requiredScope === "string" ? [requiredScope] : Array.from(requiredScope ?? []);
    if (!requiredScopes?.length || !requiredScopes.every((scope) => typeof scope === "string" && scope.trim())) {
      throw denied(403, "api_key.route_denied", "API key access is not enabled for this route");
    }
    const key = await options.verify(`Bearer ${bearer[1]}`);
    if (!key || !key.keyId?.trim() || !key.ownerId?.trim()) {
      throw denied(401, "api_key.invalid", "Invalid API key");
    }
    if (!Number.isSafeInteger(key.expiresAt) || key.expiresAt <= Date.now()) {
      throw denied(401, "api_key.expired", "An unexpired API key with a finite expiry is required");
    }
    if (!Array.isArray(key.scopes) || !requiredScopes.every((scope) => key.scopes.includes(scope))) {
      throw denied(403, "api_key.insufficient_scope", `API key requires scopes: ${requiredScopes.join(", ")}`);
    }
    const identity = await options.resolveIdentity(key);
    if (!identity) throw denied(401, "api_key.invalid_owner", "API key owner is unavailable");
    const claim = await options.claimRequest(key, crypto.randomUUID());
    if (claim.allowed !== true) {
      const headers = new Headers();
      if (Number.isFinite(claim.retryAfterSeconds) && claim.retryAfterSeconds > 0) {
        headers.set("Retry-After", String(Math.ceil(claim.retryAfterSeconds)));
      }
      throw denied(429, "api_key.request_limit_exceeded", "API key request limit exceeded", headers);
    }
    if (key.expiresAt <= Date.now()) {
      throw denied(401, "api_key.expired", "API key expired during authorization");
    }
    return identity;
  };
}
function denied(status, code, error, headers) {
  return Response.json({ error, code }, { status, headers });
}
export {
  DEFAULT_SEAT_BILLING_ENABLED_ENV_VAR,
  DEFAULT_TANGLE_TIER_POLICY,
  FREE_TIER_SPEND_CAP_USD,
  PlatformBillingHttpError,
  TangleBearerMissingError,
  TangleSsoAccountConflictError,
  TangleSsoUserCreateError,
  assertBillableBalance,
  createAdminGuard,
  createApiKeyRequestAuth,
  createAuthGuard,
  createBetterAuthSessionCookieMinter,
  createHubProxyRoutes,
  createPlatformBillingHttp,
  createSignedSsoState,
  createTanglePlatformBillingClient,
  createTangleSsoHandlers,
  getProductEntitlement,
  guardResolution,
  isPlatformBillingHttpError,
  isPlatformHubErrorLike,
  isProductEntitled,
  isSeatBillingEnabled,
  isTangleBearerMissingError,
  normalizeTanglePlanTier,
  normalizeTangleSsoEmail,
  parseAdminEmails,
  readTangleTierState,
  resolveTangleSsoAccount,
  resolveUserTangleHubBearer,
  resolveUserTangleHubBearerForUser,
  seatCheckoutUrl,
  signSessionCookieValue,
  verifySignedSsoState
};
//# sourceMappingURL=index.js.map