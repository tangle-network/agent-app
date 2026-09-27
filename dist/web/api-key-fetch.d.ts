/** A credential-bearing client for one application origin, not a web fetch tool. */
export interface ApiKeyFetchOptions {
    origin: string;
    /** Resolve from trusted client secret storage; never from an agent's arguments. */
    getApiKey(): string | Promise<string>;
    fetchImpl?: typeof fetch;
    /** Explicit local-development opt-in; never permits remote plaintext origins. */
    allowHttpLoopback?: boolean;
}
export type ApiKeyFetch = (path: string, init?: RequestInit) => Promise<Response>;
/** No redirects, cookie fallback, hidden retries, or model-selected credential destination. */
export declare function createApiKeyFetch(options: ApiKeyFetchOptions): ApiKeyFetch;
