/**
 * Renders a message's attachment parts (images + files) as thumbnails and
 * download chips — the transcript-side counterpart to `ChatComposer`'s
 * staged-upload chips. Ported from gtm-agent's `chat-attachment-parts.tsx`
 * onto agent-app's RAW-BYTES download contract: the host supplies
 * `resolveFileUrl(part)`, a URL that serves the attachment's raw bytes
 * directly, so this module never parses a JSON `{file:{blobUrl,body}}`
 * envelope or decodes a `[base64]` marker the way gtm's vault route did.
 *
 * No icon-library or primitives dependency (`ChatComposer`'s house style):
 * the loading skeleton is an inline `animate-pulse` span and the few glyphs
 * are inline SVGs.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ChatAttachmentPart } from './chat-attachments'
import { formatBytes } from '../chat-routes/wire'

// ── glyphs (no icon-library dependency) ───────────────────────────────────

function FileGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  )
}

function ImageGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  )
}

function WarningGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  )
}

function iconForMediaType(mediaType: string | undefined): (props: { className?: string }) => ReactNode {
  return mediaType?.startsWith('image/') ? ImageGlyph : FileGlyph
}

// ── file loading + cache ───────────────────────────────────────────────────

/** Typed outcome of fetching one attachment's raw bytes. Callers must check
 *  `ok` before touching `blob` — a failed fetch never produces a blank
 *  render, it produces a visible error state. */
export type AttachmentFileResult = { ok: true; blob: Blob } | { ok: false; message: string }

/** Module-level cache so mounting several rows that reference the same URL
 *  (e.g. a thumbnail re-rendered across reloads within one session) issues
 *  exactly one fetch. Keyed on the RESOLVED url — `resolveFileUrl`'s output —
 *  since that is what actually identifies the byte stream to the host. */
const attachmentFileCache = new Map<string, Promise<AttachmentFileResult>>()

export function __resetAttachmentFileCacheForTests(): void {
  attachmentFileCache.clear()
}

async function defaultFetchFile(url: string): Promise<Response> {
  return fetch(url, { credentials: 'same-origin' })
}

async function fetchAttachmentFile(
  url: string,
  fetchFile: (url: string) => Promise<Response>,
): Promise<AttachmentFileResult> {
  try {
    const res = await fetchFile(url)
    if (!res.ok) return { ok: false, message: `Failed to load attachment (${res.status})` }
    return { ok: true, blob: await res.blob() }
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : 'Network error loading attachment' }
  }
}

/** Fetches (and caches) the raw bytes behind one attachment url. Concurrent
 *  callers for the SAME url dedupe to one in-flight fetch. Only a successful
 *  settlement stays cached — evicting failures means a remount or click-retry
 *  after a transient error issues a fresh fetch. */
export function loadAttachmentFile(
  url: string,
  fetchFile: (url: string) => Promise<Response> = defaultFetchFile,
): Promise<AttachmentFileResult> {
  const cached = attachmentFileCache.get(url)
  if (cached) return cached
  const promise = fetchAttachmentFile(url, fetchFile)
  attachmentFileCache.set(url, promise)
  void promise.then((result) => {
    if (!result.ok && attachmentFileCache.get(url) === promise) attachmentFileCache.delete(url)
  })
  return promise
}

/** Drives an anchor-click download from an already-resolved blob. Returns a
 *  typed outcome rather than throwing — a chip that fails to synthesize the
 *  download must show the failure, not silently no-op. */
export function triggerAttachmentDownload(name: string, blob: Blob): { ok: true } | { ok: false; message: string } {
  try {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : 'Failed to download attachment' }
  }
}

/** Object URL for a resolved blob, created once per blob and revoked on
 *  unmount (or when the blob it was built from changes). */
function useAttachmentObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])
  return url
}

// ── thumbnail (images) ──────────────────────────────────────────────────────

function AttachmentThumbnailError({ name }: { name: string }) {
  return (
    <span className="inline-flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1 text-center text-destructive">
      <WarningGlyph className="h-4 w-4 shrink-0" />
      <span className="line-clamp-2 text-[10px] leading-tight">{name}</span>
    </span>
  )
}

interface AttachmentPartProps {
  part: ChatAttachmentPart
  resolveFileUrl: (part: ChatAttachmentPart) => string
  fetchFile?: (url: string) => Promise<Response>
}

