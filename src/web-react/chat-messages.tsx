/** Message-thread composition and per-message presentation. */
import { useEffect, useMemo, useRef, useState, memo, type ReactNode } from 'react'
import { isViewerMessage, MessageAuthor, partitionBySpeaker, SpeakerHeader, TRANSCRIPT_TEXT, type SpeakerPart } from '@tangle-network/ui/chat'
import type { ChatAuthor } from '@tangle-network/ui/types'
import { useSmoothText } from './smooth-text'
import { POPOVER_OPTION_FOCUS } from './controls'
import { DurableChatCards, type DurableChatCardsProps } from './durable-chat-cards'
import { attachmentPartsFromMessageParts, type ChatAttachmentPart } from './chat-attachments'
import { MessageAttachments } from './message-attachments'
import { WorkProductCard, workProductPartsFromMessageParts } from './work-product'
import type { WorkProductPersistedPart } from '../work-product/types'
import type { TurnPhaseData } from '../chat-routes/turn-progress'
import { TurnProgress } from './turn-progress'
import { ReasoningRow } from './reasoning-row'
import { useChatScroll } from './chat-scroll'

import type { CatalogModel } from '../runtime/model-catalog'
import type { ChatToolCallInfo, ChatUiMessage, ProposalApprovalHandlers, ToolDetailRenderers } from './chat-message-types'
import type { ChatMessagesProps } from './chat-message-types'
import { ChatEmptyState } from './chat-empty-state'
import { chatReasoningFromParts } from './chat-stream'
import { segmentsFromParts, toolCallsFromParts } from './message-projection'
import { formatModelCost, formatTokensPerSecond } from './chat-message-metrics'
import { StreamingCaret, SegmentedBody } from './chat-message-body'
import { ToolCallCard } from './chat-tool-call'

/** One answer of a turn answered by several agents: its responder and the stored row it was split from. */
type SpokenMessage = ChatUiMessage & { speaker?: SpeakerPart; splitFrom?: string }

/** A turn addressed to several agents is one stored row with a speaker part
 *  before each answer; the transcript draws each answer as its own row under
 *  its responder, in stored order. A split row holds only its responder's
 *  parts, so its reasoning and tool timeline are rebuilt from them; the whole
 *  row's views never apply to one share. Other rows pass through untouched. */
function splitBySpeaker(rows: readonly ChatUiMessage[]): SpokenMessage[] {
  return rows.flatMap((row): SpokenMessage[] => {
    const sections = row.role === 'assistant' && row.parts ? partitionBySpeaker(row.parts) : []
    if (!sections.some((section) => section.speaker)) return [row]
    return sections.map(({ speaker, parts }, index) => {
      const reasoning = chatReasoningFromParts(parts)
      const segments = segmentsFromParts(parts)
      return {
        ...row,
        id: `${row.id}#${index}:${speaker?.id ?? ''}`,
        splitFrom: row.id,
        ...(speaker ? { speaker } : {}),
        content: parts.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join(''),
        parts,
        segments: segments.length > 0 ? segments : undefined,
        toolCalls: segments.length > 0 ? undefined : toolCallsFromParts(parts),
        reasoning: reasoning?.text,
        reasoningStartedAt: reasoning?.startedAt,
        reasoningEndedAt: reasoning?.endedAt,
      }
    })
  })
}

// ── Quiet chrome ────────────────────────────────────────────────────────────

/** The quiet chrome's per-row meta lane: a fixed ~18px strip that always
 *  reserves its height (so the reveal is pure opacity — zero layout shift) and
 *  fades in on row hover/focus-within, staying visible on touch via
 *  `@media (hover: none)`. The fade is reduced-motion-guarded. Tabular figures
 *  keep the tok/s and cost columns from jittering as they change; no letter
 *  tracking — a meta lane is data, not an eyebrow. */
const QUIET_META_LANE_CLASS =
  'mt-1 flex h-[18px] items-center gap-2 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100'

