/**
 * `@tangle-network/agent-app/studio-react` — the media-generation studio
 * surface: `StudioComposer`, a chat-shaped card over three generation types
 * (image / video / speech) whose option pills are the SELECTED MODEL's own
 * published parameters, plus the generation notice and merge/poll/revalidate
 * hook products use to compose their own shell.
 *
 * The host route owns the loader (auth / RBAC / generation query) and the
 * server endpoints it talks to (`/api/generate`, `/api/media-models`,
 * `/api/generations`). Styling uses Tailwind against the shared design tokens;
 * composer animations ship at `./studio-react/styles`.
 */
export * from './use-studio-generations'
export * from './studio-composer'
export * from './generation-notice'
