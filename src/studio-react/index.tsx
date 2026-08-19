/**
 * `@tangle-network/agent-app/studio-react` — the media-generation studio
 * surface: three screens over injected ports plus the pieces they compose.
 *
 * - `StudioHomeScreen` — the centered `StudioComposer` above a full-bleed
 *   "Recent media" grid.
 * - `StudioGenerationScreen` — one prompt's batch: shimmer skeletons at the
 *   chosen aspect, results, and the docked composer on an opaque band.
 * - `StudioHistoryScreen` — server-side search + media-type filter, select
 *   mode with batch actions, cursor-paginated lazy loading.
 * - `MediaTile` / `MediaViewerModal` — the shared tile (hover scrim, vault
 *   state, select circle, audio badge) and the viewer with the audio
 *   transport.
 * - `StudioToastProvider` + `StudioPlaybackProvider` — required above every
 *   screen: bottom-centre toasts with Undo, and ONE audio playback state
 *   shared by tiles and the viewer.
 * - `useDeferredDelete` / `useGenerationHistory` / `useBatchNavigation` —
 *   the undo-window delete, cursor paging, and once-per-batch navigation.
 *
 * The host route owns the loader (auth / RBAC / generation query), the server
 * endpoints (`/api/generate`, `/api/media-models`, `/api/generations`, save /
 * delete routes), navigation between the screens, and the providers;
 * `useStudioGenerations` is the merge/poll/revalidate orchestrator a host
 * route drives. Data and actions reach the screens only through the seams in
 * `../studio/ports` — an absent action hides its control. This subpath is
 * sandbox-ui-free and Radix-free; styling is Tailwind against the shared
 * design tokens, with studio-specific rules at `./studio-react/styles`.
 */
export * from './use-studio-generations'
export * from './studio-composer'
export * from './composer-option-controls'
export * from './generation-notice'
export * from './media-tile'
export * from './media-viewer'
export * from './studio-home-screen'
export * from './studio-generation-screen'
export * from './studio-history-screen'
export * from './studio-toasts'
export * from './studio-confirm'
export * from './vault-path-popover'
export * from './studio-playback'
export * from './use-batch-navigation'
export * from './use-generation-history'
export * from './use-deferred-delete'
export * from './download-generations'
