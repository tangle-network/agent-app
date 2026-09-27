/**
 * The rendered half of the session shell: the history view behind the rail's
 * session list, and the rename/delete dialogs both surfaces drive.
 *
 * Storage is a seam, not a dependency. Every product keeps sessions somewhere
 * different (gtm threads, tax sessions, legal matters), so this takes a
 * `fetchPage` data port and injected mutations — the same shape
 * `AgentActivityPanel` (`fetchActivity`) and `ReviewQueuePanel` (`fetchQueue`)
 * already use, rather than a fifth pattern.
 *
 * sandbox-ui free on purpose: `/web-react` must not force the optional peer, so
 * these render on the shared design tokens like the rest of the subpath. The
 * pure logic (nav items, routing, cookies, merging) lives in `/session-shell`,
 * which a server loader can import without pulling React.
 */
import { type ReactNode, type RefObject } from 'react';
import { type SessionPage, type SessionRailAction, type SessionSort, type SessionSummary } from '../session-shell/index';
export interface UseInfiniteScrollOptions {
    /** Only fire `onLoadMore` while true (a next page exists, none in flight). */
    enabled: boolean;
    /** Scroll container the sentinel lives in. Defaults to the viewport. */
    root?: RefObject<HTMLElement | null>;
    /** Prefetch distance before the sentinel is actually reached. */
    rootMargin?: string;
}
/**
 * Fires `onLoadMore` when a sentinel element scrolls into view. Returns a ref
 * callback for that sentinel (typically the last element in a list).
 *
 * The observer is re-created whenever `enabled` flips, so a short first page
 * that leaves the sentinel on-screen keeps loading: when a load finishes and
 * `enabled` returns to true, the fresh observer re-reads the current
 * intersection state and fires again until the sentinel is pushed off-screen.
 */
export declare function useInfiniteScroll(onLoadMore: () => void, { enabled, root, rootMargin }: UseInfiniteScrollOptions): (node: HTMLElement | null) => void;
export interface SessionPageQuery {
    /** Trimmed search term; empty string means no filter. */
    q: string;
    sort: SessionSort;
    /** `null` for the first page. */
    cursor: string | null;
    /** Aborted when the view changes or the component unmounts. */
    signal: AbortSignal;
}
/** Data port — one page of sessions for the current view. */
export type FetchSessionPage = (query: SessionPageQuery) => Promise<SessionPage>;
export interface UseSessionHistoryOptions {
    fetchPage: FetchSessionPage;
    /** Trimmed search term driving the fetch. */
    q: string;
    sort: SessionSort;
    /** SSR page 1 of the default view, so the first paint costs no request. */
    initialPage: SessionPage;
    /** The sort `initialPage` was rendered for. Default `'newest'`. */
    defaultSort?: SessionSort;
}
export interface SessionHistoryState {
    items: SessionSummary[];
    hasMore: boolean;
    isLoadingFirst: boolean;
    isLoadingMore: boolean;
    isError: boolean;
    loadMore: () => void;
    /** Re-run whichever load failed. */
    retry: () => void;
    /** Refetch page 1 — call after a client-side mutation (e.g. a delete). */
    reload: () => void;
}
/**
 * Infinite-scroll data source for the history view. Seeds from `initialPage`
 * for the default view (no fetch) and otherwise fetches page 1 for the current
 * search/sort; `loadMore` appends the next cursor page.
 *
 * Raw promises + `AbortController` rather than a router fetcher, so a filter
 * change cancels in-flight requests, pages accumulate, and a late response from
 * a superseded view is dropped by the monotonic `seq` guard.
 */
