/**
 * Inline text editor: a positioned <textarea> that appears over a text element
 * on double-click, mirroring its font properties at the current zoom. The
 * parent Workspace mounts this when `editingElementId` is set and unmounts it
 * on commit/cancel.
 *
 * V1 simplification: rotation is NOT applied to the textarea — rotated text
 * elements are edited in a non-rotated overlay at the element's AABB origin.
 * The textarea stays axis-aligned to avoid browser textarea rotation bugs.
 * Document the intent: a v2 pass may add a CSS transform to align with rotation.
 *
 * Commit: Meta+Enter or blur → emits `onCommit(newText)`.
 * Cancel: Escape → emits `onCancel()` and restores pre-edit text.
 */

import { useEffect, useRef } from 'react'
import { computeTextOverlayPosition } from './transform-math'
import type { TextElement } from '../../design-canvas/model'

export interface InlineTextEditorProps {
  element: TextElement
  zoom: number
  panX: number
  panY: number
  onCommit(text: string): void
  onCancel(): void
}

export function InlineTextEditor({
  element,
  zoom,
  panX,
  panY,
  onCommit,
  onCancel,
}: InlineTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const pos = computeTextOverlayPosition({
    elementX: element.x,
    elementY: element.y,
    elementWidth: element.width,
    elementHeight: element.fontSize * element.lineHeight * 4, // generous initial height
    zoom,
    panX,
    panY,
    elementFontSize: element.fontSize,
  })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
    // Meta+Enter or Ctrl+Enter commits
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onCommit(ref.current?.value ?? element.text)
    }
  }

  function handleBlur() {
    onCommit(ref.current?.value ?? element.text)
  }

  // Map model fontStyle → CSS font-style + font-weight
  const fontWeight = element.fontStyle.includes('bold') ? 'bold' : 'normal'
  const fontStyle = element.fontStyle.includes('italic') ? 'italic' : 'normal'

  return (
    <textarea
      ref={ref}
      defaultValue={element.text}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      style={{
        position: 'absolute',
        left: pos.left,
        top: pos.top,
        width: pos.width,
        // Height auto-grows via CSS; min so single-line text has room.
        minHeight: pos.fontSize * element.lineHeight * 1.5,
        fontSize: pos.fontSize,
        fontFamily: element.fontFamily,
        fontWeight,
        fontStyle,
        textAlign: element.align,
        lineHeight: element.lineHeight,
        letterSpacing: element.letterSpacing * zoom,
        color: element.fill,
        // Neutral token surface rather than a forced white: a white fill makes
        // light text invisible while editing. The token surface stays legible
        // for any text color and matches the editor chrome.
        background: 'var(--bg-input)',
        border: '2px solid var(--brand-primary)',
        borderRadius: 2,
        padding: 2,
        resize: 'none',
        outline: 'none',
        overflow: 'hidden',
        boxSizing: 'border-box',
        zIndex: 1000,
        // Do NOT apply rotation — see V1 simplification note in module header.
      }}
      aria-label={`Editing text element "${element.name}"`}
    />
  )
}
