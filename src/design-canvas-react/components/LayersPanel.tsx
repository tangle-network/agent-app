/**
 * Layers panel — reverse-z list of the active page's elements. Highest z-index
 * is at the top. Groups show their children indented beneath them. Clicking
 * selects an element; meta-click adds to selection. Double-clicking the name
 * opens an inline rename input. Eye and lock icons toggle visibility/locked.
 * Rows can be drag-reordered within the list (siblings only; cross-group reorder
 * is a pending integrator concern). Capped at LAYERS_PANEL_ROW_LIMIT rows.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { SceneElement, ScenePage } from '../../design-canvas/model'
import { flattenLayerTree, LAYERS_PANEL_ROW_LIMIT } from './layer-tree'
import {
  EllipseGlyph,
  EyeGlyph,
  EyeOffGlyph,
  GroupGlyph,
  ImageGlyph,
  LineGlyph,
  LockGlyph,
  RectGlyph,
  SlotGlyph,
  TextGlyph,
  UnlockGlyph,
  VideoGlyph,
} from './glyphs'
import type { SceneElementKind } from '../../design-canvas/model'

function KindIcon({ kind, className }: { kind: SceneElementKind; className?: string }) {
  switch (kind) {
    case 'rect': return <RectGlyph className={className} />
    case 'ellipse': return <EllipseGlyph className={className} />
    case 'line': return <LineGlyph className={className} />
    case 'text': return <TextGlyph className={className} />
    case 'image': return <ImageGlyph className={className} />
    case 'video': return <VideoGlyph className={className} />
    case 'group': return <GroupGlyph className={className} />
  }
}

export interface LayersPanelProps {
  page: ScenePage
  selectedElementIds: string[]
  canWrite: boolean
  /** Emit a set_attrs command for the given element. */
  onSetAttrs(elementId: string, attrs: Partial<Pick<SceneElement, 'name' | 'visible' | 'locked'>>): void
  /** Emit a reorder_element command. */
  onReorder(elementId: string, toIndex: number): void
  onSelect(elementId: string, additive: boolean): void
}

const INDENT_PX = 16

export function LayersPanel({ page, selectedElementIds, canWrite, onSetAttrs, onReorder, onSelect }: LayersPanelProps) {
  const rows = useMemo(() => flattenLayerTree(page), [page])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Drag-reorder state: we track the dragged row's ownerIndex and the target
  // index within the SAME owner. Cross-owner reorder is not supported here.
  const dragRowRef = useRef<{ elementId: string; ownerIndex: number; ownerLength: number } | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  function startRename(element: SceneElement) {
    setRenamingId(element.id)
    setRenameValue(element.name)
  }

  function commitRename(elementId: string) {
    const name = renameValue.trim()
    if (name.length > 0) onSetAttrs(elementId, { name })
    setRenamingId(null)
  }

  const visible = rows.length > LAYERS_PANEL_ROW_LIMIT ? rows.slice(0, LAYERS_PANEL_ROW_LIMIT) : rows

  return (
    <div className="flex h-full flex-col overflow-hidden text-[var(--text-primary)]">
      <div className="shrink-0 border-b border-[var(--border-default)] px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Layers
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.map((row) => {
          const { element } = row
          const isSelected = selectedElementIds.includes(element.id)
          const isRenaming = renamingId === element.id

          return (
            <div
              key={element.id}
              data-layer-row={element.id}
              draggable={canWrite}
              onDragStart={() => {
                dragRowRef.current = {
                  elementId: element.id,
                  ownerIndex: row.ownerIndex,
                  ownerLength: row.ownerLength,
                }
              }}
              onDragOver={(event) => {
                if (!dragRowRef.current) return
                // Only allow reorder within the same owner (same parentGroupId + depth)
                event.preventDefault()
                setDragOverIndex(row.ownerIndex)
              }}
              onDragLeave={() => setDragOverIndex(null)}
              onDrop={() => {
                const drag = dragRowRef.current
                if (!drag) return
                if (drag.elementId !== element.id) {
                  onReorder(drag.elementId, row.ownerIndex)
                }
                dragRowRef.current = null
                setDragOverIndex(null)
              }}
              onDragEnd={() => {
                dragRowRef.current = null
                setDragOverIndex(null)
              }}
              className={[
                'group flex items-center gap-1.5 py-1 pr-2 text-[13px] transition-colors',
                isSelected ? 'bg-[var(--brand-primary)]/15 text-[var(--text-primary)]' : 'hover:bg-[var(--border-default)]/40 text-[var(--text-secondary)]',
                dragOverIndex === row.ownerIndex ? 'border-t border-[var(--brand-primary)]' : '',
              ].join(' ')}
              style={{ paddingLeft: 8 + row.depth * INDENT_PX }}
            >
              {isRenaming ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => commitRename(element.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(element.id)
                    if (event.key === 'Escape') setRenamingId(null)
                    event.stopPropagation()
                  }}
                  className="min-w-0 flex-1 rounded border border-[var(--border-default)] bg-[var(--bg-input)] px-1 py-0 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--brand-primary)]"
                />
              ) : (
                // Selection is a real button (sibling of the eye/lock buttons) so
                // the row is not an interactive control nesting interactive
                // controls (axe: nested-interactive).
                <button
                  type="button"
                  onClick={(event) => onSelect(element.id, event.metaKey || event.ctrlKey)}
                  onDoubleClick={() => {
                    if (canWrite) startRename(element)
                  }}
                  title={element.name}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 bg-transparent text-left focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
                >
                  <KindIcon kind={element.kind} className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  {element.slot ? <SlotGlyph className="h-3 w-3 shrink-0 text-[var(--brand-primary)]" /> : null}
                  <span className="min-w-0 flex-1 truncate">{element.name}</span>
                </button>
              )}

              {/* Visibility toggle */}
              <button
                type="button"
                aria-label={element.visible ? 'Hide element' : 'Show element'}
                aria-pressed={!element.visible}
                onClick={(event) => {
                  event.stopPropagation()
                  if (canWrite) onSetAttrs(element.id, { visible: !element.visible })
                }}
                disabled={!canWrite}
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
              >
                {element.visible
                  ? <EyeGlyph className="h-3.5 w-3.5" />
                  : <EyeOffGlyph className="h-3.5 w-3.5 text-[var(--text-muted)]" />}
              </button>

              {/* Lock toggle */}
              <button
                type="button"
                aria-label={element.locked ? 'Unlock element' : 'Lock element'}
                aria-pressed={!!element.locked}
                onClick={(event) => {
                  event.stopPropagation()
                  if (canWrite) onSetAttrs(element.id, { locked: !element.locked })
                }}
                disabled={!canWrite}
                className="shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100 focus-visible:opacity-100 focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
              >
                {element.locked
                  ? <LockGlyph className="h-3.5 w-3.5 text-[var(--text-warning)]" />
                  : <UnlockGlyph className="h-3.5 w-3.5" />}
              </button>
            </div>
          )
        })}

        {rows.length > LAYERS_PANEL_ROW_LIMIT ? (
          <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
            +{rows.length - LAYERS_PANEL_ROW_LIMIT} more elements — select a group to scope the list
          </div>
        ) : null}
      </div>
    </div>
  )
}
