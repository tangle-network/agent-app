/**
 * Drizzle-backed substrate for the teams module: the table factory
 * (`createTeamTables`), the RBAC access builders (`createWorkspaceAccess`,
 * `createOrganizationAccess`), and `createEnsurePersonalOrganization`. Its own
 * subpath (`@tangle-network/agent-app/teams/drizzle`) because every file here
 * imports `drizzle-orm` at module top — bundling them into `./teams` would make
 * the optional peer a hard requirement for every teams consumer.
 *
 * The pure `./teams` leaf (role algebra + invite helpers) stays drizzle-free,
 * so an app that imports only `./teams` (or only `.`) never pulls drizzle.
 */
export * from './drizzle/schema'
export * from './drizzle/access'
export * from './drizzle/personal-organization'
