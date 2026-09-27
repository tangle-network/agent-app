/**
 * Per-user capability token — the sandbox→app auth primitive behind the
 * `verifyToken` seam in {@link authenticateToolRequest}.
 *
 * An app-agent runs inside the sandbox and reaches the host app back over HTTP
 * (the app tools, the integration-invoke bridge). The route must act AS the
 * connecting user without trusting any model-supplied identity, so the turn
 * mints a short HMAC token bound to the user id and bakes it into the per-turn
 * MCP server header; the route verifies it to recover the user.
 *
 * `HMAC-SHA256(secret, "user:<userId>")`, base64url, with an app-chosen prefix.
 * The token encodes no scopes — the hub's policy engine authorizes per action.
 * Fail-closed: with no secret, no token is minted (the caller MUST omit the MCP
 * server rather than fake an authorized call). WebCrypto only — runs on
 * Workers, Node, and the browser with no Node `crypto` dependency.
 */
/** Define options for creating and verifying capability tokens including secret and prefix */
export interface CapabilityTokenOptions {
    /** Shared HMAC secret. When absent, mint returns undefined / verify returns false. */
    secret?: string;
    /** Token prefix (namespaces the credential; lets verify reject foreign tokens
     *  cheaply). Default `cap_`. */
    prefix?: string;
}
/** Mint a capability token for `userId`, or `undefined` when no secret is
 *  configured (fail-closed — the caller omits the MCP server rather than fake it). */
export declare function createCapabilityToken(userId: string, opts: CapabilityTokenOptions): Promise<string | undefined>;
/** Verify a capability token against `userId`. Returns false (never throws) for
 *  an unconfigured secret, a wrong prefix, a malformed token, or a mismatch. */
export declare function verifyCapabilityToken(userId: string, token: string, opts: CapabilityTokenOptions): Promise<boolean>;
/** Define options for capability tokens that expire after a specified lifetime in milliseconds */
export interface ExpiringCapabilityTokenOptions extends CapabilityTokenOptions {
    /** Token lifetime. Expired tokens verify false regardless of signature. */
    expiresInMs: number;
    /** Clock injection for tests; defaults to Date.now. */
    now?: () => number;
}
/**
 * Mint an EXPIRING capability token: `<prefix><base64url(payload)>.<sig>` where
 * the payload carries `{ sub, exp, n }` (subject, epoch-ms expiry, random
 * nonce) and the signature is HMAC-SHA256 over the encoded payload. Use this
 * for user-initiated scoped channels (e.g. a per-sequence MCP endpoint) where
 * a captured token must not stay valid past its window; the bare
 * {@link createCapabilityToken} remains for turn-scoped tool bridges whose
 * mint+verify happen inside one request cycle. Fail-closed like the bare
 * variant: no secret → no token.
 */
export declare function createExpiringCapabilityToken(subject: string, opts: ExpiringCapabilityTokenOptions): Promise<string | undefined>;
/** Verify an expiring token against `subject`: prefix, payload integrity,
 *  subject match, and expiry all checked; returns false (never throws) on any
 *  failure including a malformed payload. */
export declare function verifyExpiringCapabilityToken(subject: string, token: string, opts: CapabilityTokenOptions & {
    now?: () => number;
}): Promise<boolean>;
