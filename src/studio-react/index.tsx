/**
 * `@tangle-network/agent-app/studio-react` — the media-generation studio
 * surface: a prompt composer over the five generation types (image / video /
 * avatar / speech / transcription) with a model picker and a publish-package
 * staging form, a result canvas, and a right-side asset-library drawer with
 * card + detail views. `StudioWorkspace` is the ready-to-mount shell (header +
 * composer + canvas + drawer + the merge/poll/revalidate orchestrator); the
 * leaf components are exported so a product can compose its own shell.
 *
 * The host route owns the loader (auth / RBAC / generation query) and the
 * server endpoints it talks to (`/api/generate`, `/api/media-models`,
 * `/api/generations`). Styling: Tailwind against the shared design tokens via
 * `@tangle-network/sandbox-ui` primitives; the slide/bloom/shimmer animations
 * ship at `./studio-react/styles` (apps that lack those classes import it once).
 */
export * from './studio-workspace'
export * from './use-studio-generations'
export * from './composer-hero'
export * from './composer-shell'
export * from './studio-header'
export * from './studio-sheet'
export * from './result-canvas'
export * from './library-drawer'
export * from './library-panel'
export * from './generation-card'
export * from './generation-detail'
export * from './generation-detail-modal'
export * from './publish-package-composer'
export * from './type-config'
export * from './image-composer'
export * from './video-composer'
export * from './speech-composer'
export * from './avatar-composer'
export * from './transcription-composer'
