/**
 * The studio history screen — the full media library behind the home screen's
 * "View history" button: search, a media-type filter, cursor-paged infinite
 * scroll, and the multi-select bar that runs download / save-to-vault / delete
 * over a whole selection at once.
 *
 * It ASSUMES a `StudioToastProvider` and a `StudioPlaybackProvider` above it —
 * the deferred delete it drives lives in both (undo toast, stopping audio for a
 * row that is going away), and every screen in this surface makes the same
 * assumption so a route layout can mount the two providers once.
 *
 * The screen never fetches: `fetchPage` is the product's own paged endpoint and
 * `actions` are its media seams. An ABSENT action hides its control rather than
 * rendering a batch button that does nothing.
 */
import { type JSX } from 'react';
import { type FetchGenerationsPage, type GenerationPage, type StudioMediaActions } from '../studio/ports';
export interface StudioHistoryScreenProps {
    fetchPage: FetchGenerationsPage;
    /** SSR/loader page 1 for the DEFAULT view (no search, no type filter). */
    initialPage?: GenerationPage;
    onBack: () => void;
    actions?: StudioMediaActions;
    /** Trailing debounce before a keystroke becomes a fetch. */
    searchDebounceMs?: number;
    className?: string;
}
export declare function StudioHistoryScreen({ fetchPage, initialPage, onBack, actions, searchDebounceMs, className, }: StudioHistoryScreenProps): JSX.Element;
