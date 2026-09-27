import {
  createAuthGuard,
  createBetterAuthSessionCookieMinter,
  createTangleSsoHandlers
} from "../chunk-BNFR6YQF.js";
import "../chunk-JML7WKWU.js";
import "../chunk-EA4UVS4T.js";
import "../chunk-TXD5HXLE.js";

// src/app-auth/index.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
var DEFAULT_STATE_COOKIE = "tangle_sso_state";
var DEFAULT_SESSION_COOKIE_CACHE_SECONDS = 5 * 60;
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function resolveEmailClient(email) {
  return typeof email.resend === "function" ? email.resend() : email.resend;
}
function deferDrizzleAdapter(db, config) {
  return (options) => {
    let adapter;
    const resolve = () => adapter ??= drizzleAdapter(db, config)(options);
    return {
      id: "drizzle",
      create: (data) => resolve().create(data),
      findOne: (data) => resolve().findOne(data),
      findMany: (data) => resolve().findMany(data),
      count: (data) => resolve().count(data),
      update: (data) => resolve().update(data),
      updateMany: (data) => resolve().updateMany(data),
      delete: (data) => resolve().delete(data),
      deleteMany: (data) => resolve().deleteMany(data),
      consumeOne: (data) => resolve().consumeOne(data),
      incrementOne: (data) => resolve().incrementOne(data),
      transaction: (callback) => resolve().transaction(callback)
    };
  };
}
async function sendEmail(client, message) {
  const result = await client.emails.send(message);
  if (result && typeof result === "object" && result.error) {
    throw new Error(`[app-auth] email send failed: ${result.error.message ?? "unknown error"}`);
  }
}
function resolveDatabase(config) {
  if (config.database) return config.database;
  if (config.db && config.schema) {
    return deferDrizzleAdapter(config.db, {
      provider: config.provider ?? "sqlite",
      schema: {
        user: config.schema.users,
        session: config.schema.sessions,
        account: config.schema.accounts,
        verification: config.schema.verifications
      }
    });
  }
  throw new Error(
    "createAppAuth requires a database: pass `db` + `schema` (drizzle) or `database` (a better-auth adapter)"
  );
}
function resolveSocialProviders(social) {
  const providers = {};
  if (social?.github?.clientId && social.github.clientSecret) {
    providers.github = { clientId: social.github.clientId, clientSecret: social.github.clientSecret };
  }
  if (social?.google?.clientId && social.google.clientSecret) {
    providers.google = { clientId: social.google.clientId, clientSecret: social.google.clientSecret };
  }
  return Object.keys(providers).length > 0 ? providers : void 0;
}
function emailAndPasswordOptions(config) {
  const email = config.email;
  if (!email) return { enabled: true };
  const warn = email.warn ?? ((message) => console.warn(message));
  return {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      const client = resolveEmailClient(email);
      if (!client) {
        warn("[app-auth] email client unavailable \u2014 password reset email not sent");
        return;
      }
      await sendEmail(client, {
        from: email.from,
        to: user.email,
        subject: "Reset your password",
        html: `<p>Click the link below to reset your password:</p><p><a href="${url}">${url}</a></p><p>This link expires in 1 hour.</p>`,
        text: `Reset your password:

${url}

This link expires in 1 hour.`
      });
    }
  };
}
function emailVerificationOptions(config) {
  const email = config.email;
  if (!email?.verifyOnSignUp) return void 0;
  const warn = email.warn ?? ((message) => console.warn(message));
  return {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      const client = resolveEmailClient(email);
      if (!client) {
        warn("[app-auth] email client unavailable \u2014 verification email not sent");
        return;
      }
      await sendEmail(client, {
        from: email.from,
        to: user.email,
        subject: `Verify your ${config.appName} email`,
        html: `<p>Verify your email to finish accessing ${config.appName}:</p><p><a href="${url}">${url}</a></p><p>This link expires in 1 hour.</p>`,
        text: `Verify your email to finish accessing ${config.appName}:

${url}

This link expires in 1 hour.`
      });
    }
  };
}
function createAppAuth(config) {
  if (!config.appName) throw new Error("createAppAuth: appName is required");
  if (!config.baseURL) throw new Error("createAppAuth: baseURL is required");
  const cookiePrefix = config.cookiePrefix ?? slugify(config.appName);
  if (!cookiePrefix) throw new Error("createAppAuth: cookiePrefix (or a slugifiable appName) is required");
  const socialProviders = resolveSocialProviders(config.social);
  const options = {
    appName: config.appName,
    baseURL: config.baseURL,
    ...config.secret ? { secret: config.secret } : {},
    ...config.trustedOrigins ? { trustedOrigins: config.trustedOrigins } : {},
    database: resolveDatabase(config),
    ...config.emailAndPassword === false ? {} : { emailAndPassword: emailAndPasswordOptions(config) },
    ...config.email?.verifyOnSignUp ? { emailVerification: emailVerificationOptions(config) } : {},
    ...socialProviders ? { socialProviders } : {},
    ...config.sessionCookieCacheSeconds === false ? {} : {
      session: {
        cookieCache: {
          enabled: true,
          maxAge: config.sessionCookieCacheSeconds ?? DEFAULT_SESSION_COOKIE_CACHE_SECONDS
        }
      }
    },
    advanced: { cookiePrefix, ...config.advanced }
  };
  const auth = betterAuth(options);
  const getSession = async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return session ?? null;
  };
  const loginPath = config.loginPath ?? "/login";
  const guard = createAuthGuard({ getSession, loginPath });
  let sso = null;
  if (config.sso) {
    const stateSecret = config.sso.stateSecret ?? config.secret;
    if (!stateSecret) {
      throw new Error(
        "createAppAuth: sso requires `secret` (or sso.stateSecret) \u2014 the signed-state CSRF cookie needs an HMAC secret"
      );
    }
    const transport = config.sso.protocol === "oidc" ? { protocol: "oidc", auth: config.sso.client, store: config.sso.store } : { protocol: "legacy", auth: config.sso.client, store: config.sso.store };
    sso = createTangleSsoHandlers({
      ...transport,
      stateSecret,
      callbackUrl: config.sso.callbackUrl,
      stateCookieName: config.sso.stateCookieName ?? DEFAULT_STATE_COOKIE,
      setSessionCookie: createBetterAuthSessionCookieMinter(auth),
      secureCookies: config.sso.secureCookies ?? config.baseURL.startsWith("https:"),
      ...config.sso.sessionTtlSeconds !== void 0 ? { sessionTtlSeconds: config.sso.sessionTtlSeconds } : {},
      ...config.sso.stateTtlSeconds !== void 0 ? { stateTtlSeconds: config.sso.stateTtlSeconds } : {},
      ...config.sso.defaultRedirectPath ? { defaultRedirectPath: config.sso.defaultRedirectPath } : {},
      loginPath: config.sso.loginPath ?? loginPath,
      ...config.sso.log ? { log: config.sso.log } : {}
    });
  }
  return { auth, getSession, ...guard, sso };
}
export {
  createAppAuth
};
//# sourceMappingURL=index.js.map