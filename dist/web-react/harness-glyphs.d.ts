/**
 * Per-harness brand marks for the canonical pickers — the same marks the
 * legacy sandbox-ui harness picker (`dashboard/harness-logo.tsx`) shipped,
 * vendored as inline SVG so `/web-react` stays dependency-free beyond React:
 * sandbox-ui (and its `@lobehub/icons-static-svg` bundle) is an OPTIONAL peer
 * the canonical pickers must not force on a consumer. Geometry is the lobehub
 * single-color artwork, rendered in `currentColor` exactly as the legacy
 * component painted it (a foreground-filled CSS mask), so every mark tracks
 * the theme. Harnesses with no published brand mark get an honest inline
 * lucide glyph — bot / plug / terminal, the same fallbacks the legacy picker
 * used — and an unknown id falls back to the neutral bot. Data-record
 * structure mirrors `./provider-logo`.
 */
import type { ReactNode } from 'react';
import type { Harness } from '../harness';
export interface HarnessGlyphProps {
    /** Harness to mark. Typed as the canonical union; an out-of-union runtime
     *  value still renders — it gets the neutral fallback glyph. */
    harness: Harness;
    className?: string;
}
/**
 * Brand mark for a harness — size it from the call site (`className="h-4
 * w-4"`). Unknown ids render the neutral bot, never an invented logo.
 * `data-glyph` names the resolved mark so tests and stories can assert
 * brand-vs-fallback without snapshotting path data.
 */
export declare function HarnessGlyph({ harness, className }: HarnessGlyphProps): ReactNode;