/** The text a copy of the message should carry: the ordered text runs when the
 *  turn is segmented (they render in place of `content`), else `content`. */
function copyTextOf(msg: ChatUiMessage): string {
  const textRuns = msg.segments?.filter((s) => s.kind === 'text') ?? []
  if (textRuns.length > 0) return textRuns.map((s) => s.content).join('\n\n')
  return msg.content
}

/** Copies the message's plain text; swaps to a check for a beat on success.
 *  Quiet chrome only — labeled mode's meta line is information, not action. */
function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )
  const copy = () => {
    const clipboard = navigator.clipboard
    if (!clipboard) return
    void clipboard.writeText(text).then(
      () => {
        setCopied(true)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy message"
      title="Copy message"
      className="rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}

function AssistantMessageImpl({
  msg,
  streaming,
  models,
  agentLabel,
  renderBody,
  approval,
  onToolCallClick,
  toolRenderers,
  renderExtras,
  durableCards,
  resolveAttachmentUrl,
  workProductCards,
  messageClassName,
  chrome,
}: {
  msg: SpokenMessage
  streaming: boolean
  models: CatalogModel[]
  agentLabel: string
  renderBody: (content: string) => ReactNode
  approval?: ProposalApprovalHandlers
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  toolRenderers?: ToolDetailRenderers
  renderExtras?: (message: ChatUiMessage) => ReactNode
  durableCards?: Omit<DurableChatCardsProps, 'parts' | 'renderMarkdown'>
  resolveAttachmentUrl?: (part: ChatAttachmentPart) => string
  workProductCards?: { onOpen?: (part: WorkProductPersistedPart) => void }
  messageClassName: string
  chrome: 'labeled' | 'quiet'
}) {
  // Smooth reveal: chunky network slabs (model bursts, flush windows, replay
  // polls) paint as a continuous typewriter. The reasoning row smooths its own
  // text the same way while the model thinks.
  const content = useSmoothText(msg.content, streaming)
  // The smooth reveal re-renders on every rAF frame while streaming, but the
  // FLOORED visible length only advances every few frames — re-parsing markdown
  // each frame is wasted work on the hot path. Memo on (renderBody, content) so
  // the parse runs only when the visible text actually changes.
  const body = useMemo(() => renderBody(content), [renderBody, content])
  // When a turn is segmented, render the ordered text/tool runs interleaved;
  // otherwise fall back to the single content body + trailing tool group.
  const segments = msg.segments
  // "Has the answer started?" — true once any answer text exists, whether the
  // producer puts it in `content` (legacy) or in a text `segment`. Ends the
  // reasoning row's thinking state for a producer that sends no end time, so a
  // segmented message with `content: ''` doesn't read as perpetually
  // "Thinking…" after its answer segments are visible.
  const hasAnswerText =
    content !== '' ||
    (segments?.some((s) => (s.kind === 'text' || s.kind === 'notice') && s.content.trim() !== '') ??
      false)

  const answerScroll = useChatScroll()
  const quiet = chrome === 'quiet'
  const authorClassName = quiet ? 'mb-1.5' : undefined
  const author = msg.speaker ? (
    <SpeakerHeader speaker={msg.speaker} live={streaming} className={authorClassName} />
  ) : msg.author ? (
    <MessageAuthor author={msg.author} className={authorClassName} />
  ) : null
  return (
    <div className={`mx-auto w-full max-w-3xl px-6 ${quiet ? 'group pb-1 pt-3' : 'py-3'}`}>
      {quiet && author}
      {!quiet && (
        <div
          className={`mb-1 flex ${author ? 'items-center' : 'items-baseline'} gap-2 text-xs tabular-nums text-muted-foreground`}
        >
          {author ?? <span className="font-semibold uppercase tracking-[0.05em]">{agentLabel}</span>}
          {msg.modelUsed && <span className="font-mono normal-case">{msg.modelUsed}</span>}
          {formatTokensPerSecond(msg) && <span>{formatTokensPerSecond(msg)}</span>}
          {formatModelCost(msg, models) && <span>{formatModelCost(msg, models)}</span>}
        </div>
      )}
      <div ref={msg.speaker ? answerScroll.viewportRef : undefined} className={msg.speaker ? 'agent-speaker-answer' : undefined} tabIndex={msg.speaker ? 0 : undefined} role={msg.speaker ? 'region' : undefined} aria-label={msg.speaker ? `Answer from ${msg.speaker.name}` : undefined}>
      <div ref={msg.speaker ? answerScroll.contentRef : undefined}>
      <ReasoningRow
        className="mb-2"
        text={msg.reasoning ?? ''}
        startedAt={msg.reasoningStartedAt}
        endedAt={msg.reasoningEndedAt}
        thinking={streaming && !hasAnswerText && msg.reasoningEndedAt === undefined}
      />
      {segments && segments.length > 0 ? (
        <SegmentedBody
          segments={segments}
          msg={msg}
          streaming={streaming}
          showCaret={!msg.speaker}
          renderBody={renderBody}
          approval={approval}
          onToolCallClick={onToolCallClick}
          toolRenderers={toolRenderers}
          messageClassName={messageClassName}
        />
      ) : (
        <>
          <div className={messageClassName}>
            {body}
            {!msg.speaker && streaming && content && !msg.toolCalls?.length && <StreamingCaret />}
          </div>
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {msg.toolCalls.map((tc, index) => (
                <ToolCallCard
                  key={tc.id}
                  call={tc}
                  message={msg}
                  approval={approval}
                  onOpenRun={onToolCallClick}
                  renderers={toolRenderers}
                  staggerIndex={index}
                />
              ))}
            </div>
          )}
        </>
      )}
      {durableCards && msg.parts && (
        <DurableChatCards
          {...durableCards}
          parts={msg.parts}
          renderMarkdown={renderBody}
          className="mt-3"
        />
      )}
      {workProductCards &&
        workProductPartsFromMessageParts(msg.parts).map((part) => (
          <WorkProductCard
            key={`${part.ref.id}:${part.ref.version}`}
            part={part}
            onOpen={workProductCards.onOpen}
            className="mt-3"
          />
        ))}
      {renderExtras?.(msg)}
      {resolveAttachmentUrl && attachmentPartsFromMessageParts(msg.parts).length > 0 && (
        <div className="mt-2">
          <MessageAttachments
            parts={attachmentPartsFromMessageParts(msg.parts)}
            resolveFileUrl={resolveAttachmentUrl}
            justify="start"
          />
        </div>
      )}
      </div></div>
      {quiet && (
        <div data-testid="message-meta-lane" className={QUIET_META_LANE_CLASS}>
          <CopyMessageButton text={copyTextOf(msg)} />
          {msg.modelUsed && <span className="font-mono">{msg.modelUsed}</span>}
          {formatTokensPerSecond(msg) && <span>{formatTokensPerSecond(msg)}</span>}
          {formatModelCost(msg, models) && <span>{formatModelCost(msg, models)}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Only the actively-streaming message changes per frame; historical messages
 * are referentially stable. `memo` keeps a stable `AssistantMessage` from
 * re-rendering (and re-running its markdown parse) when a sibling streams —
 * default shallow-equal prop comparison is exactly right here since every prop
 * is referentially stable except the one being streamed.
 */
const AssistantMessage = memo(AssistantMessageImpl)

/** Whole seconds elapsed while `active`, ticking once a second; counts from
 *  when `active` first turns true and freezes when it clears. Kept for
 *  existing consumers: `ReasoningRow` times reasoning from the stream's own
 *  start instead. */
export function useThinkingSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!active) return
    // Reset on each (re)activation so a reused component resuming "thinking"
    // counts from 0 rather than showing the prior phase's stale elapsed time.
    setSeconds(0)
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [active])
  return seconds
}

function ThinkingRow({ agentLabel, chrome = 'labeled', phase }: {
  agentLabel: string
  chrome?: 'labeled' | 'quiet'
  phase?: Pick<TurnPhaseData, 'message'> | null
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      {chrome !== 'quiet' && (
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">{agentLabel}</p>
      )}
      <TurnProgress phase={phase} pendingMessage="Thinking…" className="text-[15px]" />
    </div>
  )
}

/** Top-level turn-failure row with an optional Retry — the affordance a failed
 *  stream otherwise lacks (the turn just stopped). */
function StreamErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-3">
      <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
        <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4m0 4h.01" />
        </svg>
        <span className="min-w-0 flex-1 break-words">{message}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={`shrink-0 rounded border border-destructive/40 bg-card px-2 py-0.5 text-xs font-medium text-destructive transition hover:bg-destructive/10 ${POPOVER_OPTION_FOCUS}`}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Someone other than the reader, in a thread several people share: start-
 * aligned under their avatar, name and role, on a card rather than the
 * reader's inverse fill, so "mine" and "theirs" differ before the names are
 * read. Mirrors the reader's bubble otherwise: the same width cap, the same
 * attachment row and, in quiet chrome, the same copy lane.
 */
function OtherPersonMessage({
  msg,
  author,
  quiet,
  messageClassName,
  resolveAttachmentUrl,
}: {
  msg: ChatUiMessage
  author: ChatAuthor
  quiet: boolean
  messageClassName: string
  resolveAttachmentUrl?: (part: ChatAttachmentPart) => string
}) {
  const attachments = resolveAttachmentUrl ? attachmentPartsFromMessageParts(msg.parts) : []
  return (
    <div className={`mx-auto w-full max-w-3xl px-6 ${quiet ? 'group pb-1 pt-3' : 'py-3'}`}>
      <div className={`w-fit ${quiet ? 'max-w-[72%]' : 'max-w-[85%]'}`}>
        <MessageAuthor author={author} className="mb-1.5" />
        <div
          className={`w-fit max-w-full rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-2.5 text-[hsl(var(--foreground))] ${quiet ? '' : 'rounded-tl-md '}${messageClassName}`}
        >
          <p className="whitespace-pre-wrap">{msg.content}</p>
        </div>
        {resolveAttachmentUrl && attachments.length > 0 && (
          <div className="mt-1.5">
            <MessageAttachments parts={attachments} resolveFileUrl={resolveAttachmentUrl} justify="start" />
          </div>
        )}
      </div>
      {quiet && (
        <div data-testid="message-meta-lane" className={`${QUIET_META_LANE_CLASS} justify-start`}>
          <CopyMessageButton text={msg.content} />
        </div>
      )}
    </div>
  )
}

/**
 * The message thread: one centered column; user messages are right-aligned
 * bubbles with a User label; agent messages carry an Agent meta line with
 * model id, tokens/sec, and cost, plus a collapsible thinking section and
 * tool rows. `chrome="quiet"` opts into the label-free variant: the
 * label/meta row becomes a hover-revealed meta lane under each row.
 * A thread shared by several people passes each message's `author` and the
 * reader's `viewerId`: the reader's own messages stay right-aligned, everyone
 * else's are named, and a named agent replaces the agent label.
 */
export function ChatMessages({
  messages: storedMessages,
  messageSize = 'default',
  chrome = 'labeled',
  models = [],
  renderMarkdown,
  renderExtras,
  durableCards,
  userLabel = 'User',
  agentLabel = 'Agent',
  loading,
  turnPhase,
  approval,
  onToolCallClick,
  toolRenderers,
  error,
  onRetry,
  renderEmpty,
  emptyState,
  header,
  resolveAttachmentUrl,
  workProductCards,
  viewerId,
}: ChatMessagesProps) {
  // Brand's one transcript scale for both roles: they differ only by alignment
  // and surface. `large` raises the shared size token, never one role's size.
  const messageClassName =
    messageSize === 'large'
      ? `agent-app-message-copy ${TRANSCRIPT_TEXT} [--transcript-font-size:1.0625rem]`
      : `agent-app-message-copy ${TRANSCRIPT_TEXT}`
  // Resolve role colors at the message, so nested host themes can override
  // the raw tokens without also redefining Tailwind's root color aliases.
  const assistantMessageClassName = `${messageClassName} bg-transparent text-[hsl(var(--foreground))]`
  // Stabilize the fallback renderer's identity so it doesn't change every
  // render — otherwise the memoized `AssistantMessage` (and its per-frame body
  // memo) would invalidate on every parent render when no `renderMarkdown` is
  // supplied.
  const renderBody = useMemo(
    () => renderMarkdown ?? ((content: string) => <p className="whitespace-pre-wrap">{content}</p>),
    [renderMarkdown],
  )
  const messages = useMemo(() => splitBySpeaker(storedMessages), [storedMessages])
  // The row the turn in flight writes. Its responders answer at the same time,
  // so every share of it streams until that responder reports its end.
  const liveId = loading ? storedMessages[storedMessages.length - 1]?.id : undefined
  const lastIsUser = messages[messages.length - 1]?.role === 'user'
  const quiet = chrome === 'quiet'
  if (messages.length === 0 && !loading && !error) {
    // Explicit renderEmpty wins (incl. `() => null` to opt out); otherwise show
    // the branded first-run state instead of a blank thread.
    const empty = renderEmpty ? renderEmpty() : <ChatEmptyState {...emptyState} />
    return (
      <>
        {header}
        {empty}
      </>
    )
  }
  return (
    <>
      {header}
      {messages.map((msg) =>
        msg.role === 'user' && msg.author && !isViewerMessage(msg.author, viewerId) ? (
          <OtherPersonMessage
            key={msg.id}
            msg={msg}
            author={msg.author}
            quiet={quiet}
            messageClassName={messageClassName}
            resolveAttachmentUrl={resolveAttachmentUrl}
          />
        ) : msg.role === 'user' ? (
          <div key={msg.id} className={`mx-auto w-full max-w-3xl px-6 ${quiet ? 'group pb-1 pt-3' : 'py-3'}`}>
            <div className={`ml-auto w-fit ${quiet ? 'max-w-[72%]' : 'max-w-[85%]'}`}>
              {!quiet && (
                <p className="mb-1 text-right text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {userLabel}
                </p>
              )}
              <div
                className={`rounded-2xl bg-[hsl(var(--foreground))] px-4 py-2.5 text-[hsl(var(--background))] ${quiet ? '' : 'rounded-tr-md '}${messageClassName}`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
              {resolveAttachmentUrl && attachmentPartsFromMessageParts(msg.parts).length > 0 && (
                <div className="mt-1.5">
                  <MessageAttachments
                    parts={attachmentPartsFromMessageParts(msg.parts)}
                    resolveFileUrl={resolveAttachmentUrl}
                    justify="end"
                  />
                </div>
              )}
            </div>
            {quiet && (
              <div data-testid="message-meta-lane" className={`${QUIET_META_LANE_CLASS} justify-end`}>
                <CopyMessageButton text={msg.content} />
              </div>
            )}
          </div>
        ) : (
          <AssistantMessage
            key={msg.id}
            msg={msg}
            streaming={liveId !== undefined && (msg.splitFrom ?? msg.id) === liveId && !msg.speaker?.state}
            models={models}
            agentLabel={agentLabel}
            renderBody={renderBody}
            approval={approval}
            onToolCallClick={onToolCallClick}
            toolRenderers={toolRenderers}
            renderExtras={renderExtras}
            durableCards={durableCards}
            resolveAttachmentUrl={resolveAttachmentUrl}
            workProductCards={workProductCards}
            messageClassName={assistantMessageClassName}
            chrome={chrome}
          />
        ),
      )}
      {loading && lastIsUser && <ThinkingRow agentLabel={agentLabel} chrome={chrome} phase={turnPhase} />}
      {error && !loading && <StreamErrorRow message={error} onRetry={onRetry} />}
    </>
  )
}
