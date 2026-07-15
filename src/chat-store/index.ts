/**
 * `/chat-store` — shared chat thread/message persistence (issue #188 Phase 1).
 *
 * Unifies the three divergent product implementations (legal's `thread`/
 * `message`, gtm's fix-absorbed copy of the same, tax's `tax_sessions`/
 * `chat_messages`) into one drizzle table factory + typed CRUD store, so
 * products stop hand-rolling incompatible chat schemas:
 * - `createChatTables` (./schema) — the table factory; per-divergence
 *   rationale lives in its docblock.
 * - `createChatStore` (./store) — list/get/create/rename/pin/delete/bulk-
 *   delete threads + list/append messages, with access control as an injected
 *   callback seam.
 * - `ChatMessagePart` (./parts) — the canonical stored `parts` vocabulary both
 *   transport lanes (harness `message.part.updated`, router openai-compat)
 *   serialize into; source citations in its docblock.
 * - pure helpers (./core) — `threadTitleFromMessage`, `ChatStoreInputError`,
 *   `BULK_DELETE_MAX_THREADS` (also re-exported from the root barrel).
 *
 * Imports `drizzle-orm` at module top — that is WHY this lives behind its own
 * subpath: the root barrel re-exports only `./core` + `./parts`, so a
 * consumer that never touches the DB never pulls the optional peer.
 */

export * from './core'
export * from './parts'
export * from './schema'
export * from './store'
