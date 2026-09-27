/**
 * Splitting an assistant message into prose and agent-authored UI.
 *
 * An agent emits a page by fencing it as ```` ```openui ```` in its reply (the
 * inline path) or by calling `render_ui` (the persisted-artifact path). Every
 * product that renders the inline path had forked the same scanner into its own
 * chat-message body; this is that scanner, once, with no React and no renderer
 * import — the node union stays owned by `@tangle-network/ui`'s `./openui`.
 */
/**
 * The narrowest thing a host can assert about a parsed node: it names a type.
 * A renderer's node union satisfies this, so
 * `parseOpenUISegments<OpenUIComponentNode>(text)` hands typed nodes straight
 * to the renderer with no cast at the call site.
 */
export interface OpenUINode {
    type: string;
    id?: string;
}
/** One piece of an assistant message: prose, or a page to render. */
export type OpenUISegment<TNode extends OpenUINode = OpenUINode> = {
    type: 'markdown';
    text: string;
} | {
    type: 'openui';
    nodes: TNode[];
};
/**
 * Split message content into markdown and OpenUI segments, in source order.
 *
 * A fence whose body is not JSON, or whose JSON carries no node at all, is
 * returned as a fenced `json` markdown segment rather than an empty page: the
 * content is still streaming, or the agent wrote something malformed, and both
 * cases are better shown than swallowed into a blank card.
 *
 * The type argument is the caller's assertion about the node union it will
 * render; this function checks only that each node names a `type`, and the
 * renderer rejects types it does not know.
 */
export declare function parseOpenUISegments<TNode extends OpenUINode = OpenUINode>(content: string): Array<OpenUISegment<TNode>>;
/** Whether a message carries any agent-authored page at all. */
export declare function hasOpenUISegment(content: string): boolean;
/** A page read back out of the vault, and its title when one was stored. */
export interface OpenUIArtifact<TNode extends OpenUINode = OpenUINode> {
    title?: string;
    nodes: TNode[];
}
/** Why a stored page could not be read. */
export interface OpenUIArtifactError {
    code: 'artifact_not_json' | 'artifact_no_nodes';
    message: string;
}
/** Reading a stored page either produces nodes or says why it did not. */
export type OpenUIArtifactResult<TNode extends OpenUINode = OpenUINode> = {
    succeeded: true;
    value: OpenUIArtifact<TNode>;
} | {
    succeeded: false;
    error: OpenUIArtifactError;
};
/**
 * Read a `render_ui` artifact back out of the vault.
 *
 * Two shapes are in the wild and a product cannot tell them apart from the
 * path: the bare node tree that `preset-cloudflare`'s handler writes
 * (`JSON.stringify(args.schema)`), and the `{ title, schema }` envelope some
 * products write themselves. Reading only one of them renders an empty panel
 * for the other, with nothing on screen to say why — so this reads both and
 * fails loud when it is neither.
 */
export declare function parseOpenUIArtifact<TNode extends OpenUINode = OpenUINode>(content: string): OpenUIArtifactResult<TNode>;
