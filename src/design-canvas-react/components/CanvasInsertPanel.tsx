/**
 * The human "add element to the canvas" side panel — a reusable left rail any
 * canvas consumer can mount so a person (not just the agent) can put images,
 * shapes, and text on the canvas. Designed for the `renderSidePanel` slot of
 * {@link DesignCanvasProps}; pass `renderSidePanel={(ctx) => <CanvasInsertPanel … />}`.
 *
 * Endpoints are per-app, so every I/O path is a callback — no product route is
 * hardcoded:
 *  - `onUploadImage(file) => Promise<url>` — the host stores the file and returns
 *    the src to insert. The url MUST be http(s) or a rooted `/api/` path
 *    (enforced by `assertSceneMediaSrc` before insertion); a `data:` url is
 *    rejected, matching the scene model's media boundary.
 *  - `loadGenerations?()` — optional provider for "already generated in this
 *    workspace" images; omit to hide the tab.
 *  - `templates?` — optional template set; defaults to {@link DEFAULT_INSERT_TEMPLATES}.
 *
 * Insertion goes through `onInsert`, which the host wires to its
 * `onApplyOperations` pipeline (server-validated, undoable) — the same path
 * every other edit takes.
 *
 * Tokens/icons follow the canvas convention: CSS-var design tokens and inline
 * SVG glyphs, no icon-library or Tailwind-semantic-token dependency.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { SceneOperation } from '../../design-canvas/operations'
import { assertSceneMediaSrc } from '../../design-canvas/model'
import {
  DEFAULT_INSERT_TEMPLATES,
  buildInsertImageOp,
  type InsertPageGeometry,
  type InsertTemplate,
} from '../insert-builders'
import { ImageGlyph, ShapesGlyph } from './glyphs'

/** An already-generated image the panel can offer for one-click insertion. */
export interface InsertGeneration {
  id: string
  /** The image url to insert. Must satisfy the scene media boundary
   *  (http(s) or rooted `/api/`); rejected otherwise at insert time. */
  url: string
  /** Optional prompt/label shown as the tile's title. */
  label?: string
}

export interface CanvasInsertPanelProps {
  canWrite: boolean
  /** The active page new elements are added to. */
  page: InsertPageGeometry
  /** Submit operations through the host's apply pipeline. */
  onInsert(operations: SceneOperation[]): Promise<unknown>
  /** Store an uploaded file and return its src (http(s) or rooted `/api/`). */
  onUploadImage(file: File): Promise<string>
  /** Optional provider for the Generations tab; omit to hide it. */
  loadGenerations?(): Promise<InsertGeneration[]>
  /** Drop-in templates; defaults to the built-in starter set. */
  templates?: readonly InsertTemplate[]
  /** Accepted upload mime types. Default: PNG/JPEG/GIF/WebP. */
  accept?: string
  className?: string
}

type Tab = 'uploads' | 'templates' | 'generations'

const DEFAULT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

/** Read an image url's natural dimensions in the browser; resolves `{0,0}` when
 *  Image is unavailable (SSR/tests), the load fails, or the probe times out —
 *  builders fall back to the size cap, so a failed probe still inserts a sensibly
 *  sized element rather than blocking insertion. */
const PROBE_TIMEOUT_MS = 4000

function probeImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve({ width: 0, height: 0 })
    let settled = false
    const finish = (size: { width: number; height: number }) => {
      if (settled) return
      settled = true
      resolve(size)
    }
    const img = new Image()
    img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => finish({ width: 0, height: 0 })
    // A URL that never loads (or an environment that never fires load/error)
    // must not hang the insert forever.
    setTimeout(() => finish({ width: 0, height: 0 }), PROBE_TIMEOUT_MS)
    img.src = url
  })
}

function UploadGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 9l5-5 5 5M12 4v12" />
    </svg>
  )
}

function SparkleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  )
}

