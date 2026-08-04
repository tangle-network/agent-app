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
  type: string
  id?: string
}

/** One piece of an assistant message: prose, or a page to render. */
export type OpenUISegment<TNode extends OpenUINode = OpenUINode> =
  | { type: 'markdown'; text: string }
  | { type: 'openui'; nodes: TNode[] }

const FENCE = /```openui\s*\n([\s\S]*?)```/g

function isNodeLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/** Every array entry (or the single object) that names a node type. */
function nodesFrom(parsed: unknown): unknown[] {
  const candidates = Array.isArray(parsed) ? parsed : [parsed]
  return candidates.filter(isNodeLike)
}

function pushText<TNode extends OpenUINode>(segments: Array<OpenUISegment<TNode>>, text: string): void {
  const trimmed = text.trim()
  if (trimmed) segments.push({ type: 'markdown', text: trimmed })
}

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
export function parseOpenUISegments<TNode extends OpenUINode = OpenUINode>(
  content: string,
): Array<OpenUISegment<TNode>> {
  const segments: Array<OpenUISegment<TNode>> = []
  let lastIndex = 0

  // `FENCE` carries the `g` flag and therefore `lastIndex` state; reset it so
  // concurrent/repeat calls cannot resume mid-string from a previous scan.
  FENCE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE.exec(content)) !== null) {
    if (match.index > lastIndex) pushText(segments, content.slice(lastIndex, match.index))
    const body = match[1] ?? ''
    let nodes: unknown[] = []
    try {
      nodes = nodesFrom(JSON.parse(body) as unknown)
    } catch {
      nodes = []
    }
    if (nodes.length > 0) segments.push({ type: 'openui', nodes: nodes as TNode[] })
    else pushText(segments, `\`\`\`json\n${body}\`\`\``)
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) pushText(segments, content.slice(lastIndex))
  if (segments.length === 0 && content.trim()) segments.push({ type: 'markdown', text: content })
  return segments
}

/** Whether a message carries any agent-authored page at all. */
export function hasOpenUISegment(content: string): boolean {
  return parseOpenUISegments(content).some((segment) => segment.type === 'openui')
}

/** A page read back out of the vault, and its title when one was stored. */
export interface OpenUIArtifact<TNode extends OpenUINode = OpenUINode> {
  title?: string
  nodes: TNode[]
}

/** Why a stored page could not be read. */
export interface OpenUIArtifactError {
  code: 'artifact_not_json' | 'artifact_no_nodes'
  message: string
}

/** Reading a stored page either produces nodes or says why it did not. */
export type OpenUIArtifactResult<TNode extends OpenUINode = OpenUINode> =
  | { succeeded: true; value: OpenUIArtifact<TNode> }
  | { succeeded: false; error: OpenUIArtifactError }

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
export function parseOpenUIArtifact<TNode extends OpenUINode = OpenUINode>(
  content: string,
): OpenUIArtifactResult<TNode> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    return { succeeded: false, error: { code: 'artifact_not_json', message: 'Stored page is not JSON.' } }
  }

  const envelope =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'schema' in parsed
      ? (parsed as { schema: unknown; title?: unknown })
      : null
  const nodes = nodesFrom(envelope ? envelope.schema : parsed)
  if (nodes.length === 0) {
    return { succeeded: false, error: { code: 'artifact_no_nodes', message: 'Stored page carries no nodes.' } }
  }
  const title = envelope && typeof envelope.title === 'string' ? envelope.title : undefined
  return { succeeded: true, value: { nodes: nodes as TNode[], ...(title ? { title } : {}) } }
}
