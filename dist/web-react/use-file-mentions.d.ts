/**
 * `useFileMentions` — the glue a host passes straight into `ChatComposer`'s
 * `mention` prop to wire up `@`-file mentions against
 * `createSandboxFileIndexRoute` (`/chat-routes`).
 *
 * Fetches the index once per session from `indexUrl`, refreshes it in the
 * background whenever the popover opens (a `fetchItems` call) if the cached
 * copy has aged past `refreshAfterMs`, and answers every keystroke from an
 * in-memory fuzzy filter — no per-keystroke network round trip. The returned
 * `refresh()` lets a caller force a re-fetch immediately instead of waiting
 * on `refreshAfterMs` — e.g. right after the agent creates a file mid-session.
 *
 * `MentionItem` and `ComposerMentionProp` are the mention contract this
 * package defines and `mention-editor.tsx` renders. The shape stays
 * structurally identical to sandbox-ui#184's `AgentComposerProps['mention']`,
 * so the same value drives sandbox-ui's `AgentComposer` during migration
 * (tangle-network/agent-dev-container#5934) without an import either way.
 */
import type { ReactNode } from 'react';
import type { FileMention } from '../chat-routes/wire';
/** The atomic pill's payload. For a file mention, `id` is the
 *  workspace-relative path (the pill's stable identity and the `@<id>`
 *  serialization the editor uses to round-trip `value`), `label` is the
 *  display name, and `detail` carries the full path for the popover row's
 *  secondary line. */
export interface MentionItem {
    id: string;
    label: string;
    detail?: string;
    kind?: string;
}
/** `ChatComposer`'s `mention` prop shape — plug the hook's `mention` return
 *  value straight into it. Structurally identical to sandbox-ui#184's
 *  `AgentComposerProps['mention']`, so it also drives `AgentComposer`. */
export interface ComposerMentionProp {
    /** The character that opens the popover. Default "@". Read once when the
     *  editor mounts — a runtime change does not re-key the editor. */
    trigger?: string;
    /** Async provider called with the query typed after the trigger. */
    fetchItems(query: string): Promise<MentionItem[]>;
    /** Fired with the mentions currently in the document whenever they change. */
    onMentionsChange?(mentions: MentionItem[]): void;
    /** Custom row renderer for a popover item. */
    renderItem?(item: MentionItem): ReactNode;
    /** Shown when a fetch resolves to zero items. Default "No matches". */
    emptyText?: string;
    /** Extra classes merged onto the suggestion panel's root element
     *  (`role="listbox"`), applied last so they win over the component's own —
     *  the supported way to retheme the popover instead of targeting it by its
     *  ARIA attributes. */
    popoverClassName?: string;
}
/**
 * Ranks `files` against `query` (case-insensitive), capped to `limit`:
 * name-prefix matches first, then name-substring, then path-substring.
 * Within a tier, shorter names sort first (the more specific match), then
 * alphabetically by path for a stable order. An empty query returns the
 * first `limit` entries unranked — the popover's default list before typing.
 * Pure and dependency-free (no fuzzy-match library) so it's cheap enough to
 * re-run on every keystroke against a 10k-entry index.
 */
export declare function rankFileMentions(files: readonly FileMention[], query: string, limit: number): FileMention[];
/** Max popover results per query — enough to show a useful spread of matches
 *  without pushing the fuzzy-filtered list past what a popover can usefully
 *  render in one screen. */
export declare const DEFAULT_MENTION_LIMIT = 20;
/** How long a `ready` index is served before a background refetch — long
 *  enough that a full session's worth of popover opens don't repeatedly hit
 *  the index endpoint, short enough that a stale listing doesn't linger too
 *  far past workspace file changes. Callers who need the index current right
 *  now (e.g. just after the agent creates a file) call `refresh()` instead of
 *  waiting on this window. */
export declare const INDEX_REFRESH_AFTER_MS: number;
/** Popover empty-state copy for a `ready` index whose query matched nothing.
 *  Loading/warming/error states have their own copy — see `emptyTextFor`. */
export declare const DEFAULT_MENTION_EMPTY_TEXT = "No matching files";
/** Define options for configuring file mention fetching, caching, and display behavior */
export interface UseFileMentionsOptions {
    /** GET endpoint returning `FileIndexResponse` (a `createSandboxFileIndexRoute`). */
    indexUrl: string;
    /** Max popover results per query. Default {@link DEFAULT_MENTION_LIMIT}. */
    limit?: number;
    /** How long a `ready` index is served without a background refetch.
     *  Default {@link INDEX_REFRESH_AFTER_MS}. */
    refreshAfterMs?: number;
    /** `fetch` override for tests / non-global-fetch hosts. Default `fetch`. */
    fetchImpl?: typeof fetch;
    /** Text shown in the popover's empty state once the index is loaded and
     *  the query matched nothing. Default {@link DEFAULT_MENTION_EMPTY_TEXT}. */
    emptyText?: string;
}
/** Provide properties and methods to manage and refresh file mentions in a composer interface */
export interface UseFileMentionsResult {
    /** Spread straight into `ChatComposer`'s `mention` prop. */
    mention: ComposerMentionProp;
    /** The files currently referenced by mentions in the composer's value —
     *  the send-body list (map through `fileMentionsToParts`). */
    mentions: FileMention[];
    /** Drop all currently-referenced mentions (e.g. after a successful send). */
    clearMentions: () => void;
    /** Force a re-fetch of the index right now, ignoring `refreshAfterMs` — for
     *  example right after the agent creates a file mid-session, so the next
     *  popover open sees it. Dedupes against an already-in-flight load rather
     *  than firing a second request. */
    refresh: () => Promise<void>;
}
/** Resolve and manage file mention data with configurable fetching and state handling */
export declare function useFileMentions(options: UseFileMentionsOptions): UseFileMentionsResult;
