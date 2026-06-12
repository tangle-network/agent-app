/**
 * Inline SVG glyphs for the timeline editor. The package stays dependency-free
 * beyond React (the repo convention — see web-react), so the handful of icons
 * the editor needs are inlined with lucide-equivalent path data.
 */

interface GlyphProps {
  className?: string
}

function glyph(paths: React.ReactNode) {
  return function Glyph({ className }: GlyphProps) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {paths}
      </svg>
    )
  }
}

export const FilmGlyph = glyph(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" />
  </>,
)

export const AudioGlyph = glyph(
  <path d="M2 12h2l2-7 3 14 3-9 2 5 2-3h6" />,
)

export const CaptionGlyph = glyph(
  <>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 13h4M6 16h8M14 13h4" />
  </>,
)

export const ReferenceGlyph = glyph(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </>,
)

export const AgentGlyph = glyph(
  <>
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M12 8V4M8 4h8M9 13v2M15 13v2" />
  </>,
)

export const LockGlyph = glyph(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
)

export const MutedGlyph = glyph(
  <>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="m23 9-6 6M17 9l6 6" />
  </>,
)

export const PlayGlyph = glyph(
  <path d="m6 4 14 8-14 8z" fill="currentColor" stroke="none" />,
)

export const PauseGlyph = glyph(
  <path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" stroke="none" />,
)

export const UndoGlyph = glyph(
  <path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7" />,
)

export const RedoGlyph = glyph(
  <path d="M21 7v6h-6M21 13a9 9 0 1 1-3-7.7" />,
)

export const MagnetGlyph = glyph(
  <>
    <path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3z" />
    <path d="m5 8 4 4M12 15l4 4" />
  </>,
)

export const ScissorsGlyph = glyph(
  <>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" />
  </>,
)

export const CaptionPlusGlyph = glyph(
  <>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M12 9v6M9 12h6" />
  </>,
)
