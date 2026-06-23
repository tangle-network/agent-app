/**
 * Teams capability — the tenancy/membership model for agent products, exposed
 * as opt-in subpaths so an app that never imports `./teams*` pulls zero teams
 * code (and zero `drizzle-orm`). This barrel is the PURE leaf: role algebra and
 * invite-token helpers with no drizzle, no env, no react, no I/O.
 *
 * The rest of the capability layers on top, each behind its own subpath:
 *   - `@tangle-network/agent-app/teams/drizzle`     — table factory + access
 *       builders + `ensurePersonalOrganization` (imports `drizzle-orm`).
 *   - `@tangle-network/agent-app/teams/members-api` — framework-neutral
 *       invite/list/role/remove handlers (imports `drizzle-orm`).
 *   - `@tangle-network/agent-app/teams/invitations-api` — framework-neutral
 *       email-invitation lifecycle (create/list/resend/revoke/preview/accept,
 *       imports `drizzle-orm`).
 *   - `@tangle-network/agent-app/teams-react`       — MembersPanel +
 *       InvitationsPanel + InviteAcceptPage (optional `react` peer).
 *
 * NEVER re-exported from the package root: `drizzle-orm` and `react` are
 * optional peers, and the whole point is that the tax stays clean.
 */
export * from './roles'
export * from './invite'
export * from './invitations'
