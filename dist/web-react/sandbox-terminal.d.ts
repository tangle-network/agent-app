/** Define the connection details and status for a sandbox terminal session */
export interface SandboxTerminalConnection {
    runtimeUrl: string | null;
    sidecarUrl: string | null;
    token: string | null;
    expiresAt: string | null;
    status: string;
    error: string | null;
    loading: boolean;
    sandboxId?: string;
    connectionId?: string;
}
/**
 * Define the response structure for a sandbox terminal connection including URLs, token, status, and errors
 *
 * The browser-direct scoped-token route (`createSandboxTerminalConnectionRoute`,
 * `src/sandbox/terminal-connection.ts`) returns `sidecarUrl`. The hook also
 * exposes that URL through the historical `runtimeUrl` state field so existing
 * terminal panels do not need transport-specific branching.
 *
 * `connectionId` is the id the route's minted token's `sid` is bound to
 * (echoed back from the `connectionId` the hook sent) — pass it straight
 * through as `TerminalView`'s `connectionId` prop, since any other value
 * fails the WS upgrade on the current platform.
 */
export interface SandboxTerminalConnectionResponse {
    runtimeUrl?: string;
    sidecarUrl?: string;
    token?: string;
    expiresAt?: string;
    status?: string;
    error?: string;
    sandboxId?: string;
    connectionId?: string;
}
/**
 * Define options for configuring a sandbox terminal connection including workspace ID and connection parameters
 *
 * `connectionId`, when set, is passed to
 * `createSandboxTerminalConnectionRoute` as the `connectionId` query
 * parameter — pass `tabTerminalConnectionId()` here so the route mints a
 * token whose `sid` is bound to the same id `TerminalView` will dial. Give
 * `TerminalView` the response's echoed `connectionId` (not this input
 * value) alongside `sidecarUrl` as `apiUrl` and `token`, since a product's
 * `resolveConnectionId` seam may rewrite it server-side.
 */
export interface UseSandboxTerminalConnectionOptions {
    workspaceId: string;
    connectionUrl?: string | ((workspaceId: string) => string);
    connectionId?: string;
    fetcher?: typeof fetch;
    provisionPollIntervalMs?: number;
    provisionPollTimeoutMs?: number;
    tokenRefreshSkewMs?: number;
}
/** Resolve sandbox terminal connection status and provide a method to initiate the connection */
export interface UseSandboxTerminalConnectionResult extends SandboxTerminalConnection {
    connect: () => Promise<void>;
}
/**
 * Manage and maintain a sandbox terminal connection with automatic polling and token refresh handling
 *
 * `connectionUrl` is backed by the browser-direct scoped-token route
 * (`createSandboxTerminalConnectionRoute`,
 * `src/sandbox/terminal-connection.ts`). The route returns `sidecarUrl`; the
 * hook normalizes it into both URL fields for compatibility with existing
 * terminal panels.
 *
 * Pass `tabTerminalConnectionId()` as `opts.connectionId` — the hook forwards
 * it as the `connectionId` query parameter the browser-direct route requires
 * to mint a token whose `sid` is bound to that exact id (the orchestrator's
 * terminal WS gate fails closed on any other value). Give `TerminalView` the
 * RESULT's echoed `connectionId` (not the input value — a product's
 * `resolveConnectionId` seam may rewrite it), the resolved `sidecarUrl`/
 * `runtimeUrl` as `apiUrl`, and `token` as its token prop.
 */
export declare function useSandboxTerminalConnection(opts: UseSandboxTerminalConnectionOptions): UseSandboxTerminalConnectionResult;
/**
 * Stable-per-tab, unique-per-client terminal connection id.
 *
 * Persists in `sessionStorage` so a reload in the same tab reuses the id (the
 * sidecar restores the same PTY session via `TerminalView.connectionId`), while
 * separate tabs/windows each get a distinct id. Pass the result as
 * `TerminalView`'s `connectionId`. Without it (e.g. gtm-agent today) every tab
 * shares one connection id and their reconnects evict each other.
 *
 * Falls back to an ephemeral id when `sessionStorage` is unavailable (SSR,
 * privacy mode) — still unique per call, just not reload-stable.
 */
export declare function tabTerminalConnectionId(storageKey?: string): string;
