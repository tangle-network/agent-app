/** Shared SVG frame and identical editor glyphs; React is the only peer. */
import type { ReactNode } from 'react'

export interface EditorGlyphProps {
  className?: string
}

export function createEditorGlyph(paths: ReactNode) {
  return function Glyph({ className }: EditorGlyphProps) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {paths}
      </svg>
    )
  }
}


export const UndoGlyph = createEditorGlyph(<path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7" />)
export const RedoGlyph = createEditorGlyph(<path d="M21 7v6h-6M21 13a9 9 0 1 1-3-7.7" />)
export const LockGlyph = createEditorGlyph(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
)

export const PlusGlyph = createEditorGlyph(<path d="M12 5v14M5 12h14" />)
export const MinusGlyph = createEditorGlyph(<path d="M5 12h14" />)
export const MagnetGlyph = createEditorGlyph(
  <>
    <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3z" />
    <path d="m5 8 4 4M12 15l4 4" />
  </>,
)
