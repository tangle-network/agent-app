/**
 * Horizontal page-thumbnail strip shown at the bottom of the editor. The active
 * page is highlighted. Thumbnails are rendered externally (Konva; the host
 * injects `renderThumbnail` so this component stays canvas-free and testable).
 *
 * Actions: add page, duplicate active page, delete active page (disabled when
 * only one page remains), drag-reorder pages. The strip is read-only when
 * `canWrite` is false.
 */

import { useEffect, useRef, useState } from 'react'
import type { ScenePage } from '../../design-canvas/model'
import { DuplicateGlyph, PageGlyph, PlusGlyph, TrashGlyph } from './glyphs'
import { BTN_SM } from './icon-button'

export interface PagesStripProps {
  pages: ScenePage[]
  activePageId: string
  canWrite: boolean
  /**
   * The host provides this to generate thumbnail data-URLs. The strip calls it
   * on mount and debounces re-calls on document changes. Returns null when the
   * thumbnail is not yet available (the strip renders a placeholder instead).
   */
  renderThumbnail(page: ScenePage): Promise<string | null>
  onSelectPage(pageId: string): void
  onAddPage(): void
  onDuplicatePage(pageId: string): void
  onDeletePage(pageId: string): void
  onReorderPage(pageId: string, toIndex: number): void
  /** Show page-management affordances (add / duplicate / delete). Default true.
   *  The review surface passes false: pages are navigated, not authored. */
  canManagePages?: boolean
  /** Heading shown above the strip so it reads as page management. Overridable;
   *  defaults to "Pages". Set to '' to hide the visible label (the container
   *  keeps its accessible name regardless). */
  label?: string
}

const THUMBNAIL_W = 80
const THUMBNAIL_H = 56

export function PagesStrip({
  pages,
  activePageId,
  canWrite,
  renderThumbnail,
  onSelectPage,
  onAddPage,
  onDuplicatePage,
  onDeletePage,
  onReorderPage,
  canManagePages = true,
  label = 'Pages',
}: PagesStripProps) {
  // Map from page id → data URL; null while loading.
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({})
  const thumbnailVersionRef = useRef(0)

  useEffect(() => {
    // Debounce thumbnail regeneration: bump the version on every render cycle
    // and only apply results from the CURRENT version.
    const version = ++thumbnailVersionRef.current
    let cancelled = false

    async function generate() {
      const results: Record<string, string | null> = {}
      for (const page of pages) {
        if (cancelled) return
        try {
          results[page.id] = await renderThumbnail(page)
        } catch {
          results[page.id] = null
        }
      }
      if (!cancelled && thumbnailVersionRef.current === version) {
        setThumbnails(results)
      }
    }

    void generate()
    return () => {
      cancelled = true
    }
    // renderThumbnail is assumed stable (host memoizes it); pages is the dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages])

  // Drag-reorder
  const dragIndexRef = useRef<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  return (
    <div className="flex shrink-0 flex-col bg-[var(--bg-input)]">
      {/* Quiet section heading so the thumbnail row reads as page management,
          not a stray strip. The scroll container below keeps the accessible
          "Pages" name regardless of whether the visible label is shown. */}
      {label ? (
        <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[var(--text-muted)]">
          <PageGlyph className="h-3 w-3" />
          <span className="text-[10px] font-medium uppercase tracking-[0.08em]">{label}</span>
        </div>
      ) : null}
      <div
        className="flex h-[84px] items-center gap-2 overflow-x-auto px-2 pb-1"
        aria-label="Pages"
      >
      {pages.map((page, index) => {
        const isActive = page.id === activePageId
        const thumbUrl = thumbnails[page.id]

        return (
          <div
            key={page.id}
            draggable={canWrite}
            onDragStart={() => {
              dragIndexRef.current = index
            }}
            onDragOver={(event) => {
              if (dragIndexRef.current === null) return
              event.preventDefault()
              setDragOverIndex(index)
            }}
            onDragLeave={() => setDragOverIndex(null)}
            onDrop={() => {
              const from = dragIndexRef.current
              if (from !== null && from !== index) {
                onReorderPage(pages[from]!.id, index)
              }
              dragIndexRef.current = null
              setDragOverIndex(null)
            }}
            onDragEnd={() => {
              dragIndexRef.current = null
              setDragOverIndex(null)
            }}
            className={[
              'group relative flex shrink-0 flex-col items-center gap-1 rounded p-1 transition',
              isActive
                ? 'ring-2 ring-[var(--brand-primary)]'
                : 'hover:bg-[var(--border-default)]/40',
              dragOverIndex === index ? 'ring-1 ring-[var(--brand-primary)]/60' : '',
            ].join(' ')}
          >
            {/* Selection is a real button so the tile is not an interactive control
                nesting the per-page action buttons (axe: nested-interactive). */}
            <button
              type="button"
              aria-label={`Page ${index + 1}: ${page.name}${isActive ? ' (active)' : ''}`}
              aria-pressed={isActive}
              onClick={() => onSelectPage(page.id)}
              className="flex cursor-pointer flex-col items-center gap-1 rounded focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
            {/* Thumbnail or placeholder */}
            <div
              className="overflow-hidden rounded border border-[var(--border-default)] bg-[hsl(var(--card))]"
              style={{ width: THUMBNAIL_W, height: THUMBNAIL_H }}
            >
              {thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt={page.name}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <PageGlyph className="h-5 w-5 text-[var(--text-muted)]" />
                </div>
              )}
            </div>

            {/* Page name */}
            <span className="max-w-[80px] truncate text-[10px] text-[var(--text-secondary)]">
              {page.name}
            </span>
            </button>

            {/* Per-page action buttons — visible on hover or when active */}
            {canWrite && canManagePages ? (
              <div className="pointer-events-none absolute -top-1 right-0 flex gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                <button
                  type="button"
                  aria-label={`Duplicate page ${page.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDuplicatePage(page.id)
                  }}
                  className={BTN_SM}
                >
                  <DuplicateGlyph className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete page ${page.name}`}
                  disabled={pages.length <= 1}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (pages.length > 1) onDeletePage(page.id)
                  }}
                  className={BTN_SM}
                >
                  <TrashGlyph className="h-3 w-3 text-[var(--text-danger)]" />
                </button>
              </div>
            ) : null}
          </div>
        )
      })}

      {/* Add page button */}
      {canWrite && canManagePages ? (
        <button
          type="button"
          aria-label="Add page"
          onClick={onAddPage}
          className="flex h-[72px] w-[80px] shrink-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-[var(--border-default)] text-[var(--text-muted)] transition hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
        >
          <PlusGlyph className="h-4 w-4" />
          <span className="text-[10px]">Add page</span>
        </button>
      ) : null}
      </div>
    </div>
  )
}
