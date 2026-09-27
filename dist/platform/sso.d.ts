/**
 * Tangle SSO for agent apps. OIDC callers use the registered runtime client
 * with S256 PKCE. Legacy API-key callers remain explicit during migration.
 * OIDC never falls back to cross-site exchange. Account matching and native
 * session cookie minting remain shared.
 */
import type { OidcTokens, PlatformOidcClient } from '@tangle-network/agent-runtime/platform';
/** Define configuration options for managing SSO state including secret, lifetime, and clock injection */
export interface SsoStateConfig {
    /** HMAC-SHA256 secret (e.g. the app's auth secret). */
    secret: string;
    /** State lifetime in ms. Default 600 000. */
    ttlMs?: number;
    /** Injectable clock (ms since epoch). Default Date.now. */
    now?: () => number;
}
/** Mint a `<randomHex32>.<timestamp36>.<hmacHex>` state value. The timestamp
 *  is inside the signed payload, so expiry survives cookie-attribute tampering. */
export declare function createSignedSsoState(config: SsoStateConfig): Promise<string>;
/** Verify the MAC (constant-time) and the signed TTL. */
export declare function verifySignedSsoState(state: string, config: SsoStateConfig): Promise<boolean>;
/** Describe the result of exchanging SSO credentials including API key, user info, and optional plan details */
export interface TangleSsoExchangeResult {
    apiKey: string;
    /** The platform's canonical verified-email proof. */
    emailVerified: boolean;
    user: {
        id: string;
        email: string;
        name?: string | null;
    };
    plan?: {
        tier: string;
    } | null;
}
/** Structural mirror of the platform auth wire client — any object with these
 *  two methods satisfies it without this module importing the concrete class. */
export interface TangleSsoAuthClient {
    authorizeUrl(options: {
        state: string;
        redirectUri?: string;
    }): string;
    exchange(code: string): Promise<TangleSsoExchangeResult>;
}
/** The runtime owns the OIDC wire protocol and its types. */
export type TangleOidcSsoAuthClient = Pick<PlatformOidcClient, 'authorizeUrl' | 'exchange' | 'refresh' | 'userinfo' | 'revoke'>;
/** Local account shape required by the verified Tangle SSO account policy.
 * Consumers map their user/link tables into this shape before resolving an
 * exchange. */
export interface TangleSsoLocalAccount {
    userId: string;
    email: string;
    emailVerified: boolean;
    platformUserId: string | null;
}
/** Reasons a local account lookup must stop instead of linking an exchange. */
export type TangleSsoAccountConflictReason = 'ambiguous-platform-id' | 'platform-id-email-conflict' | 'unverified-email' | 'email-platform-id-conflict' | 'ambiguous-email' | 'invalid-platform-id' | 'invalid-email' | 'platform-match-mismatch' | 'email-match-mismatch';
/** Result of applying the verified Tangle SSO account matching policy. */
export type TangleSsoAccountResolution = {
    kind: 'existing';
    userId: string;
    matchedBy: 'platform-id' | 'verified-email';
} | {
    kind: 'create';
} | {
    kind: 'reject';
    reason: TangleSsoAccountConflictReason;
};
/** Inputs for {@link resolveTangleSsoAccount}. `platformUserId` is the
 * platform's stable identity. */
export interface TangleSsoAccountResolutionInput {
    email: string;
    platformMatches: readonly TangleSsoLocalAccount[];
    emailMatches: readonly TangleSsoLocalAccount[];
    platformUserId: string;
}
/** Normalize an email for comparisons and persistence queries. */
export declare function normalizeTangleSsoEmail(email: string): string;
/**
 * Resolve a platform exchange against all local rows found by stable platform
 * identity and normalized email.
 *
 * A stable platform id takes precedence over email. Every ambiguous or
 * contradictory result rejects, and email fallback requires a verified local
 * email that is not already bound to another platform id. The resolver is
 * pure so each consumer can query its own schema, including schemas without
 * unique indexes, then rerun it after an insert race.
 */
export declare function resolveTangleSsoAccount(input: TangleSsoAccountResolutionInput): TangleSsoAccountResolution;
/** Thrown by an account store when the verified SSO policy rejects a link. */
export declare class TangleSsoAccountConflictError extends Error {
    readonly reason: TangleSsoAccountConflictReason;
    constructor(reason: TangleSsoAccountConflictReason, message?: string);
}
/** Thrown by `upsertUserByEmail` when the app-local user row cannot be
 *  created; the callback handler maps it to `?error=tangle_user_create_failed`.
 *  Any other store error propagates. */
