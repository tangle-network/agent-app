/**
 * Dependency-free WebCrypto primitives for HMAC-signed, base64url-encoded
 * tokens — base64url encode/decode, HMAC-SHA256, and a constant-time compare.
 * Runs on Cloudflare Workers, Node, and the browser with no Node `crypto`
 * dependency. Shared by the sandbox terminal-proxy token, the WS-upgrade token
 * parser, and the app-tool capability token so the logic lives in one place
 * rather than three near-identical private copies.
 *
 * Internal leaf: not exported from the `/crypto` barrel (that subpath is the
 * AES-GCM field-crypto surface); imported directly by the modules that need it.
 */
/** base64url-encode raw bytes (RFC 4648 §5, no padding). */
export declare function base64UrlEncode(bytes: Uint8Array): string;
/** base64url-encode a UTF-8 string. */
export declare function base64UrlEncodeText(text: string): string;
/** Decode a base64url string back to its UTF-8 text. Re-pads before `atob` so
 *  unpadded input decodes correctly regardless of the runtime's leniency. */
export declare function base64UrlDecodeText(value: string): string;
/** HMAC-SHA256 `message` under `secret`, returned base64url-encoded. */
export declare function hmacSha256Base64Url(message: string, secret: string): Promise<string>;
/** Length-independent-leak-free compare of two same-charset strings. */
export declare function constantTimeEqual(a: string, b: string): boolean;
