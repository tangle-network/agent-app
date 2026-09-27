/**
 * better-auth config factory for agent products (#188 Phase 1). Every product
 * hand-rolls the same ~70–150 line setup — drizzle adapter over the standard
 * users/sessions/accounts/verifications tables, email+password with Resend
 * reset/verification mail, env-gated GitHub/Google social providers, session
 * cookie cache, and a per-app cookie prefix — and tax additionally
 * re-implemented better-auth's cookie signing for its Tangle SSO callback.
 * `createAppAuth` owns that mechanism once and returns the configured
 * better-auth instance plus the request guards products actually use.
 *
 * Domain stays a parameter: the drizzle db + schema, email client, provider
 * credentials, and SSO store/client all come from the product. No product
 * import, no engine re-implementation — the SSO path composes the existing
 * `platform/sso` cookie minter (`createBetterAuthSessionCookieMinter`), which
 * is byte-compatible with better-auth's own `makeSignature` contract.
 *
 * better-auth is an OPTIONAL peer: only this subpath imports it, so it is
 * deliberately NOT re-exported from the root barrel.
 */
import { type Auth, type BetterAuthOptions, type Session, type User } from 'better-auth';
import { type AuthGuard } from '../platform/guards';
import { type TangleSsoAccountStore, type TangleSsoAuthClient, type TangleSsoHandlers, type TangleOidcSsoAccountStore, type TangleOidcSsoAuthClient } from '../platform/sso';
/** Structural slice of a Resend-style client — no `resend` import. */
export interface AppAuthEmailClient {
    emails: {
        send(message: {
            from: string;
            to: string;
            subject: string;
            html: string;
            text?: string;
        }): Promise<unknown>;
    };
}
/** Define email configuration for app authentication including client, sender, verification, and warning options */
export interface AppAuthEmailConfig {
    /** A Resend-style client, or a lazy getter returning null when the API key
     *  is absent (the products' dev default — mail is skipped with a warning,
     *  sign-up itself must not crash). */
    resend: AppAuthEmailClient | (() => AppAuthEmailClient | null);
    /** RFC 5322 From, e.g. `'Legal Agent <noreply@legal.tangle.tools>'`. */
    from: string;
    /** Send a verification email on sign-up and auto-sign-in after verifying
     *  (the tax/gtm behavior). Default false (the legal behavior). */
    verifyOnSignUp?: boolean;
    /** Receives the "email client unavailable" warning. Default console.warn. */
    warn?: (message: string) => void;
}
/** Env-shaped: pass the env vars straight through; the provider is registered
 *  only when BOTH values are non-empty, so unset env disables it. */
export interface AppAuthSocialProviderConfig {
    clientId?: string;
    clientSecret?: string;
}
/** Define social authentication configuration options for GitHub and Google providers */
export interface AppAuthSocialConfig {
    github?: AppAuthSocialProviderConfig;
    google?: AppAuthSocialProviderConfig;
}
/** Cross-site Tangle SSO wiring. The factory supplies the better-auth side —
 *  `setSessionCookie` via `createBetterAuthSessionCookieMinter(auth)` (signed
 *  `__Secure-`/prefixed cookie that `auth.api.getSession` accepts) — so the
 *  product no longer touches `better-auth/crypto` itself. */
