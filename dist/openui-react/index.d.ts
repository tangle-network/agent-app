/**
 * `@tangle-network/agent-app/openui-react` — the missing `onAction`.
 *
 * The OpenUI renderer takes an `onAction` handler and does nothing when the
 * host omits it, which is what left every button on an agent-authored page
 * inert. This hook is the handler: it holds the page's field values, posts a
 * pressed action to ONE product REST endpoint, and hands back the reply —
 * a message, corrected values, a replacement page.
 *
 * It reaches the product route and nothing else. There is no chat stream here,
 * no turn start, no sandbox: a user dragging a slider on a page the agent wrote
 * costs exactly one product request, the same as a hand-built screen. Tests
 * enforce that by walking this module's imports.
 */
import type { OpenUIFieldIssue, OpenUIFormValues, OpenUINode, OpenUIValue } from '../openui/index';
/** A successful action reply, as the route sends it. */
export interface OpenUIActionResponse<TNode extends OpenUINode = OpenUINode> {
    ok: true;
    actionId: string;
    message?: string;
    values?: OpenUIFormValues;
    schema?: TNode | TNode[];
    data?: Record<string, unknown>;
}
/** A refused action, as the route sends it. */
export interface OpenUIActionFailure {
    code: string;
    error: string;
    actionId?: string;
    issues?: OpenUIFieldIssue[];
}
/** The boundary outcome: the reply, or the reason there is none. */
export type OpenUIActionOutcome<TNode extends OpenUINode = OpenUINode> = {
    succeeded: true;
    value: OpenUIActionResponse<TNode>;
} | {
    succeeded: false;
    error: OpenUIActionFailure;
};
/** Where on the page an action fired, and what the form held at that moment.
 *  A renderer that owns form state passes `values`; otherwise the hook's own
 *  `values` are sent. */
export interface OpenUIActionContext {
    formId?: string;
    nodeId?: string;
    values?: OpenUIFormValues;
}
/** How the hook talks to the product route. */
export interface UseOpenUIActionsOptions<TNode extends OpenUINode = OpenUINode> {
    /** The product's action endpoint — a plain REST route, never a chat route. */
    endpoint: string;
    /** Extra routing fields merged into every POST body (workspaceId, threadId).
     *  Reserved keys (`actionId`, `formId`, `values`, `nodeId`, `artifactPath`)
     *  always win. */
    body?: Record<string, string | number | boolean>;
    /** Vault path of the persisted page, when the product renders one. */
    artifactPath?: string;
    /** Seed values, e.g. the `value` each field was authored with. */
    initialValues?: OpenUIFormValues;
    headers?: Record<string, string>;
    /** Injection seam for tests; defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
    /** Called with every settled outcome, success or failure. */
    onResult?: (outcome: OpenUIActionOutcome<TNode>) => void;
}
/** What the hook returns. `onAction` is the renderer prop; the rest is state a
 *  card renders around it. */
export interface OpenUIActionsController<TNode extends OpenUINode = OpenUINode> {
    /** Current field values. */
    values: OpenUIFormValues;
    /** Set one field. */
    setValue: (fieldId: string, value: OpenUIValue) => void;
    /** Replace all fields. */
    setValues: (next: OpenUIFormValues) => void;
    /** Back to `initialValues`. */
    resetValues: () => void;
    /**
     * Pass straight to the renderer's `onAction`. Fire-and-forget; read the
     * result from this controller's state or from `onResult`.
     */
    onAction: (action: {
        id: string;
    }, context?: OpenUIActionContext) => void;
    /** The awaitable form of `onAction`, for a product's own buttons. */
    submit: (action: {
        id: string;
    }, context?: OpenUIActionContext) => Promise<OpenUIActionOutcome<TNode>>;
    /** The action currently in flight, if any. */
    pendingActionId: string | null;
    /** The last failure, cleared when the next action starts. */
    error: OpenUIActionFailure | null;
    /** The last success message, cleared when the next action starts. */
    message: string | null;
    /** A replacement page from the last success, to render instead of the original. */
    schema: TNode[] | null;
    /** Free-form payload from the last success. */
    data: Record<string, unknown> | null;
}
/**
 * Make an agent-authored page interactive.
 *
 * ```tsx
 * const ui = useOpenUIActions({ endpoint: '/api/openui/action', body: { workspaceId } })
 * <OpenUIArtifactRenderer schema={ui.schema ?? nodes} onAction={ui.onAction} />
 * {ui.error && <p role="alert">{ui.error.error}</p>}
 * ```
 *
 * One action runs at a time: pressing a second button while the first is in
 * flight is refused with `OPENUI_ACTION_BUSY` rather than racing two writes
 * against the same form.
 */
export declare function useOpenUIActions<TNode extends OpenUINode = OpenUINode>(options: UseOpenUIActionsOptions<TNode>): OpenUIActionsController<TNode>;
/** The body keys the hook owns; a product's extra `body` fields cannot shadow
 *  them. Exported so a route's own tests can assert the same list. */
export declare const OPENUI_RESERVED_BODY_KEYS: readonly string[];