function AttachmentThumbnail({ part, resolveFileUrl, fetchFile }: AttachmentPartProps) {
  const url = resolveFileUrl(part)
  const [result, setResult] = useState<AttachmentFileResult | null>(null)

  // Images fetch eagerly on mount — unlike the chip, which fetches only on
  // click — so the transcript shows a real thumbnail rather than a
  // placeholder icon.
  useEffect(() => {
    let cancelled = false
    setResult(null)
    loadAttachmentFile(url, fetchFile).then((next) => {
      if (!cancelled) setResult(next)
    })
    return () => {
      cancelled = true
    }
  }, [url, fetchFile])

  const objectUrl = useAttachmentObjectUrl(result?.ok ? result.blob : undefined)

  const handleClick = useCallback(() => {
    if (!objectUrl) return
    window.open(objectUrl, '_blank', 'noopener')
  }, [objectUrl])

  if (!result) {
    return <span className="inline-block h-16 w-16 shrink-0 animate-pulse rounded-md bg-muted" aria-hidden />
  }
  if (!result.ok || !objectUrl) {
    return <AttachmentThumbnailError name={part.name} />
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Open ${part.name}`}
      className="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <img src={objectUrl} alt={part.name} className="h-16 w-16 object-cover" />
    </button>
  )
}

// ── chip (files) ─────────────────────────────────────────────────────────

function AttachmentChip({ part, resolveFileUrl, fetchFile }: AttachmentPartProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Files fetch ONLY on click — an unopened chip never issues a network
  // request, unlike an eagerly-fetched thumbnail.
  const handleClick = useCallback(() => {
    if (status === 'loading') return
    setStatus('loading')
    setErrorMessage(null)
    const url = resolveFileUrl(part)
    void loadAttachmentFile(url, fetchFile).then((result) => {
      if (!result.ok) {
        setStatus('error')
        setErrorMessage(result.message)
        return
      }
      const download = triggerAttachmentDownload(part.name, result.blob)
      if (!download.ok) {
        setStatus('error')
        setErrorMessage(download.message)
        return
      }
      setStatus('idle')
    })
  }, [status, resolveFileUrl, part, fetchFile])

  const Icon = status === 'error' ? WarningGlyph : iconForMediaType(part.mediaType)
  const className = [
    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]',
    status === 'error'
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : 'border-border bg-muted/60 text-muted-foreground',
  ].join(' ')

  return (
    <button
      type="button"
      onClick={handleClick}
      title={status === 'error' ? errorMessage ?? undefined : undefined}
      className={className}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {part.name}
      {typeof part.size === 'number' && <span className="text-muted-foreground/70">· {formatBytes(part.size)}</span>}
    </button>
  )
}

// ── row ──────────────────────────────────────────────────────────────────

export interface MessageAttachmentsProps {
  parts: ChatAttachmentPart[]
  /** URL serving the attachment's RAW bytes. */
  resolveFileUrl: (part: ChatAttachmentPart) => string
  /** Row alignment — a user-bubble attachment row is right-aligned by
   *  default; pass `"start"` for an assistant-turn attachment, which sits
   *  inline with the rest of the transcript. */
  justify?: 'start' | 'end'
  /** Override the fetch used to load an attachment's bytes. Default:
   *  `fetch(url, { credentials: 'same-origin' })`. */
  fetchFile?: (url: string) => Promise<Response>
}

/** Renders a message's attachment parts as a row of image thumbnails and file
 *  chips. `null` when there are none, so callers can render unconditionally
 *  without an extra length check. */
export function MessageAttachments({ parts, resolveFileUrl, justify = 'end', fetchFile }: MessageAttachmentsProps): ReactNode {
  if (parts.length === 0) return null
  return (
    <div className={`flex flex-wrap gap-1.5 ${justify === 'start' ? 'justify-start' : 'justify-end'}`}>
      {parts.map((part) =>
        part.type === 'image' ? (
          <AttachmentThumbnail key={`${part.path}:${part.name}`} part={part} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />
        ) : (
          <AttachmentChip key={`${part.path}:${part.name}`} part={part} resolveFileUrl={resolveFileUrl} fetchFile={fetchFile} />
        ),
      )}
    </div>
  )
}
