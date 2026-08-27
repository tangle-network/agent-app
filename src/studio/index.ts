/**
 * Studio module: the generation model and the pure helpers a media-generation
 * surface needs — the `Generation` row shape and its lifecycle status/error
 * derivation, the optimistic + live-merge logic that backs polling, the media
 * model catalog types + selection helpers, the request-body builder, and the
 * publish-package model.
 *
 * Logic only — no React, no DOM, no design-system import. Safe in server
 * bundles. The React surface (composer, result canvas, library drawer, the
 * `StudioWorkspace` shell) lives in `@tangle-network/agent-app/studio-react`.
 */
export * from './generation'
