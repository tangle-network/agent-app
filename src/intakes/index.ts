/**
 * Intakes capability — per-user onboarding and per-project intake interviews
 * for agent products, exposed as opt-in subpaths so an app that never imports
 * `./intakes*` pulls zero intakes code (and zero `drizzle-orm`). This barrel is
 * the PURE leaf: the question-graph model, the completion-state algebra, and
 * the context-sufficiency floor + conversational-gather scaffold — with no
 * drizzle, no env, no react, no I/O.
 *
 * Intakes are orthogonal to teams: an app can adopt intakes with zero teams,
 * and the per-USER intake (one-time onboarding keyed on `user.id`) needs no
 * workspace at all — a single-user app takes onboarding alone. The per-PROJECT
 * intake attaches to a workspace when the app has one.
 *
 * The rest of the capability layers on top, each behind its own subpath:
 *   - `@tangle-network/agent-app/intakes/drizzle` — table factory
 *       (`createIntakeTables`, `workspaceTable` OPTIONAL) + store (imports
 *       `drizzle-orm`).
 *   - `@tangle-network/agent-app/intakes/api`     — framework-neutral
 *       get-current / save-answer / complete handlers (imports `drizzle-orm`).
 *   - `@tangle-network/agent-app/intakes-react`   — one-question-at-a-time
 *       interview UI (optional `react` peer).
 *
 * NEVER re-exported from the package root: `drizzle-orm` and `react` are
 * optional peers, and the whole point is that the tax stays clean.
 */
export * from './model'
export * from './completion'
export * from './context-sufficiency'
