/** Message-thread and tool-rendering contracts. */
import type { ReactNode } from 'react'
import type { ChatAuthor } from '@tangle-network/ui/types'
import type { CatalogModel } from '../runtime/model-catalog'
import type { TurnPhaseData } from '../chat-routes/turn-progress'
import type { DurableChatCardsProps } from './durable-chat-cards'
import type { ChatAttachmentPart } from './chat-attachments'
import type { WorkProductPersistedPart } from '../work-product/types'
import type { ChatEmptyStateProps } from './chat-empty-state'

/** Describe metrics related to a chat message including model, token counts, and duration */
export interface ChatMessageMetrics {
  modelUsed?: string
  promptTokens?: number
  completionTokens?: number
  durationMs?: number
}

/** Describe the structure and state of a tool call within a chat interaction */
export interface ChatToolCallInfo {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  /** The call arguments, captured from the tool_call event — shown in the
   *  expanded card so users see exactly what the agent invoked. */
  args?: Record<string, unknown>
  /** The tool outcome (`{ok, result}` shape). When `result.status` is
   *  'queued_for_approval' the card renders the approval state. */
  result?: unknown
}

/** One ordered piece of an assistant turn: a run of answer text, or a tool
 *  call, in the sequence the agent emitted them. A message carrying `segments`
 *  is rendered in order — interleaving text and tool rows — so the agent's
 *  pre- and post-tool reasoning reads chronologically instead of as one text
 *  blob with the tool rows collected after it. */
export type ChatMessageSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; call: ChatToolCallInfo }
  /** An out-of-band transcript notice — a failed turn's error, a warning —
   *  rendered in its status tone so it never reads as answer prose. Map a
   *  persisted `notice` part (`noticeKind: 'error' | 'warning'`) to this. */
  | { kind: 'notice'; tone: ChatNoticeTone; content: string }

/** Status tone of a {@link ChatMessageSegment} notice. */
export type ChatNoticeTone = 'error' | 'warning'

/** Describe the structure and properties of a chat message with roles, content, and optional metadata */
export interface ChatUiMessage extends ChatMessageMetrics {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** The model's reasoning for this message, shown in a {@link ReasoningRow} above the answer. */
  reasoning?: string
  /** When the model started reasoning (epoch ms): `ChatReasoningState.startedAt` from the stream or the saved parts. */
  reasoningStartedAt?: number
  /** When the reasoning ended (epoch ms). Set, the row reads "Thought for N seconds"; unset while streaming, it is still thinking. */
  reasoningEndedAt?: number
  toolCalls?: ChatToolCallInfo[]
  /** Ordered text/tool sequence for true chronological interleaving. When
   *  present and non-empty it is rendered in place of `content` + `toolCalls`;
   *  both remain the fallback for producers that don't segment a turn. */
  segments?: ChatMessageSegment[]
  /** Persisted assistant parts. When `ChatMessages.durableCards` is supplied,
   * shared plan/question cards render directly from these projections. */
  parts?: Array<Record<string, unknown>>
  /** Who wrote the message, when more than one person shares the thread: a
   *  client, an attorney and the agent. A user message whose author is not
   *  `ChatMessages.viewerId` is someone else's: start-aligned on a card under
   *  their avatar, name and role. An assistant message's author replaces the
   *  agent label. Absent → today's rendering, byte-identical. */
  author?: ChatAuthor
}

