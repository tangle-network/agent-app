/** `{ success: false }` codes the hub returns on `/exec`. */
export type HubExecErrorCode = 'HUB_APPROVAL_REQUIRED' | 'HUB_POLICY_DENIED' | 'HUB_CONNECTION_MISSING' | 'HUB_CONNECTION_REVOKED' | 'HUB_CONFIG_MISSING' | 'HUB_NOT_FOUND' | string;
/** Outcome of a hub `/exec` call. Callers MUST inspect `succeeded` before
 *  reading `result` — a denied or approval-gated write resolves with
 *  `succeeded: false` and a populated `code`, never a thrown silent failure. */
export type HubExecResult = {
    succeeded: true;
    result: unknown;
} | {
    succeeded: false;
    code: HubExecErrorCode;
    message: string;
    approval?: unknown;
};
/** Define configuration options for initializing a Hub execution client */
export interface HubExecClientOptions {
    /** Platform base URL (e.g. `TANGLE_PLATFORM_URL`). */
    baseUrl: string;
    /** Calling user's Tangle API key — the hub principal bearer. */
    bearer: string;
    /** Test seam. Defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}
/** The provider/connector/action a hub action path addresses, plus the dotted
 *  `path` the hub `/exec` endpoint expects. */
export interface ParsedIntegrationAction {
    providerId: string;
    connectorId: string;
    actionId: string;
    /** `provider.connector.action`. */
    path: string;
}
/**
 * Resolve an MCP tool name (the opaque `int_…` catalog name the agent calls)
 * into the dotted hub action path. Returns `undefined` when the name is not a
 * catalog integration tool, so the chat loop routes non-integration calls
 * elsewhere instead of misrouting them to the hub.
 */
export declare function resolveIntegrationAction(toolName: string): ParsedIntegrationAction | undefined;
/** Typed client over the platform hub `/v1/hub/exec`. The hub holds the user's
 *  credentials, resolves the connection from the bearer principal, evaluates
 *  per-action policy (read → allow, write/destructive → approval), and runs the
 *  action server-side. Never throws on a policy block — a gated write is a
 *  normal `succeeded: false` outcome. */
export declare class HubExecClient {
    private readonly baseUrl;
    private readonly bearer;
    private readonly fetchImpl;
    constructor(options: HubExecClientOptions);
    exec(input: {
        path: string;
        actionInput?: unknown;
        connectionId?: string;
    }): Promise<HubExecResult>;
    private readEnvelope;
}
/** Define input parameters for invoking a hub tool with user ID, tool name, and optional arguments */
export interface HubInvokeInput {
    userId: string;
    /** The MCP tool name the agent called (`int_<provider>_<connector>_<action>`). */
    toolName: string;
    args?: Record<string, unknown>;
}
/** Describe the outcome of a hub invocation including status and response body */
export interface HubInvokeOutcome {
    status: number;
    body: Record<string, unknown>;
}
/** Define dependencies for invoking hub operations including API key resolution and optional configuration */
export interface HubInvokeDeps {
    /** Resolve the user's Tangle API key (the hub principal bearer). Required —
     *  the product binds its own session-key resolver. Null → user not linked. */
    apiKeyResolver: (userId: string) => Promise<string | null>;
    /** Platform base URL. Defaults to `env.TANGLE_PLATFORM_URL`. */
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
}
/**
 * Resolve + execute one integration tool call through the hub: resolve the
 * per-user bearer, map the MCP tool name to the hub action path, forward to
 * `/v1/hub/exec`, and shape the route response (200 ok / 401 not-linked /
 * 400 unknown-tool / 409 approval-required / 502 hub-error). A write that's
 * approval-gated surfaces verbatim as 409, never silently executed.
 */
export declare function invokeIntegrationHub(input: HubInvokeInput, deps: HubInvokeDeps): Promise<HubInvokeOutcome>;
