/**
 * Inline sources + follow-up chips (issue #420) — the two slots that let a
 * streamed answer carry its provenance and its next step IN the transcript
 * instead of in a separate table or a retyped prompt.
 *
 *  - {@link MessageSources}: one chip per source the answer is grounded in —
 *    favicon (or a generic link glyph), title, and domain, linking out. The
 *    data rides on the assistant message (`ChatUiMessage.sources`); lineage
 *    products already hold it, this is the inline rendering of it.
 *  - {@link MessageFollowUps}: rounded-full suggestion chips under a settled
 *    answer; selecting one calls the host's `onFollowUpSelect` (seed the
 *    composer, send it — the host decides). Chips render only when the host
 *    wired the callback: a suggestion with nowhere to go is a dead control.
 *
 * Both render only for a SETTLED message — chips that arrive mid-stream would
 * re-layout the answer under the reader's eye.
 */

import { useState } from 'react'
import { staggerStyle } from './motion'

/** One source an assistant answer is grounded in. */
export interface ChatMessageSource {
  /** Page/document title shown on the chip. */
  title: string
  /** Where the chip links. */
  url: string
  /** Favicon URL. Absent (or unloadable) → a generic link glyph. */
  faviconUrl?: string
  /** Display domain. Derived from `url` when absent. */
  domain?: string
}

/** One suggested next prompt under an answer. */
export interface ChatMessageFollowUp {
  /** The chip text — a full suggested prompt, not a category. */
  label: string
  /** Stable id; the label is handed back when no id is set. */
  id?: string
}

/** The display domain for a source: the url's hostname minus a `www.` prefix,
 *  null when the url does not parse (the chip then shows title only). */
export function sourceDomain(source: ChatMessageSource): string | null {
  if (source.domain) return source.domain
  try {
    return new URL(source.url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Inline link glyph — the no-favicon fallback. No icon-library dependency,
 *  same pattern as the rest of `/web-react`. */
function LinkGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

/** The follow-up chip's affordance mark: a small arrow bending into the
 *  composer — this text continues the conversation. */
function FollowUpGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  )
}

function SourceChip({ source, index }: { source: ChatMessageSource; index: number }) {
  const [faviconFailed, setFaviconFailed] = useState(false)
  const domain = sourceDomain(source)
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      title={source.title}
      style={staggerStyle(index)}
      className="agent-arrive inline-flex max-w-64 min-w-0 items-center gap-1.5 rounded-lg border border-border bg-card py-1 pl-1.5 pr-2 text-xs text-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {source.faviconUrl && !faviconFailed ? (
        <img
          src={source.faviconUrl}
          alt=""
          className="h-4 w-4 shrink-0 rounded-[3px]"
          onError={() => setFaviconFailed(true)}
        />
      ) : (
        <LinkGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate font-medium">{source.title}</span>
      {domain && <span className="shrink-0 text-muted-foreground">{domain}</span>}
    </a>
  )
}

/** The inline source chips under an answer. */
export function MessageSources({
  sources,
  className,
}: {
  sources: ChatMessageSource[]
  className?: string
}) {
  if (sources.length === 0) return null
  return (
    <div
      role="group"
      aria-label="Sources"
      data-testid="message-sources"
      className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}
    >
      {sources.map((source, i) => (
        <SourceChip key={`${source.url}-${i}`} source={source} index={i} />
      ))}
    </div>
  )
}

/** The follow-up suggestion chips under an answer. */
export function MessageFollowUps({
  followUps,
  onSelect,
  className,
}: {
  followUps: ChatMessageFollowUp[]
  onSelect: (followUp: ChatMessageFollowUp) => void
  className?: string
}) {
  if (followUps.length === 0) return null
  return (
    <div
      role="group"
      aria-label="Follow-up questions"
      data-testid="message-follow-ups"
      className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}
    >
      {followUps.map((followUp, i) => (
        <button
          key={followUp.id ?? followUp.label}
          type="button"
          onClick={() => onSelect(followUp)}
          style={staggerStyle(i)}
          className="agent-arrive inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground transition hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FollowUpGlyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {followUp.label}
        </button>
      ))}
    </div>
  )
}