/** Define properties for rendering chat messages with optional models, markdown, extras, and durable cards */
export interface ChatMessagesProps {
  messages: ChatUiMessage[]
  /** Shared reading scale for both user and assistant prose. Defaults to 16px
   *  at a 1.6 line height; `large` uses 17px at the same leading without
   *  enlarging labels, tool chrome, or metadata. */
  messageSize?: 'default' | 'large'
  /** Transcript chrome. `labeled` (default) keeps the always-on role label +
   *  model/tok-s/cost meta line and the primary-tinted user bubble. `quiet`
   *  drops the label row into a fixed-height meta lane at each row's bottom
   *  (copy + the demoted meta, revealed on hover/focus, always visible on
   *  touch) and renders user bubbles neutral with a symmetric radius.
   *  Everything else — tool rows, reasoning, streaming — is identical. */
  chrome?: 'labeled' | 'quiet'
  /** Catalogue models, for per-message cost from pricing. Pass [] to skip cost. */
  models?: CatalogModel[]
  /** Markdown renderer for assistant content; default renders pre-wrapped text. */
  renderMarkdown?: (content: string) => ReactNode
  /** Extra per-message content (artifacts, custom panels) appended after the body. */
  renderExtras?: (message: ChatUiMessage) => ReactNode
  /** Canonical durable plan/question card wiring. Apps inject only transport,
   * access, and optional visual callbacks; card selection/dedupe stays shared. */
  durableCards?: Omit<DurableChatCardsProps, 'parts' | 'renderMarkdown'>
  userLabel?: string
  agentLabel?: string
  /** Render the trailing "agent is thinking" row. */
  loading?: boolean
  /** The pending turn's latest stage from its `session.run.phase` events. The
   *  trailing row shows it in place of "Thinking…" until the first output. */
  turnPhase?: Pick<TurnPhaseData, 'message'> | null
  /** Approve/Reject handlers for proposals awaiting approval. When omitted the
   *  card still shows "awaiting approval" but without action buttons. */
  approval?: ProposalApprovalHandlers
  /** Open a full-transcript view (e.g. {@link RunDrillIn}) from a tool row's
   *  actions slot. */
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  /** Per-tool custom renderers for the row's optional presentation and expanded body. */
  toolRenderers?: ToolDetailRenderers
  /** Stream-error affordance: when the turn failed (a thrown transport error or
   *  a loop-level `onErrorEvent`), pass the message here to render an error row.
   *  A failed turn otherwise just stops with no UI signal. */
  error?: string | null
  /** Retry control shown on the error row; omit to render the error without a
   *  retry button (e.g. when the product retries automatically). */
  onRetry?: () => void
  /** Zero-state renderer, shown when there are no messages and the turn is
   *  neither loading nor errored. When omitted, a branded first-run state is
   *  shown ({@link ChatEmptyState}); pass `() => null` to render nothing. */
  renderEmpty?: () => ReactNode
  /** First-run state config used when `renderEmpty` is not supplied. Lets a
   *  product set the headline and the "doors" (e.g. start from a template, ask
   *  the agent) without replacing the whole zero-state. */
  emptyState?: ChatEmptyStateProps
  /** Optional branded header slot rendered above the thread. Off by default to
   *  preserve the current layout; pass `{ title }` (or your own node via
   *  `header`) to show the Tangle mark + product title in the chat shell. */
  header?: ReactNode
  /** Resolve a raw-bytes download URL for one attachment part. When set, any
   *  message carrying attachment parts (`file`/`image` parts with a `path`,
   *  see `attachmentPartsFromMessageParts`) renders them as a `MessageAttachments`
   *  row next to the bubble — thumbnails for images, download chips for files.
   *  Absent → today's rendering, byte-identical (no attachment row). */
  resolveAttachmentUrl?: (part: ChatAttachmentPart) => string
  /** Render persisted `type:'work_product'` anchor parts as `WorkProductCard`
   *  rows under the message body — the chat card that keeps chat the driver
   *  surface for review. `onOpen` opens the product's queue/detail surface.
   *  Absent → today's rendering, byte-identical (no card row). */
  workProductCards?: { onOpen?: (part: WorkProductPersistedPart) => void }
  /** The reader's participant id, compared with each user message's
   *  `author.id`. A user message without an author is always the reader's. */
  viewerId?: string
}

/** Handle approval and rejection actions for proposals with asynchronous support */
export interface ProposalApprovalHandlers {
  onApprove: (proposalId: string, toolCallId: string) => void | Promise<void>
  onReject: (proposalId: string, toolCallId: string) => void | Promise<void>
}

/** Optional product-owned presentation for an existing shared tool row.
 *  Missing title/description/detail fields retain the shared defaults. */
export interface ToolDetailPresentation {
  title?: string
  description?: string
  detail?: ReactNode
}

/** Per-tool custom renderers, keyed by tool name. A React node customizes only
 *  the expanded detail; a presentation can also customize the collapsed row.
 *  Return null to retain every shared default. */
export type ToolDetailRenderers = Record<
  string,
  (call: ChatToolCallInfo, message: ChatUiMessage) => ReactNode | ToolDetailPresentation
>
