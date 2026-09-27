import {
  isTangleBillingEnforcementDisabled
} from "./chunk-JML7WKWU.js";
import {
  clearCookieHeader,
  readCookieValue,
  serializeCookie
} from "./chunk-EA4UVS4T.js";

// src/platform/sso.ts
var DEFAULT_STATE_TTL_SECONDS = 600;
var DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
var DEFAULT_REDIRECT_PATH = "/app";
var DEFAULT_LOGIN_PATH = "/login";
var DEFAULT_SESSION_COOKIE = "better-auth.session_token";
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacBytes(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function hmacHex(secret, value) {
  return Array.from(await hmacBytes(secret, value), (b) => b.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function createSignedSsoState(config) {
  if (!config.secret) throw new Error("SsoStateConfig.secret is required");
  const now = config.now ?? Date.now;
  const payload = `${randomHex(16)}.${now().toString(36)}`;
  return `${payload}.${await hmacHex(config.secret, payload)}`;
}
async function verifySignedSsoState(state, config) {
  if (!config.secret) throw new Error("SsoStateConfig.secret is required");
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [random, timestamp, mac] = parts;
  if (!random || !timestamp || !mac || !/^[0-9a-z]+$/.test(timestamp)) return false;
  const expected = await hmacHex(config.secret, `${random}.${timestamp}`);
  if (!constantTimeEqual(mac, expected)) return false;
  const mintedAt = parseInt(timestamp, 36);
  if (!Number.isFinite(mintedAt)) return false;
  const now = config.now ?? Date.now;
  const ttlMs = config.ttlMs ?? DEFAULT_STATE_TTL_SECONDS * 1e3;
  const age = now() - mintedAt;
  return age >= 0 && age <= ttlMs;
}
function normalizeTangleSsoEmail(email) {
  return email.trim().toLowerCase();
}
function normalizedPlatformUserId(value) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
function resolveTangleSsoAccount(input) {
  const email = normalizeTangleSsoEmail(input.email);
  const platformUserId = normalizedPlatformUserId(input.platformUserId);
  if (!email) return { kind: "reject", reason: "invalid-email" };
  if (!platformUserId) return { kind: "reject", reason: "invalid-platform-id" };
  if (input.platformMatches.length > 1) {
    return { kind: "reject", reason: "ambiguous-platform-id" };
  }
  if (input.emailMatches.length > 1) {
    return { kind: "reject", reason: "ambiguous-email" };
  }
  if (input.platformMatches.some((account) => normalizedPlatformUserId(account.platformUserId) !== platformUserId)) {
    return { kind: "reject", reason: "platform-match-mismatch" };
  }
  if (input.emailMatches.some((account) => normalizeTangleSsoEmail(account.email) !== email)) {
    return { kind: "reject", reason: "email-match-mismatch" };
  }
  const platformMatch = input.platformMatches[0];
  const emailMatch = input.emailMatches[0];
  if (platformMatch) {
    if (emailMatch && emailMatch.userId !== platformMatch.userId) {
      return { kind: "reject", reason: "platform-id-email-conflict" };
    }
    return { kind: "existing", userId: platformMatch.userId, matchedBy: "platform-id" };
  }
  if (!emailMatch) return { kind: "create" };
  const existingPlatformUserId = normalizedPlatformUserId(emailMatch.platformUserId);
  if (existingPlatformUserId === platformUserId) {
    return { kind: "existing", userId: emailMatch.userId, matchedBy: "platform-id" };
  }
  if (emailMatch.emailVerified !== true) {
    return { kind: "reject", reason: "unverified-email" };
  }
  if (existingPlatformUserId && existingPlatformUserId !== platformUserId) {
    return { kind: "reject", reason: "email-platform-id-conflict" };
  }
  return { kind: "existing", userId: emailMatch.userId, matchedBy: "verified-email" };
}
var TangleSsoAccountConflictError = class extends Error {
  reason;
  constructor(reason, message = "Tangle SSO account linking was rejected") {
    super(message);
    this.name = "TangleSsoAccountConflictError";
    this.reason = reason;
  }
};
var TangleSsoUserCreateError = class extends Error {
  constructor(message = "Failed to create local user for Tangle SSO") {
    super(message);
    this.name = "TangleSsoUserCreateError";
  }
};
async function signSessionCookieValue(token, secret) {
  if (!secret) throw new Error("signSessionCookieValue requires a non-empty secret");
  const sig = await hmacBytes(secret, token);
  let bin = "";
  for (const byte of sig) bin += String.fromCharCode(byte);
  return `${token}.${btoa(bin)}`;
}
function createBetterAuthSessionCookieMinter(auth, options = {}) {
  const warn = options.warn ?? ((message) => console.warn(message));
  return async ({ token, ttlSeconds }) => {
    const ctx = await auth.$context;
    if (!ctx.secret) {
      throw new Error("createBetterAuthSessionCookieMinter: auth context has no secret");
    }
    const { name, attributes } = ctx.authCookies.sessionToken;
    if (attributes.domain) {
      throw new Error(
        `createBetterAuthSessionCookieMinter: refusing a domain-scoped session cookie (Domain=${attributes.domain}) \u2014 a domain-wide session cookie shadows sibling apps that share the parent domain`
      );
    }
    if (name === DEFAULT_SESSION_COOKIE || name === `__Secure-${DEFAULT_SESSION_COOKIE}`) {
      warn(
        `[tangle-sso] session cookie is named "${name}" \u2014 better-auth's default. The Tangle platform (id.tangle.tools) sets a Domain=.tangle.tools cookie under the same name, and the platform's (older) cookie wins the Cookie-header order, so this app's sessions read back null. Set a per-app prefix: betterAuth({ advanced: { cookiePrefix: '<app>' } }).`
      );
    }
    const sameSite = typeof attributes.sameSite === "string" ? attributes.sameSite : "lax";
    const cookieOptions = {
      name,
      path: typeof attributes.path === "string" ? attributes.path : "/",
      httpOnly: attributes.httpOnly !== false,
      sameSite: sameSite.charAt(0).toUpperCase() + sameSite.slice(1),
      secure: Boolean(attributes.secure) || name.startsWith("__Secure-"),
      maxAgeSeconds: ttlSeconds
    };
    const cookies = [serializeCookie(await signSessionCookieValue(token, ctx.secret), cookieOptions)];
    if (name !== DEFAULT_SESSION_COOKIE) {
      cookies.push(clearCookieHeader({ ...cookieOptions, name: DEFAULT_SESSION_COOKIE }));
    }
    return cookies;
  };
}
var REDIRECT_REFERENCE_ORIGIN = "https://redirect-reference.invalid";
function sanitizeRedirectPath(value, fallback) {
  if (!value || !value.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  const path = resolveOnReferenceOrigin(value);
  if (path === null || resolveOnReferenceOrigin(path) !== path) return fallback;
  return path;
}
function resolveOnReferenceOrigin(value) {
  let url;
  try {
    url = new URL(value, REDIRECT_REFERENCE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== REDIRECT_REFERENCE_ORIGIN) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
function redirectResponse(location, headers = new Headers()) {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status: 302, headers });
}
function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}
function parseStateCookiePayload(raw) {
  if (!raw || raw.length > 4096) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const { s, r, v, m } = parsed;
    if (typeof s !== "string" || typeof r !== "string") return null;
    return { s, r, ...typeof v === "string" ? { v } : {}, ...typeof m === "string" ? { m } : {} };
  } catch {
    return null;
  }
}
function stateBinding(payload, callbackUrl) {
  return JSON.stringify([payload.s, payload.r, payload.v ?? null, callbackUrl]);
}
function createTangleSsoHandlers(opts) {
  if (!opts.stateSecret) throw new Error("TangleSsoHandlerOptions.stateSecret is required");
  if (!opts.callbackUrl) throw new Error("TangleSsoHandlerOptions.callbackUrl is required");
  if (!opts.stateCookieName) throw new Error("TangleSsoHandlerOptions.stateCookieName is required");
  const callbackUrl = new URL(opts.callbackUrl);
  if (opts.protocol === "oidc") {
    if (opts.stateSecret.length < 32) throw new Error("OIDC stateSecret must contain at least 32 characters");
    if (callbackUrl.username || callbackUrl.password || callbackUrl.hash || callbackUrl.search) {
      throw new Error("OIDC callbackUrl must be fixed and have no credentials, query, or fragment");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname);
    if (callbackUrl.protocol !== "https:" && !(callbackUrl.protocol === "http:" && loopback)) {
      throw new Error("OIDC requires HTTPS except on loopback");
    }
    if (callbackUrl.protocol === "https:" && !opts.secureCookies) {
      throw new Error("OIDC HTTPS callbacks require Secure cookies");
    }
  }
  const sessionCookieName = opts.sessionCookieName ?? DEFAULT_SESSION_COOKIE;
  let mintSessionCookies;
  if (opts.setSessionCookie) {
    const seam = opts.setSessionCookie;
    mintSessionCookies = async (args) => await seam(args);
  } else if (opts.sessionCookieSecret) {
    const secret = opts.sessionCookieSecret;
    mintSessionCookies = async ({ token, secure, ttlSeconds }) => [
      serializeCookie(await signSessionCookieValue(token, secret), {
        name: secure ? `__Secure-${sessionCookieName}` : sessionCookieName,
        secure,
        maxAgeSeconds: ttlSeconds
      })
    ];
  } else {
    throw new Error("TangleSsoHandlerOptions requires setSessionCookie or sessionCookieSecret");
  }
  const sessionTtlSeconds = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const stateTtlSeconds = opts.stateTtlSeconds ?? DEFAULT_STATE_TTL_SECONDS;
  if (!Number.isFinite(stateTtlSeconds) || stateTtlSeconds <= 0 || !Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    throw new Error("SSO lifetimes must be positive and finite");
  }
  const defaultRedirectPath = sanitizeRedirectPath(opts.defaultRedirectPath ?? DEFAULT_REDIRECT_PATH, DEFAULT_REDIRECT_PATH);
  const loginPath = sanitizeRedirectPath(opts.loginPath ?? DEFAULT_LOGIN_PATH, DEFAULT_LOGIN_PATH);
  const log = opts.log ?? (() => {
  });
  const now = opts.now ?? Date.now;
  const stateConfig = { secret: opts.stateSecret, ttlMs: stateTtlSeconds * 1e3, now };
  const stateCookieOpts = { name: opts.stateCookieName, secure: opts.secureCookies };
  function loginErrorRedirect(code) {
    const headers = new Headers();
    headers.append("Set-Cookie", clearCookieHeader(stateCookieOpts));
    const target = new URL(loginPath, REDIRECT_REFERENCE_ORIGIN);
    target.searchParams.set("error", code);
    return redirectResponse(`${target.pathname}${target.search}${target.hash}`, headers);
  }
  return {
    async start(request) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      const url = new URL(request.url);
      if (opts.protocol === "oidc" && url.origin !== callbackUrl.origin) {
        return loginErrorRedirect("tangle_origin_mismatch");
      }
      const redirectPath = sanitizeRedirectPath(url.searchParams.get("redirect"), defaultRedirectPath);
      const state = await createSignedSsoState(stateConfig);
      const payload = { s: state, r: redirectPath };
      let authorizationUrl;
      if (opts.protocol === "oidc") {
        const { createPkcePair } = await import("@tangle-network/agent-runtime/platform");
        const pkce = await createPkcePair();
        payload.v = pkce.verifier;
        payload.m = await hmacHex(opts.stateSecret, stateBinding(payload, opts.callbackUrl));
        authorizationUrl = opts.auth.authorizeUrl({ state, codeChallenge: pkce.challenge });
        if (new URL(authorizationUrl).searchParams.get("redirect_uri") !== opts.callbackUrl) {
          throw new Error("PlatformOidcClient.redirectUri must equal callbackUrl");
        }
      } else {
        authorizationUrl = opts.auth.authorizeUrl({ state, redirectUri: opts.callbackUrl });
      }
      const cookie = serializeCookie(JSON.stringify(payload), {
        ...stateCookieOpts,
        maxAgeSeconds: stateTtlSeconds
      });
      const headers = new Headers();
      headers.append("Set-Cookie", cookie);
      return redirectResponse(authorizationUrl, headers);
    },
    async callback(request) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      const url = new URL(request.url);
      if (opts.protocol === "oidc" && (url.origin !== callbackUrl.origin || url.pathname !== callbackUrl.pathname)) {
        return loginErrorRedirect("tangle_origin_mismatch");
      }
      const code = url.searchParams.get("code");
      const stateFromPlatform = url.searchParams.get("state");
      if (!code || !stateFromPlatform || url.searchParams.has("error")) return loginErrorRedirect("tangle_callback_missing");
      const payload = parseStateCookiePayload(readCookieValue(request.headers.get("cookie"), opts.stateCookieName));
      if (!payload || !constantTimeEqual(payload.s, stateFromPlatform)) return loginErrorRedirect("tangle_state_mismatch");
      if (!await verifySignedSsoState(payload.s, stateConfig)) return loginErrorRedirect("tangle_state_mismatch");
      if (opts.protocol === "oidc" && (!payload.v || !/^[A-Za-z0-9_-]{43,128}$/.test(payload.v) || !payload.m || !constantTimeEqual(payload.m, await hmacHex(opts.stateSecret, stateBinding(payload, opts.callbackUrl))))) {
        return loginErrorRedirect("tangle_state_mismatch");
      }
      const tokenRequestedAt = now();
      let oidcTokens;
      let legacyExchange;
      let createdSession;
      let committed = false;
      try {
        let exchanged;
        try {
          if (opts.protocol === "oidc") {
            const result = await opts.auth.exchange(code, payload.v);
            oidcTokens = result.tokens;
            if (!oidcTokens.refreshToken || !Number.isFinite(oidcTokens.expiresIn) || oidcTokens.expiresIn <= 0) {
              throw new Error("OIDC requires offline_access and a finite access-token lifetime");
            }
            exchanged = { user: result.user, emailVerified: result.user.emailVerified };
          } else {
            legacyExchange = await opts.auth.exchange(code);
            exchanged = legacyExchange;
          }
        } catch {
          log("[tangle-sso] exchange failed");
          return loginErrorRedirect("tangle_exchange_failed");
        }
        if (exchanged.emailVerified !== true) {
          log("[tangle-sso] exchange did not include a verified-email proof");
          return loginErrorRedirect("tangle_exchange_failed");
        }
        let userId;
        try {
          const email = normalizeTangleSsoEmail(exchanged.user.email);
          const resolution = await opts.store.resolveAccount({ email, platformUserId: exchanged.user.id });
          if (resolution.kind === "reject") throw new TangleSsoAccountConflictError(resolution.reason);
          ({ userId } = await opts.store.upsertUserByEmail({
            email,
            name: exchanged.user.name ?? null,
            tangleUserId: exchanged.user.id,
            resolution
          }));
        } catch (err) {
          if (err instanceof TangleSsoAccountConflictError) {
            log("[tangle-sso] account linking conflict", err.reason);
            return loginErrorRedirect("tangle_account_conflict");
          }
          if (err instanceof TangleSsoUserCreateError) return loginErrorRedirect("tangle_user_create_failed");
          throw err;
        }
        const expiresAt = new Date(now() + sessionTtlSeconds * 1e3);
        const { token } = await opts.store.createSession({
          userId,
          expiresAt,
          ipAddress: clientIp(request),
          userAgent: request.headers.get("user-agent")
        });
        createdSession = token;
        const link = {
          userId,
          sessionToken: token,
          tangleUserId: exchanged.user.id,
          email: normalizeTangleSsoEmail(exchanged.user.email),
          name: exchanged.user.name ?? null
        };
        if (opts.protocol === "oidc") {
          await opts.store.saveTangleLink({
            ...link,
            tokens: oidcTokens,
            accessTokenExpiresAt: new Date(tokenRequestedAt + oidcTokens.expiresIn * 1e3)
          });
        } else {
          await opts.store.saveTangleLink({ ...link, apiKey: legacyExchange.apiKey, planTier: legacyExchange.plan?.tier ?? null });
        }
        const headers = new Headers();
        headers.append("Set-Cookie", clearCookieHeader(stateCookieOpts));
        const sessionCookies = await mintSessionCookies({ token, expiresAt, ttlSeconds: sessionTtlSeconds, secure: opts.secureCookies });
        for (const cookie of sessionCookies) headers.append("Set-Cookie", cookie);
        committed = true;
        return redirectResponse(sanitizeRedirectPath(payload.r, defaultRedirectPath), headers);
      } catch (error) {
        if (opts.protocol !== "oidc") throw error;
        log("[tangle-sso] local session persistence failed");
        return loginErrorRedirect("tangle_session_failed");
      } finally {
        if (opts.protocol === "oidc" && !committed) {
          if (createdSession) {
            try {
              await opts.store.deleteSession({ sessionToken: createdSession });
            } catch {
              log("[tangle-sso] unpublished session cleanup failed");
            }
          }
          if (oidcTokens) {
            try {
              if (oidcTokens.refreshToken) await opts.auth.revoke(oidcTokens.refreshToken, "refresh_token");
            } catch {
              log("[tangle-sso] rejected grant refresh revocation failed");
            }
            try {
              await opts.auth.revoke(oidcTokens.accessToken, "access_token");
            } catch {
              log("[tangle-sso] rejected grant access revocation failed");
            }
          }
        }
      }
    }
  };
}

