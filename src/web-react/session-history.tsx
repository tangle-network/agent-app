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

export * from './use-infinite-scroll'
export * from './use-session-history'
export * from './use-session-actions'
export * from './session-history-panel'
