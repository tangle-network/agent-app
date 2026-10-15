/**
 * The reasoning row every agent app shows above an answer. While the model
 * reasons, its reasoning streams in live under "Thinking · 12s"; when the
 * answer starts the row collapses to "Thought for 12 seconds", and a click
 * opens it again. It renders nothing when the turn has no reasoning.
 *
 * The props are a `ChatReasoningState` (`./chat-stream`): spread the state the
 * stream keeps (`onReasoningState`), or a saved message's
 * (`chatReasoningFromParts`), onto the row. `ChatMessages` renders it for
 * every assistant message that carries `reasoning`.
 *
 * It is built on the shared run-row shell (`RunRowShell` from
 * `@tangle-network/ui/run`), so it reads as one family with the tool rows, and
 * styles only with the shared design tokens.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RunRowShell } from '@tangle-network/ui/run'
import { Markdown } from '@tangle-network/ui/markdown'
import { BrainGlyph } from './controls'
import { useSmoothText } from './smooth-text'
import { useChatScroll } from './chat-scroll'

/** Props for {@link ReasoningRow}: the fields of a `ChatReasoningState`, plus presentation. */
export interface ReasoningRowProps {
  /** The reasoning so far. While it is blank the row renders nothing. */
  text: string
  /** When the model started reasoning (epoch ms). The live timer counts from here; without it, from when the row first saw the model thinking. */
  startedAt?: number
  /** When the reasoning ended (epoch ms). With `startedAt`, the settled row reads "Thought for N seconds". */
  endedAt?: number
  /** The model is still reasoning. Defaults to true while `startedAt` is set and `endedAt` is not. */
  thinking?: boolean
  /** Open a settled row. Default false: once thinking ends the row is collapsed until the reader opens it. */
  defaultOpen?: boolean
  /** Render the reasoning text. Default: the shared markdown renderer. */
  renderText?: (text: string) => ReactNode
  className?: string
}

/** One-line preview of the reasoning for the collapsed row: whitespace collapsed, truncated with an ellipsis. */
function reasoningPreview(text: string): string | undefined {
  const flat = text.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

/** "Thought for 4 seconds": words, not a unit, so the settled row reads as a sentence. */
function thoughtForLabel(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  return `Thought for ${seconds} second${seconds === 1 ? '' : 's'}`
}

/** Re-render once a second while `active`, so a live timer advances between deltas. */
function useSecondTick(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

const defaultRenderText = (text: string) => <Markdown className="text-base leading-relaxed">{text}</Markdown>

/** The model's reasoning for one message: live while it thinks, collapsed once it answers. */
export function ReasoningRow({
  text,
  startedAt,
  endedAt,
  thinking: thinkingProp,
  defaultOpen = false,
  renderText = defaultRenderText,
  className,
}: ReasoningRowProps) {
  const thinking = thinkingProp ?? (startedAt !== undefined && endedAt === undefined)
  // Bursty deltas (a whole summary part at once) type out instead of popping in.
  const shown = useSmoothText(text, thinking)
  const body = useMemo(() => renderText(shown), [renderText, shown])

  // Without the stream's timestamps, time the run from what this row saw:
  // the first reasoning it showed while thinking to the first render after.
  const visible = text.trim() !== ''
  const seenStart = useRef<number | null>(null)
  const seenEnd = useRef<number | null>(null)
  if (thinking && visible) {
    if (seenStart.current === null) seenStart.current = Date.now()
    seenEnd.current = null
  } else if (seenStart.current !== null && seenEnd.current === null) {
    seenEnd.current = Date.now()
  }
  const start = startedAt ?? seenStart.current ?? undefined
  const end = endedAt ?? seenEnd.current ?? undefined
  useSecondTick(thinking)

  // Open while thinking, closed once the answer starts; a reader's click
  // outranks that default from then on, across every later delta.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const { viewportRef, contentRef, following, jumpToLatest } = useChatScroll()
  const open = toggled ?? (thinking || defaultOpen || !following)

  if (!visible) return null

  const elapsedSeconds = thinking && start !== undefined ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0
  const durationMs = !thinking && start !== undefined && end !== undefined && end >= start ? end - start : undefined
  const title = thinking ? (
    // The sweep through the glyphs is the working-versus-stuck signal; reduced
    // motion swaps it for a static underline (`.agent-shimmer` in the theme).
    <span className="agent-shimmer" data-motion="essential">
      Thinking{elapsedSeconds >= 1 ? ` · ${elapsedSeconds}s` : '…'}
    </span>
  ) : durationMs !== undefined ? thoughtForLabel(durationMs) : 'Thought process'

  return (
    <RunRowShell
      className={className}
      icon={<BrainGlyph className="h-3.5 w-3.5" />}
      title={title}
      // A collapsed row previews its first line, so it says what was considered.
      description={thinking ? undefined : reasoningPreview(text)}
      status={thinking ? 'running' : 'idle'}
      open={open}
      onOpenChange={setToggled}
    >
      <div
        ref={viewportRef}
        tabIndex={0}
        role="region"
        aria-label="Reasoning"
        data-reasoning={thinking ? 'thinking' : 'settled'}
        aria-busy={thinking || undefined}
        className="max-h-[min(28rem,60dvh)] overflow-y-auto overscroll-contain px-4 py-4 text-base leading-relaxed text-foreground"
      >
        <div ref={contentRef} className="min-w-0 break-words">{body}</div>
      </div>
      {!following && (
        <div className="flex justify-end px-4 pb-3">
          <button type="button" aria-label="Jump to latest reasoning" onClick={jumpToLatest}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
            Jump to latest
          </button>
        </div>
      )}
    </RunRowShell>
  )
}