export declare class TangleSsoUserCreateError extends Error {
    constructor(message?: string);
}
/**
 * Account persistence seam. Covers both storage styles in use: link-table
 * apps (a per-user platform-link row) and session-column apps (the key on the
 * session row) — `saveTangleLink` receives both `userId` and `sessionToken`,
 * and each app persists with the key it needs. `createSession` runs first so
 * the token is always available to `saveTangleLink`.
 */
export interface TangleSsoAccountStore {
    /** Resolve the local account before any user, session, or link write.
     * Implementations must query every candidate by stable platform id and
     * normalized email, then apply `resolveTangleSsoAccount` (or an equivalent
     * fail-closed policy). The callback rejects `kind: 'reject'` results before
     * it calls `upsertUserByEmail`. */
    resolveAccount(input: {
        email: string;
        platformUserId: string;
    }): Promise<TangleSsoAccountResolution>;
    /** Find-or-create the app-local user selected by `resolveAccount`.
     * `tangleUserId` is the platform's stable user id — match on it first when
     * the app stores it (emails are mutable on the platform; the id is not),
     * falling back to email for first-time logins. */
    upsertUserByEmail(input: {
        email: string;
        name: string | null;
        tangleUserId: string;
        resolution: Exclude<TangleSsoAccountResolution, {
            kind: 'reject';
        }>;
    }): Promise<{
        userId: string;
    }>;
    /** Create an app session row; returns the session-cookie token value. */
    createSession(input: {
        userId: string;
        expiresAt: Date;
        ipAddress: string | null;
        userAgent: string | null;
    }): Promise<{
        token: string;
    }>;
    /** Persist the platform link (API key + platform identity). */
    saveTangleLink(input: {
        userId: string;
        sessionToken: string;
        tangleUserId: string;
        email: string;
        name: string | null;
        apiKey: string;
        planTier: string | null;
    }): Promise<void>;
}
/**
 * OIDC tokens are server-side credentials, not API keys. Implementations must
 * encrypt them at rest and bind them to the exact local session. Refresh and
 * disconnect must serialize updates to the same grant.
 */
export interface TangleOidcSsoAccountStore extends Omit<TangleSsoAccountStore, 'saveTangleLink'> {
    saveTangleLink(input: {
        userId: string;
        sessionToken: string;
        tangleUserId: string;
        email: string;
        name: string | null;
        tokens: OidcTokens;
        accessTokenExpiresAt: Date;
    }): Promise<void>;
    /** Remove an unpublished local session if callback persistence fails. */
    deleteSession(input: {
        sessionToken: string;
    }): Promise<void>;
}
/** Successful-login context handed to the `setSessionCookie` seam. */
export interface TangleSsoSessionCookieArgs {
    /** Session token returned by `store.createSession`. */
    token: string;
    /** Session expiry (now + `sessionTtlSeconds`). */
    expiresAt: Date;
    /** Mirrors `sessionTtlSeconds` after defaulting. */
    ttlSeconds: number;
    /** Mirrors `TangleSsoHandlerOptions.secureCookies`. */
    secure: boolean;
}
/**
 * Sign a session token to better-call's signed-cookie contract — the value
 * better-auth's `getSignedCookie` verifies: `<token>.<signature>` where the
 * signature is the raw HMAC-SHA256 of the token under `secret`, encoded as
 * STANDARD base64 WITH padding (32 bytes → 44 chars ending `=`; better-call
 * rejects any other length or suffix, so url-safe/unpadded variants read back
 * as a null session). The joined value is percent-encoded once at cookie
 * serialization, matching better-call's `serializeSignedCookie` byte-exactly.
 */
export declare function signSessionCookieValue(token: string, secret: string): Promise<string>;
/** Structural slice of a `betterAuth()` instance — only what cookie minting
 *  reads. No better-auth import: the signing contract is implemented by
 *  `signSessionCookieValue`, byte-compatible with better-auth's own
 *  `makeSignature`. */
export interface BetterAuthSessionCookieSource {
    $context: PromiseLike<{
        secret: string;
        authCookies: {
            sessionToken: {
                /** Final cookie name — better-auth decides the `__Secure-` prefix
                 *  (and any `advanced.cookiePrefix`) once at `betterAuth()` init. */
                name: string;
                attributes: {
                    secure?: boolean;
                    sameSite?: string;
                    path?: string;
                    httpOnly?: boolean;
                    domain?: string;
                };
            };
        };
    }>;
}
/** Define options to customize warning behavior for shadowed cookie names in authentication sessions */
export interface BetterAuthSessionCookieMinterOptions {
    /** Receives the shadowed-cookie-name warning (see below). Default
     *  console.warn. */
    warn?: (message: string) => void;
}
/**
 * Canonical `setSessionCookie` wiring for better-auth apps: mint the session
 * Set-Cookie exactly as better-auth's own login flows do — name + attributes
 * from `auth.$context.authCookies.sessionToken` (better-auth stays
 * authoritative over prefix/name/attributes) and the value signed to
 * better-call's `getSignedCookie` contract. A raw unprefixed
 * `better-auth.session_token` left by an earlier login is explicitly expired
 * so it cannot shadow the real cookie.
 *
 * Warns when the app's session cookie still has better-auth's DEFAULT name:
 * the Tangle platform (id.tangle.tools) sets a `Domain=.tangle.tools` cookie
 * under that exact name, and equal-path cookies are sent oldest-first — the
 * platform's cookie is always older (the user signs in there before the app's
 * callback runs), so the app reads the platform's token, fails its own
 * signature check, and every fresh login lands logged-out. Per-app
 * `advanced.cookiePrefix` is the fix.
 *
 * Throws on a domain-scoped session cookie for the same reason: a
 * `Domain=`-wide session cookie is exactly the shadowing footgun.
 */