export interface AppAuthSsoConfig {
    protocol?: 'legacy';
    /** Platform wire client (authorizeUrl + exchange). */
    client: TangleSsoAuthClient;
    /** Product persistence: user upsert, session row, platform link. */
    store: TangleSsoAccountStore;
    /** Absolute callback URL registered with the platform. */
    callbackUrl: string;
    /** Default 'tangle_sso_state'. */
    stateCookieName?: string;
    /** HMAC secret for the CSRF state cookie. Default: the auth `secret`. */
    stateSecret?: string;
    /** Default: `baseURL` is https. Must match better-auth's own
     *  secure-cookie decision or the cookie name lookup diverges. */
    secureCookies?: boolean;
    sessionTtlSeconds?: number;
    stateTtlSeconds?: number;
    /** Post-login redirect fallback. Default '/app'. */
    defaultRedirectPath?: string;
    /** Default: the top-level `loginPath`. */
    loginPath?: string;
    /** Failure log hook (e.g. console.error). Default no-op. */
    log?: (message: string, error?: unknown) => void;
}
/** Registered OIDC client configuration. Login does not mint an API key. */
export interface AppAuthOidcSsoConfig extends Omit<AppAuthSsoConfig, 'protocol' | 'client' | 'store'> {
    protocol: 'oidc';
    client: TangleOidcSsoAuthClient;
    store: TangleOidcSsoAccountStore;
}
/** Define the structure for application authentication data including users, sessions, accounts, and verifications */
export interface AppAuthSchema {
    users: unknown;
    sessions: unknown;
    accounts: unknown;
    verifications: unknown;
}
/** Define configuration settings for app authentication including app name, base URL, secrets, and trusted origins */
export interface AppAuthConfig {
    /** Product name — used in email subjects and as the cookie-prefix default. */
    appName: string;
    /** Absolute origin better-auth serves from (`BETTER_AUTH_URL`). */
    baseURL: string;
    /** better-auth HMAC secret. Optional only because better-auth falls back to
     *  the BETTER_AUTH_SECRET env var; `sso` needs it explicitly (or
     *  `sso.stateSecret`). */
    secret?: string;
    trustedOrigins?: string[];
    /**
     * Session-cookie prefix. Default: slugified `appName`. A per-app prefix is
     * load-bearing, not cosmetic: the platform (id.tangle.tools) mints its own
     * better-auth cookie `Domain=.tangle.tools`-wide under the DEFAULT name, and
     * the platform's (older) cookie wins the Cookie-header order — an app on the
     * default prefix reads the platform's token, fails its own signature check,
     * and every fresh login lands back on /login.
     */
    cookiePrefix?: string;
    /** Drizzle database instance; wired through better-auth's drizzle adapter
     *  together with `schema`. */
    db?: unknown;
    /** The product's users/sessions/accounts/verifications tables (mapped to
     *  better-auth's user/session/account/verification models). */
    schema?: AppAuthSchema;
    /** Drizzle dialect. Default 'sqlite' (D1). */
    provider?: 'sqlite' | 'pg' | 'mysql';
    /** Escape hatch: a pre-built better-auth database adapter (e.g.
     *  `memoryAdapter` in tests). Wins over `db`/`schema`. */
    database?: BetterAuthOptions['database'];
    /** Email+password sign-in. Default true (all current products enable it). */
    emailAndPassword?: boolean;
    /** Reset/verification mail. Omit to disable password reset entirely. */
    email?: AppAuthEmailConfig;
    social?: AppAuthSocialConfig;
    /** Session cookie-cache TTL in seconds; `false` disables the cache.
     *  Default 300. */
    sessionCookieCacheSeconds?: number | false;
    /** Tangle cross-site SSO (start/callback handlers). */
    sso?: AppAuthSsoConfig | AppAuthOidcSsoConfig;
    /** Where guards redirect unauthenticated page requests. Default '/login'. */
    loginPath?: string;
    /** Merged over the factory's `advanced` block (cookiePrefix stays unless
     *  overridden here). */
    advanced?: BetterAuthOptions['advanced'];
}
/** The configured better-auth instance, typed at better-auth's base surface
 *  (`handler`, `api`, `$context`, `$Infer`). */
export type AppAuthInstance = Auth;
/** What `getSession`/guards resolve: better-auth's base session + user rows. */
export interface AppAuthSession {
    session: Session;
    user: User;
}
/** Define authentication guard with session retrieval and optional SSO handlers for app requests */
export interface AppAuth extends AuthGuard<AppAuthSession> {
    auth: AppAuthInstance;
    /** `auth.api.getSession` over a `Request` — the seam the guards consume. */
    getSession(request: Request): Promise<AppAuthSession | null>;
    /** Tangle SSO start/callback handlers; null unless `sso` was configured. */
    sso: TangleSsoHandlers | null;
}
/**
 * Build the product's better-auth instance plus the request-boundary helpers:
 * `getSession` (Request → session|null), the `createAuthGuard` quartet
 * (`requireUser` 302, `requireApiUser` JSON 401, `requireSession`,
 * `getOptionalSession`), and — when `sso` is configured — the Tangle SSO
 * start/callback handlers with the session cookie minted through better-auth's
 * own name/attributes/signing (no `better-auth/crypto` in product code).
 */
export declare function createAppAuth(config: AppAuthConfig): AppAuth;
