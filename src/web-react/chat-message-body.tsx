/** Chronological text, tool, and notice segments within one turn. */
import { useMemo, type ReactNode } from 'react'
import { useSmoothText } from './smooth-text'
import { pendingApprovalOf, toolCallFailed, ToolCallCard } from './chat-tool-call'
import type { ChatToolCallInfo, ChatUiMessage, ChatMessageSegment, ChatNoticeTone, ProposalApprovalHandlers, ToolDetailRenderers } from './chat-message-types'

/** The blinking insertion caret shown at the end of streaming answer text.
 *  Shared by the segmented and legacy branches so their streaming cue can't
 *  visually diverge. */
export function StreamingCaret() {
  return (
    <span
      // `animate-pulse` is a 2s ease-in-out opacity fade — a breathing
      // placeholder, not a caret. A caret is a hard 1s step blink, which is
      // what every text surface the user has ever typed into does.
      className="ml-0.5 inline-block h-[1.1em] w-[3px] translate-y-[2px] animate-[agent-caret_1s_step-end_infinite] rounded-sm bg-foreground/70"
      data-motion="essential"
      aria-hidden
    />
  )
}

/** One text run inside a segmented turn. Smooths its own text so only the
 *  actively-streaming trailing run types out; finalized runs render at once.
 *  A child component (not an inline map) so its `useSmoothText` state is stable
 *  across the parent's per-frame stream re-renders. */
function SegmentText({
  content,
  streaming,
  showCaret,
  renderBody,
  messageClassName,
}: {
  content: string
  streaming: boolean
  showCaret: boolean
  renderBody: (content: string) => ReactNode
  messageClassName: string
}) {
  const text = useSmoothText(content, streaming)
  const body = useMemo(() => renderBody(text), [renderBody, text])
  // An empty / whitespace-only run paints a blank line-height gap — render
  // nothing, UNLESS it's the live trailing run (showCaret), where it still
  // carries the caret so the turn doesn't look frozen. (Hooks run first, so
  // this stays rules-of-hooks safe.)
  if (!content.trim() && !showCaret) return null
  return (
    // A settled run arrives from a short blur; the LIVE run does not, because
    // its text is already being revealed character by character and animating
    // the container on top of that makes the paragraph shimmer while it types.
    // The distinction is what separates "the answer materialised" from "the
    // log was appended to".
    <div className={`${messageClassName}${streaming ? '' : ' agent-stream-in'}`}>
      {body}
      {/* Gate on showCaret (not the smoothed `text`, which is '' on the first
          frame) so the caret is steady from the start instead of flickering. */}
      {showCaret && <StreamingCaret />}
    </div>
  )
}

/** A settled run of at least this many consecutive tool calls collapses into a
 *  single "Worked through N steps" disclosure so a long multi-step turn does not
 *  flood the transcript. Below it, tool rows render inline as before. */
const COLLAPSE_TOOL_RUN_AT = 3

/** A tool call the user must not miss even in a settled run — a failure (by
 *  status OR by an `ok:false` outcome, the shared `toolCallFailed` predicate),
 *  a card awaiting their approval, or a tool still `running` after the turn has
 *  settled (i.e. stuck / timed out). A run containing one is NEVER collapsed, so
 *  a failed, blocked, or stuck turn can't hide behind a "Worked through N steps"
 *  summary and read as successful. */
function isImportantTool(call: ChatToolCallInfo): boolean {
  return (
    call.status === 'running' ||
    toolCallFailed(call) ||
    pendingApprovalOf(call) !== null
  )
}

/** Renders a turn's ordered text/tool segments interleaved. The trailing text
 *  run carries the streaming caret; if the last segment is instead a tool, a
 *  trailing caret keeps the gap before the next run from looking frozen. Any
 *  `toolCalls` not represented in `segments` (a partially-migrated producer that
 *  set both) still render, so a tool row is never silently dropped. A settled
 *  run of many tool calls collapses into one disclosure — see below. */