export declare function createBetterAuthSessionCookieMinter(auth: BetterAuthSessionCookieSource, options?: BetterAuthSessionCookieMinterOptions): (args: TangleSsoSessionCookieArgs) => Promise<string[]>;
/** Define configuration options for handling Tangle SSO authentication and session management */
export interface TangleSsoHandlerOptions {
    protocol?: 'legacy';
    auth: TangleSsoAuthClient;
    store: TangleSsoAccountStore;
    /** HMAC secret for the state cookie. */
    stateSecret: string;
    /** Absolute callback URL registered with the platform. */
    callbackUrl: string;
    stateCookieName: string;
    /** Default 'better-auth.session_token'. Ignored when `setSessionCookie` is
     *  provided. The default path prepends `__Secure-` iff `secureCookies`. */
    sessionCookieName?: string;
    /** Mint the host auth framework's own session cookie(s); return complete
     *  Set-Cookie header values (the handler appends them verbatim and sets no
     *  session cookie itself). Supply this when the framework should stay
     *  authoritative over name/prefix/signing/attributes — e.g. better-auth:
     *  `auth.$context.authCookies.sessionToken` + `makeSignature`. */
    setSessionCookie?: (args: TangleSsoSessionCookieArgs) => readonly string[] | Promise<readonly string[]>;
    /** HMAC-SHA256 secret the host auth framework verifies session cookies with
     *  (better-auth: its `secret`). Required when `setSessionCookie` is absent —
     *  the default cookie is minted to better-call's signed contract via
     *  `signSessionCookieValue`; an unsigned or mis-signed value reads back as a
     *  null session, so there is deliberately no fallback to `stateSecret`
     *  (which is not guaranteed to be the auth secret). */
    sessionCookieSecret?: string;
    /** Adds `Secure` to every cookie this module sets, and (default session
     *  cookie only) the `__Secure-` name prefix. Must match the auth
     *  framework's own secure-cookie decision (better-auth: https `baseURL` /
     *  `advanced.useSecureCookies`), or it will look up a different cookie name
     *  than the one set here. */
    secureCookies: boolean;
    /** Default 604 800 (7 days). */
    sessionTtlSeconds?: number;
    /** Default 600. Applies to both the cookie Max-Age and the signed TTL. */
    stateTtlSeconds?: number;
    /** Default '/app'. */
    defaultRedirectPath?: string;
    /** Default '/login'. */
    loginPath?: string;
    /** Failure log hook (e.g. console.error). Default no-op. */
    log?: (message: string, error?: unknown) => void;
    now?: () => number;
}
/** Registered OIDC client with a separate token persistence contract. */
export interface TangleOidcSsoHandlerOptions extends Omit<TangleSsoHandlerOptions, 'protocol' | 'auth' | 'store'> {
    protocol: 'oidc';
    auth: TangleOidcSsoAuthClient;
    store: TangleOidcSsoAccountStore;
}
/** Define handlers for SSO start and callback routes managing authentication flow and session cookies */
export interface TangleSsoHandlers {
    /** GET start route: mint + sign state, set the state cookie, 302 to the
     *  platform authorize URL. `?redirect=` carries the post-login path. */
    start(request: Request): Promise<Response>;
    /** GET callback route: verify state, exchange the code, upsert the user,
     *  create the session, save the platform link, set the session cookie
     *  (via the `setSessionCookie` seam, else signed to better-call's contract
     *  with `sessionCookieSecret`), 302 to the saved redirect. Every failure
     *  302s to `loginPath?error=…` with the state cookie cleared. */
    callback(request: Request): Promise<Response>;
}
/** Create Tangle SSO handlers to manage authentication state, callbacks, and session cookies */
export declare function createTangleSsoHandlers(opts: TangleSsoHandlerOptions | TangleOidcSsoHandlerOptions): TangleSsoHandlers;
