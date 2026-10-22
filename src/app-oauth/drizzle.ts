/**
 * Drizzle tables for Better Auth's JWT and OAuth provider plugins on SQLite/D1:
 * signing keys, clients, resources, client-resource links, refresh and access
 * tokens, consents and client assertions. Table names and field keys match the
 * provider models; text columns hold provider-serialized arrays and objects.
 * Column names, defaults and indexes are the ones products already migrated,
 * so adopting the factory produces no migration.
 *
 * Imports `drizzle-orm` at module top, so it lives behind its own subpath.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Build the Better Auth JWT and OAuth provider tables. */
export function createAppOAuthTables() {
  const jwks = sqliteTable('jwks', {
    id: text('id').primaryKey(),
    publicKey: text('publicKey').notNull(),
    privateKey: text('privateKey').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }),
    alg: text('alg'),
    crv: text('crv'),
  })

  const oauthClient = sqliteTable('oauthClient', {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull().unique(),
    clientSecret: text('clientSecret'),
    clientDiscoveryId: text('clientDiscoveryId'),
    disabled: integer('disabled', { mode: 'boolean' }).default(false),
    skipConsent: integer('skipConsent', { mode: 'boolean' }),
    enableEndSession: integer('enableEndSession', { mode: 'boolean' }),
    subjectType: text('subjectType'),
    scopes: text('scopes'),
    clientCredentialsScopes: text('clientCredentialsScopes').default('[]'),
    userId: text('userId'),
    createdAt: integer('createdAt', { mode: 'timestamp' }),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts'),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('softwareId'),
    softwareVersion: text('softwareVersion'),
    softwareStatement: text('softwareStatement'),
    redirectUris: text('redirectUris').notNull(),
    postLogoutRedirectUris: text('postLogoutRedirectUris'),
    backchannelLogoutUri: text('backchannelLogoutUri'),
    backchannelLogoutSessionRequired: integer('backchannelLogoutSessionRequired', { mode: 'boolean' }),
    tokenEndpointAuthMethod: text('tokenEndpointAuthMethod'),
    applicationType: text('applicationType'),
    jwks: text('jwks'),
    jwksUri: text('jwksUri'),
    grantTypes: text('grantTypes'),
    responseTypes: text('responseTypes'),
    public: integer('public', { mode: 'boolean' }),
    type: text('type'),
    requirePKCE: integer('requirePKCE', { mode: 'boolean' }),
    dpopBoundAccessTokens: integer('dpopBoundAccessTokens', { mode: 'boolean' }).default(false),
    referenceId: text('referenceId'),
    metadata: text('metadata'),
  }, (table) => [index('oauth_client_user_id_idx').on(table.userId)])

  const oauthResource = sqliteTable('oauthResource', {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull().unique(),
    name: text('name').notNull(),
    accessTokenTtl: integer('accessTokenTtl'),
    refreshTokenTtl: integer('refreshTokenTtl'),
    signingAlgorithm: text('signingAlgorithm'),
    signingKeyId: text('signingKeyId'),
    allowedScopes: text('allowedScopes'),
    customClaims: text('customClaims'),
    dpopBoundAccessTokensRequired: integer('dpopBoundAccessTokensRequired', { mode: 'boolean' }).default(false),
    disabled: integer('disabled', { mode: 'boolean' }).default(false),
    createdAt: integer('createdAt', { mode: 'timestamp' }),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }),
    policyVersion: integer('policyVersion').default(1),
    metadata: text('metadata'),
  })

  const oauthClientResource = sqliteTable('oauthClientResource', {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resourceId').notNull().references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: text('metadata'),
    createdAt: integer('createdAt', { mode: 'timestamp' }),
  }, (table) => [
    index('oauth_client_resource_client_id_idx').on(table.clientId),
    index('oauth_client_resource_resource_id_idx').on(table.resourceId),
    uniqueIndex('oauth_client_resource_pair_unique').on(table.clientId, table.resourceId),
  ])

  const oauthRefreshToken = sqliteTable('oauthRefreshToken', {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('clientId').notNull(),
    sessionId: text('sessionId'),
    userId: text('userId').notNull(),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requestedUserInfoClaims'),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    revoked: integer('revoked', { mode: 'timestamp' }),
    rotatedAt: integer('rotatedAt', { mode: 'timestamp' }),
    rotationReplayResponse: text('rotationReplayResponse'),
    rotationReplayExpiresAt: integer('rotationReplayExpiresAt', { mode: 'timestamp' }),
    authTime: integer('authTime', { mode: 'timestamp' }),
    confirmation: text('confirmation'),
    scopes: text('scopes').notNull(),
  }, (table) => [
    index('oauth_refresh_token_client_id_idx').on(table.clientId),
    index('oauth_refresh_token_session_id_idx').on(table.sessionId),
    index('oauth_refresh_token_user_id_idx').on(table.userId),
    index('oauth_refresh_token_authorization_code_id_idx').on(table.authorizationCodeId),
  ])

  const oauthAccessToken = sqliteTable('oauthAccessToken', {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('clientId').notNull(),
    sessionId: text('sessionId'),
    userId: text('userId'),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requestedUserInfoClaims'),
    refreshId: text('refreshId'),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    revoked: integer('revoked', { mode: 'timestamp' }),
    confirmation: text('confirmation'),
    scopes: text('scopes').notNull(),
  }, (table) => [
    index('oauth_access_token_client_id_idx').on(table.clientId),
    index('oauth_access_token_session_id_idx').on(table.sessionId),
    index('oauth_access_token_user_id_idx').on(table.userId),
    index('oauth_access_token_refresh_id_idx').on(table.refreshId),
    index('oauth_access_token_authorization_code_id_idx').on(table.authorizationCodeId),
  ])

  const oauthConsent = sqliteTable('oauthConsent', {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull(),
    userId: text('userId'),
    referenceId: text('referenceId'),
    resources: text('resources'),
    requestedUserInfoClaims: text('requestedUserInfoClaims'),
    scopes: text('scopes').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
  }, (table) => [
    index('oauth_consent_client_id_idx').on(table.clientId),
    index('oauth_consent_user_id_idx').on(table.userId),
  ])

  const oauthClientAssertion = sqliteTable('oauthClientAssertion', {
    id: text('id').primaryKey(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
  })

  return {
    jwks, oauthClient, oauthResource, oauthClientResource, oauthRefreshToken,
    oauthAccessToken, oauthConsent, oauthClientAssertion,
  }
}

/** The tables `createAppOAuthTables` returns. */
export type AppOAuthTables = ReturnType<typeof createAppOAuthTables>
