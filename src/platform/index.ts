/**
 * App-side glue for running a product on the Tangle platform
 * (id.tangle.tools): cross-site SSO login orchestration. The wire clients
 * and persistence are structural seams; this module owns the protocol.
 */

export * from './sso.js'
export * from './sso-identity-store.js'
export * from './hub-settings.js'
export * from './billing.js'
export * from './guards.js'
export * from './api-key-auth.js'
export * from './agent-keys.js'
export * from './agent-spend.js'