function SpinnerGlyph({ className }: { className?: string }) {
  return (
    <svg className={`${className ?? ''} animate-spin`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" strokeLinecap="round" />
    </svg>
  )
}

/** Probe-page geometry for deriving a template's primary element kind. The
 *  result drives only the tile preview, so the exact dimensions don't matter. */
const PREVIEW_PROBE_PAGE: InsertPageGeometry = { pageId: 'preview', width: 1000, height: 1000 }

/** The visual a template tile shows. Derived from the first element the
 *  template's (pure) `build` produces, so custom templates render correctly
 *  too — not just the built-in set. */
type TemplateShape = 'heading' | 'body' | 'rect' | 'ellipse' | 'other'

/** A text element is treated as a heading (shown as "T") when it reads as a
 *  title — bold or set in a large face; otherwise body copy (shown as "¶"). */
const HEADING_FONT_SIZE = 32

function templateShape(tpl: InsertTemplate): TemplateShape {
  try {
    const ops = tpl.build(PREVIEW_PROBE_PAGE)
    const added = ops.find((op) => op.type === 'add_element')
    if (!added || added.type !== 'add_element') return 'other'
    const el = added.element
    if (el.kind === 'rect') return 'rect'
    if (el.kind === 'ellipse') return 'ellipse'
    if (el.kind === 'text') {
      const isHeading = el.fontStyle.includes('bold') || el.fontSize >= HEADING_FONT_SIZE
      return isHeading ? 'heading' : 'body'
    }
    return 'other'
  } catch {
    // A throwing build can't preview; fall through to the neutral shape glyph.
    return 'other'
  }
}

/** A small visual standing in for what the template inserts, so tiles are
 *  distinguishable at a glance instead of four identical text chips. */
function TemplatePreview({ shape }: { shape: TemplateShape }) {
  if (shape === 'rect') {
    return <span className="block h-6 w-9 rounded-sm bg-[var(--brand-primary)]" aria-hidden />
  }
  if (shape === 'ellipse') {
    return <span className="block h-7 w-7 rounded-full bg-[var(--brand-primary)]" aria-hidden />
  }
  // Text tiles show a glyph: a bold "T" for a heading, a paragraph mark "¶"
  // for body copy.
  if (shape === 'heading' || shape === 'body') {
    return (
      <span
        className={`block leading-none text-[var(--text-primary)] ${
          shape === 'heading' ? 'text-2xl font-bold' : 'text-lg'
        }`}
        aria-hidden
      >
        {shape === 'heading' ? 'T' : '¶'}
      </span>
    )
  }
  return <ShapesGlyph className="h-6 w-6 text-[var(--text-muted)]" />
}

export function CanvasInsertPanel({
  canWrite,
  page,
  onInsert,
  onUploadImage,
  loadGenerations,
  templates = DEFAULT_INSERT_TEMPLATES,
  accept = DEFAULT_ACCEPT,
  className,
}: CanvasInsertPanelProps) {
  const [tab, setTab] = useState<Tab>('uploads')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [generations, setGenerations] = useState<InsertGeneration[]>([])
  const [generationsLoaded, setGenerationsLoaded] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (tab !== 'generations' || generationsLoaded || !loadGenerations) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await loadGenerations()
        if (!cancelled) setGenerations(rows.filter((g) => g.url))
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load generations')
      } finally {
        if (!cancelled) setGenerationsLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tab, generationsLoaded, loadGenerations])

  async function insertImageFromUrl(url: string) {
    // Validate the media boundary BEFORE probing — a data: or sandbox-local url
    // throws here (surfaced as an inline error) without a wasted image load.
    assertSceneMediaSrc(url, 'image src')
    const natural = await probeImageSize(url)
    await onInsert([buildInsertImageOp(url, natural, page)])
  }

  async function handleFiles(files: FileList | File[]) {
    if (!canWrite || busy) return
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (list.length === 0) {
      setError('Only image files can be added to the canvas')
      return
    }
    setBusy(true)
    setError('')
    try {
      for (const file of list) {
        const url = await onUploadImage(file)
        await insertImageFromUrl(url)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function runInsert(build: () => SceneOperation[] | Promise<SceneOperation[]>) {
    if (!canWrite || busy) return
    setBusy(true)
    setError('')
    try {
      await onInsert(await build())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Insert failed')
    } finally {
      setBusy(false)
    }
  }

  const tabs: Array<{ id: Tab; label: string; icon: (p: { className?: string }) => ReactElement; show: boolean }> = [
    { id: 'uploads', label: 'Uploads', icon: ImageGlyph, show: true },
    { id: 'templates', label: 'Templates', icon: ShapesGlyph, show: templates.length > 0 },
    { id: 'generations', label: 'Generations', icon: SparkleGlyph, show: !!loadGenerations },
  ]
  const visibleTabs = tabs.filter((t) => t.show)

  return (
    <div className={`flex h-full min-h-0 flex-col bg-[var(--bg-input)] text-[var(--text-primary)] ${className ?? ''}`}>
      <div className="flex shrink-0 border-b border-[var(--border-default)]">
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors ${
              tab === id
                ? 'border-b-2 border-[var(--brand-primary)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {!canWrite ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-[var(--text-muted)]">
          You have view-only access to this design.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === 'uploads' && (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  if (e.dataTransfer?.files?.length) void handleFiles(e.dataTransfer.files)
                }}
                className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors disabled:opacity-50 ${
                  dragOver
                    ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                    : 'border-[var(--border-default)] hover:border-[var(--brand-primary)]/40'
                }`}
              >
                {busy ? (
                  <SpinnerGlyph className="h-6 w-6 text-[var(--brand-primary)]" />
                ) : (
                  <UploadGlyph className="h-6 w-6 text-[var(--text-muted)]" />
                )}
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {busy ? 'Uploading…' : 'Drop an image or click to upload'}
                </span>
                <span className="text-xs text-[var(--text-muted)]">PNG, JPEG, GIF, or WebP</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={accept}
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void handleFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
          )}

          {tab === 'templates' && (
            <div className="grid grid-cols-2 gap-2">
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void runInsert(() => tpl.build(page))}
                  className="flex h-20 flex-col items-center justify-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] text-xs font-medium text-[var(--text-primary)] transition-colors hover:border-[var(--brand-primary)]/40 disabled:opacity-50"
                >
                  <span className="flex h-7 items-center justify-center">
                    <TemplatePreview shape={templateShape(tpl)} />
                  </span>
                  <span>{tpl.label}</span>
                </button>
              ))}
            </div>
          )}

          {tab === 'generations' && (
            <div className="flex flex-col gap-2">
              {!generationsLoaded ? (
                <div className="flex items-center justify-center py-8 text-[var(--text-muted)]">
                  <SpinnerGlyph className="h-5 w-5" />
                </div>
              ) : generations.length === 0 ? (
                <p className="px-1 py-6 text-center text-sm text-[var(--text-muted)]">
                  No generated images yet. Ask the agent to generate one.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {generations.map((gen) => (
                    <button
                      key={gen.id}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (busy || !canWrite) return
                        setBusy(true)
                        setError('')
                        insertImageFromUrl(gen.url)
                          .catch((err) => setError(err instanceof Error ? err.message : 'Insert failed'))
                          .finally(() => setBusy(false))
                      }}
                      title={gen.label}
                      className="group relative aspect-square overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-input)] transition-colors hover:border-[var(--brand-primary)] disabled:opacity-50"
                    >
                      {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
                      <img src={gen.url} alt={gen.label || 'Generated image'} className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {error ? <p className="mt-3 text-xs leading-5 text-[var(--text-danger,#dc2626)]">{error}</p> : null}
        </div>
      )}
    </div>
  )
}