export declare function useSessionHistory({ fetchPage, q, sort, initialPage, defaultSort, }: UseSessionHistoryOptions): SessionHistoryState;
export interface SessionActionsOptions {
    /** Persist a new title. Reject to surface the error in the dialog. */
    renameSession: (sessionId: string, title: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    /** Called after a successful rename/delete — revalidate the rail here. */
    onChanged?: () => void;
    /** Called after deleting the session the user is currently viewing, so the
     *  product can navigate away from a route that no longer resolves. */
    onDeletedCurrent?: () => void;
    /** The open session, compared against the delete target. */
    currentSessionId?: string | null;
    /** Product toast/log seam. Errors also render inside the dialog. */
    notify?: (level: 'success' | 'error', message: string) => void;
    labels?: Partial<SessionActionLabels>;
}
export interface SessionActionLabels {
    renameTitle: string;
    renameField: string;
    renameSubmit: string;
    deleteTitle: string;
    deleteBody: (title: string) => string;
    deleteSubmit: string;
    cancel: string;
    renamed: string;
    deleted: string;
    renameFailed: string;
    deleteFailed: string;
}
export interface SessionActions {
    openRename: (session: SessionSummary) => void;
    openDelete: (session: SessionSummary) => void;
    /** Render once, anywhere that survives navigation (the layout). */
    dialogs: ReactNode;
    busy: boolean;
}
/**
 * Rename + delete for one session, shared by the rail kebab and the history
 * row menu so both drive the same dialogs and the same product mutations.
 *
 * Dialogs are owned here rather than returned as raw state: two surfaces
 * needing the same confirm step is exactly how a product ends up with two
 * subtly different delete confirmations.
 */
export declare function useSessionActions({ renameSession, deleteSession, onChanged, onDeletedCurrent, currentSessionId, notify, labels, }: SessionActionsOptions): SessionActions;
export interface SessionHistoryPanelProps {
    history: SessionHistoryState;
    /** Whether the workspace has any sessions at all — decided by the SSR page,
     *  independent of the active search, so filtering to zero shows "no matches"
     *  rather than the first-run empty state. */
    hasAnySessions: boolean;
    query: string;
    onQueryChange: (value: string) => void;
    sort: SessionSort;
    onSortChange: (value: SessionSort) => void;
    /** Product route for one session row. */
    hrefForSession: (sessionId: string) => string;
    /** Rendered as the row link. Defaults to an `<a>`; pass a router Link to keep
     *  client-side navigation. */
    linkComponent?: LinkLikeComponent;
    /** Ids currently mid-turn — renders the responding treatment. */
    respondingSessionIds?: ReadonlySet<string>;
    onRename?: (session: SessionSummary) => void;
    onDelete?: (session: SessionSummary) => void;
    /** Product-owned mutation for selected rows or a workspace-wide age range. */
    onBulkAction?: (action: SessionBulkAction) => Promise<void>;
    /** Menu wording, so this surface and the rail name the same act the same way
     *  — a product whose delete is really an archive says so in both places. */
    renameLabel?: string;
    deleteLabel?: string;
    /**
     * Row actions this shell has no opinion about — pin, categorise, share.
     * Same seam and same ordering as the rail's `SessionRowActions.extraActions`:
     * evaluated per session, placed between rename and delete. This menu is
     * text-only, so `icon` is ignored here and honoured on the rail.
     */
    extraActions?: (session: SessionSummary) => SessionRailAction[];
    /** New-session destination for the header action. Omitted ⇒ no button. */
    newSessionHref?: string;
    title?: string;
    untitledLabel?: string;
    emptyTitle?: string;
    emptyDescription?: string;
    /** Absolute → relative timestamp. Defaults to a compact built-in. */
    formatTimestamp?: (isoDate: string | null) => string;
    /** Max width of the reading column. `'full'` opts out for a product whose
     *  surface really is a wide table. Default keeps title and timestamp inside
     *  one scannable line rather than at opposite edges of a 1440px viewport. */
    contentWidth?: 'reading' | 'full';
    className?: string;
}
export type SessionBulkAction = {
    kind: 'selected';
    ids: string[];
} | {
    kind: 'older-than';
    days: number;
} | {
    kind: 'newer-than';
    days: number;
};
export interface LinkLikeProps {
    to: string;
    className?: string;
    children?: ReactNode;
}
export type LinkLikeComponent = (props: LinkLikeProps) => ReactNode;
/** Compact relative time. Overridable — a product with its own i18n passes
 *  `formatTimestamp` rather than this being the only option. */
export declare function formatSessionTimestamp(isoDate: string | null): string;
/**
 * The full session history: search, sort, cursor-paged rows with per-row
 * actions, and the states in between (first-run empty, loading, no matches,
 * error + retry).
 *
 * This is the surface the rail's capped list overflows into — the reason the
 * rail can stay short without hiding the user's work.
 */
export declare function SessionHistoryPanel({ history, hasAnySessions, query, onQueryChange, sort, onSortChange, hrefForSession, linkComponent: Link, respondingSessionIds, onRename, onDelete, onBulkAction, renameLabel, deleteLabel, extraActions, newSessionHref, title, untitledLabel, emptyTitle, emptyDescription, formatTimestamp, contentWidth, className, }: SessionHistoryPanelProps): import("react").JSX.Element;
