/**
 * Inline SVG glyphs for the design canvas editor. No external icon dependency —
 * same convention as sequences-react/components/glyphs.tsx.
 */

interface GlyphProps {
  className?: string
}

function glyph(paths: React.ReactNode) {
  return function Glyph({ className }: GlyphProps) {
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

export const UndoGlyph = glyph(<path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7" />)
export const RedoGlyph = glyph(<path d="M21 7v6h-6M21 13a9 9 0 1 1-3-7.7" />)
export const SwapGlyph = glyph(<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />)

export const EyeGlyph = glyph(
  <>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </>,
)

export const EyeOffGlyph = glyph(
  <>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="m1 1 22 22" />
  </>,
)

export const LockGlyph = glyph(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
)

export const UnlockGlyph = glyph(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 1 1 8 0" />
  </>,
)

export const TrashGlyph = glyph(
  <>
    <path d="M3 6h18M19 6l-1 14H6L5 6M10 6V4h4v2" />
  </>,
)

export const GroupGlyph = glyph(
  <>
    <rect x="2" y="2" width="8" height="8" rx="1" />
    <rect x="14" y="2" width="8" height="8" rx="1" />
    <rect x="2" y="14" width="8" height="8" rx="1" />
    <rect x="14" y="14" width="8" height="8" rx="1" />
  </>,
)

export const UngroupGlyph = glyph(
  <>
    <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
  </>,
)

export const BringFrontGlyph = glyph(
  <>
    <rect x="8" y="8" width="12" height="12" rx="1" />
    <path d="M4 4h12v4H4z" opacity=".4" />
  </>,
)

export const SendBackGlyph = glyph(
  <>
    <rect x="4" y="4" width="12" height="12" rx="1" opacity=".4" />
    <path d="M8 8h12v12H8z" />
  </>,
)

export const AlignLeftGlyph = glyph(
  <>
    <path d="M3 4v16M7 8h10M7 16h6" />
  </>,
)
export const AlignCenterGlyph = glyph(
  <>
    <path d="M12 4v16M7 8h10M9 16h6" />
  </>,
)
export const AlignRightGlyph = glyph(
  <>
    <path d="M21 4v16M7 8h10M11 16h6" />
  </>,
)

export const BoldGlyph = glyph(<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z" fill="currentColor" stroke="none" />)
export const ItalicGlyph = glyph(<path d="M11 4h6M7 20h6M14 4 8 20" />)

export const PlusGlyph = glyph(<path d="M12 5v14M5 12h14" />)
export const ChevronDownGlyph = glyph(<path d="m6 9 6 6 6-6" />)

export const RectGlyph = glyph(<rect x="3" y="3" width="18" height="18" rx="2" />)
export const EllipseGlyph = glyph(<ellipse cx="12" cy="12" rx="10" ry="7" />)
export const LineGlyph = glyph(<path d="M5 19 19 5" />)
export const TextGlyph = glyph(<path d="M4 7V4h16v3M9 20h6M12 4v16" />)
export const ImageGlyph = glyph(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </>,
)
export const VideoGlyph = glyph(
  <>
    <rect x="2" y="3" width="20" height="18" rx="2" />
    <path d="m10 8 6 4-6 4z" fill="currentColor" stroke="none" />
  </>,
)

export const SlotGlyph = glyph(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8l2.8-2.8M17 7 19.8 4.2" />
  </>,
)

export const PageGlyph = glyph(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>,
)

export const GridGlyph = glyph(
  <>
    <path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18" />
  </>,
)

export const RulerGlyph = glyph(
  <>
    <path d="M1 9v6l12 6V9L1 3z" />
    <path d="m13 15 9-4.5V4.5L13 9" />
    <path d="M5 12v3M8 13.5v2.5M11 15v3" />
  </>,
)

export const MagnetGlyph = glyph(
  <>
    <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3z" />
    <path d="m5 8 4 4M12 15l4 4" />
  </>,
)

export const BleedGlyph = glyph(
  <>
    <rect x="4" y="4" width="16" height="16" strokeDasharray="3 2" />
    <rect x="7" y="7" width="10" height="10" />
  </>,
)

export const DuplicateGlyph = glyph(
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M4 16V4a2 2 0 0 1 2-2h12" />
  </>,
)

export const ZoomFitGlyph = glyph(
  <>
    <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" />
  </>,
)

export const ExportGlyph = glyph(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </>,
)

export const ShapesGlyph = glyph(
  <>
    <rect x="3" y="13" width="8" height="8" rx="1" />
    <circle cx="17" cy="17" r="4" />
    <path d="M8.5 3 13 11H4z" />
  </>,
)