export function SegmentedBody({
  segments,
  msg,
  streaming,
  renderBody,
  approval,
  onToolCallClick,
  toolRenderers,
  messageClassName,
}: {
  segments: ChatMessageSegment[]
  msg: ChatUiMessage
  streaming: boolean
  renderBody: (content: string) => ReactNode
  approval?: ProposalApprovalHandlers
  onToolCallClick?: (call: ChatToolCallInfo, message: ChatUiMessage) => void
  toolRenderers?: ToolDetailRenderers
  messageClassName: string
}) {
  const lastIndex = segments.length - 1
  const segmentToolIds = new Set(
    segments.flatMap((s) => (s.kind === 'tool' ? [s.call.id] : [])),
  )
  const leftoverToolCalls = (msg.toolCalls ?? []).filter(
    (tc) => !segmentToolIds.has(tc.id),
  )
  // `index` is the row's position WITHIN its group, so a run of six steps
  // cascades once instead of every group in the turn sharing one clock. The
  // index is stable to take from the map because segments only ever APPEND: a
  // row already on screen keeps the position it arrived at.
  const renderToolCard = (call: ChatToolCallInfo, index: number) => (
    <ToolCallCard
      key={`tool-${call.id}`}
      call={call}
      message={msg}
      approval={approval}
      onOpenRun={onToolCallClick}
      renderers={toolRenderers}
      staggerIndex={index}
    />
  )
  // Group consecutive tool segments so a SETTLED run of many tool calls (a
  // multi-step turn, e.g. workflow authoring) collapses into one disclosure
  // instead of flooding the transcript with a card per step. While the turn is
  // streaming nothing is grouped — live tool activity is exactly what the user
  // wants to watch; the run collapses once the turn settles. Text runs (the
  // actual answer) always render in full.
  const groups: Array<
    | { kind: 'text'; index: number; content: string }
    | { kind: 'tools'; index: number; calls: ChatToolCallInfo[] }
    | { kind: 'notice'; index: number; tone: ChatNoticeTone; content: string }
  > = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg) continue
    if (seg.kind === 'text') {
      groups.push({ kind: 'text', index: i, content: seg.content })
    } else if (seg.kind === 'notice') {
      groups.push({ kind: 'notice', index: i, tone: seg.tone, content: seg.content })
    } else {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'tools') last.calls.push(seg.call)
      else groups.push({ kind: 'tools', index: i, calls: [seg.call] })
    }
  }

  // ONE flat child list rather than a wrapper element per group, because React
  // identity is per PARENT: a call the producer reports in `toolCalls` before
  // the segment carrying it arrives starts life in `leftoverToolCalls` and later
  // lands in a `tool` segment, and a change of parent is an unmount plus a mount
  // — the row replays its entrance although the reader has been watching it for
  // seconds. Flat, every card is a sibling keyed on its call id, so that
  // migration is a re-order at worst and usually not even that (segments append,
  // and a leftover sits at the end, which is exactly where its segment lands).
  // The outer `gap-2` is what the removed per-group wrapper supplied, so the
  // layout is byte-for-byte what it was.
  const children: ReactNode[] = []
  for (const g of groups) {
    if (g.kind === 'notice') {
      children.push(<SegmentNotice key={`notice-${g.index}`} tone={g.tone} content={g.content} />)
      continue
    }
    if (g.kind === 'text') {
      children.push(
        <SegmentText
          // Segments only ever append within a turn, so the index is a stable
          // key — a finalized run keeps its slot as later runs/tools are added,
          // so its smooth-text state isn't reset.
          key={`text-${g.index}`}
          content={g.content}
          // Only the trailing run of the live turn types out + shows the caret.
          streaming={streaming && g.index === lastIndex}
          showCaret={streaming && g.index === lastIndex}
          renderBody={renderBody}
          messageClassName={messageClassName}
        />,
      )
      continue
    }
    if (
      !streaming &&
      g.calls.length >= COLLAPSE_TOOL_RUN_AT &&
      !g.calls.some(isImportantTool)
    ) {
      // The fold is a quiet disclosure line, not a filled box — the canonical
      // rows inside it carry the row chrome.
      //
      // Deliberately still a `<details>` and NOT `.agent-disclose`: a closed
      // `<details>` gives its children no box at all, so their `.agent-arrive`
      // has not run yet and the run genuinely cascades on the click that
      // reveals it. `.agent-disclose` keeps the subtree laid out and merely
      // clipped, which would spend the arrival behind a zero height and open
      // onto rows that were already there. The reasoning box is the opposite
      // case — it is open while the model thinks, so what has to animate there
      // is the HEIGHT.
      //
      // The key names the FOLD, not the group: folded and unfolded are two
      // different elements for one group, and one key over two element types is
      // how React is told to tear a subtree down and rebuild it — replaying the
      // entrance of every row in it.
      children.push(
        <details key={`tools-fold-${g.index}`}>
          {/* No horizontal padding: the fold line hangs on the same left edge
              as the rows it reveals, so opening it does not shift the column. */}
          <summary className="cursor-pointer select-none rounded-md py-0.5 text-xs font-medium text-muted-foreground [transition:color_var(--motion-control)] hover:text-foreground">
            Worked through {g.calls.length} steps
          </summary>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {g.calls.map(renderToolCard)}
          </div>
        </details>,
      )
      continue
    }
    g.calls.forEach((call, index) => children.push(renderToolCard(call, index)))
  }
  leftoverToolCalls.forEach((call, index) => children.push(renderToolCard(call, index)))
  if (streaming && segments[lastIndex]?.kind === 'tool') {
    children.push(<StreamingCaret key="streaming-caret" />)
  }

  return <div className="flex flex-col gap-2">{children}</div>
}

const NOTICE_TONE_CLASS: Record<ChatNoticeTone, string> = {
  error: 'border-destructive/40 bg-destructive/5 text-destructive',
  warning: 'border-warning/40 bg-warning/10 text-warning-strong',
}

/** An in-turn notice segment: the same status-toned box as the stream error
 *  row, inline in the transcript. Not `role="alert"` — a reloaded history must
 *  not re-announce every past failure; the live failure path keeps
 *  `StreamErrorRow` for that. */
function SegmentNotice({ tone, content }: { tone: ChatNoticeTone; content: string }) {
  return (
    <div
      data-notice-tone={tone}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONE_CLASS[tone]}`}
    >
      <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4m0 4h.01" />
      </svg>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{content}</span>
    </div>
  )
}