// src/platform/guards.ts
function createAuthGuard(opts) {
  const loginPath = opts.loginPath ?? "/login";
  async function requireSession(request, o = {}) {
    const session = await opts.getSession(request);
    if (!session) {
      if (o.apiResponse) {
        throw Response.json({ error: "Unauthorized", code: "auth.unauthenticated" }, { status: 401 });
      }
      throw new Response(null, { status: 302, headers: { Location: loginPath } });
    }
    return session;
  }
  return {
    requireSession,
    requireUser: (request) => requireSession(request),
    requireApiUser: (request) => requireSession(request, { apiResponse: true }),
    getOptionalSession: async (request) => await opts.getSession(request) ?? null
  };
}
async function guardResolution(run) {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof Response) return { ok: false, response: err };
    throw err;
  }
}
function parseAdminEmails(raw) {
  return (raw ?? "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
}
function createAdminGuard(opts) {
  return async (request) => {
    const session = await opts.requireUser(request);
    const allowed = opts.allowedEmails();
    if (allowed.length === 0) throw new Response("Not found", { status: 404 });
    const email = (opts.emailOf(session) ?? "").toLowerCase();
    if (!allowed.includes(email)) throw new Response("Not found", { status: 404 });
    return session;
  };
}
function assertBillableBalance(state, opts = {}) {
  if (isTangleBillingEnforcementDisabled({ env: opts.env, enforcementEnvVar: opts.enforcementEnvVar })) return;
  if (state.overageAllowed || state.remainingBalanceUsd > 0) return;
  throw Response.json(
    {
      ...opts.errorBody,
      error: opts.errorMessage ?? "Add balance or upgrade your plan to invoke this agent.",
      code: "billing.balance_required"
    },
    { status: 402 }
  );
}

export {
  createSignedSsoState,
  verifySignedSsoState,
  normalizeTangleSsoEmail,
  resolveTangleSsoAccount,
  TangleSsoAccountConflictError,
  TangleSsoUserCreateError,
  signSessionCookieValue,
  createBetterAuthSessionCookieMinter,
  createTangleSsoHandlers,
  createAuthGuard,
  guardResolution,
  parseAdminEmails,
  createAdminGuard,
  assertBillableBalance
};
//# sourceMappingURL=chunk-BNFR6YQF.js.map