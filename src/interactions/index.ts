/**
 * `@tangle-network/agent-app/interactions` — the human-in-the-loop interaction
 * channel, both halves:
 *
 *   - the shared wire/persisted-part contract (`contract.ts`) a chat producer
 *     and a chat client agree on (also re-exported from `./web-react` so
 *     existing imports keep working),
 *   - the server side (`sidecar.ts` + `route.ts`): a structural client for the
 *     sidecar's `/agents/sessions/{id}/interactions` REST channel and
 *     `createInteractionAnswerRoute()`, the list/answer endpoint factory that
 *     retires the per-app route forks.
 *
 * Substrate-free: the only peer is `@tangle-network/agent-interface` (schema
 * types). The sidecar connection is a structural value, never an SDK import.
 */

export * from './contract'
export * from './sidecar'
export * from './route'
