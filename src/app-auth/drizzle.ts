/**
 * Drizzle tables for the better-auth core models (`user`, `session`,
 * `account`, `verification`) on SQLite/D1. Column names, defaults and indexes
 * are the ones products already migrated, so adopting the factory produces no
 * migration. `createAppAuth` takes the result as its `schema`.
 *
 * A product that stores more on the session row (a platform bearer refreshed
 * at each sign-in, for example) passes those columns as `sessionColumns`;
 * they are placed after `userAgent`, where existing tables carry them. Extra
 * user columns go in `userColumns`, after `image`. A product whose migrated
 * tables carry extra indexes, another index name or no issuer default states
 * them in the options; every default is unchanged.
 *
 * Imports `drizzle-orm` at module top, so it lives behind its own subpath.
 */

import { sql, type BuildColumns, type BuildExtraConfigColumns } from 'drizzle-orm'
import {
  integer, sqliteTable, text, uniqueIndex,
  type SQLiteColumnBuilderBase, type SQLiteTableExtraConfigValue, type SQLiteTableWithColumns,
} from 'drizzle-orm/sqlite-core'

/** Extra session columns, keyed by their TypeScript field name. */
export type AppAuthSessionColumns = Record<string, SQLiteColumnBuilderBase>

/** Extra user columns, keyed by their TypeScript field name. */
export type AppAuthUserColumns = Record<string, SQLiteColumnBuilderBase>

/** Options for the better-auth core tables. */
export interface CreateAppAuthTablesOptions<
  S extends AppAuthSessionColumns,
  U extends AppAuthUserColumns = Record<never, never>,
> {
  /** Columns the product adds to the session row. Default none. */
  sessionColumns?: S
  /** Columns the product adds to the user row. Default none. */
  userColumns?: U
  /** Indexes the product's `user` table carries. Default none. */
  userIndexes?: (
    table: BuildExtraConfigColumns<'user', ReturnType<typeof baseUserColumns> & U, 'sqlite'>,
  ) => SQLiteTableExtraConfigValue[]
  /** Indexes the product's `account` table carries besides the issuer/account one. Default none. */
  accountIndexes?: (
    table: BuildExtraConfigColumns<'account', ReturnType<typeof accountColumns>, 'sqlite'>,
  ) => SQLiteTableExtraConfigValue[]
  /** Name of the unique (issuer, accountId) index. Default `account_issuer_account_id_unique`. */
  accountIssuerIndexName?: string
  /** Default for `account.issuer`; null declares none. Default `local:credential`. */
  accountIssuerDefault?: string | null
}

const createdAt = () => integer('createdAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
const updatedAt = () => integer('updatedAt', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)

function baseSessionColumns() {
  return {
    id: text('id').primaryKey(),
    userId: text('userId').notNull(),
    token: text('token').notNull().unique(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
  }
}

function baseUserColumns() {
  return {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
  }
}

function accountColumns(issuerDefault: string | null) {
  const issuer = text('issuer').notNull()
  return {
    id: text('id').primaryKey(),
    userId: text('userId').notNull(),
    issuer: issuerDefault === null ? issuer : issuer.default(issuerDefault),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
    scope: text('scope'),
    idToken: text('idToken'),
    password: text('password'),
  }
}

function timestampColumns() {
  return { createdAt: createdAt(), updatedAt: updatedAt() }
}

/** The `session` table with the product's extra columns. */
export type AppAuthSessionsTable<S extends AppAuthSessionColumns = Record<never, never>> = SQLiteTableWithColumns<{
  name: 'session'
  schema: undefined
  columns: BuildColumns<'session', ReturnType<typeof baseSessionColumns> & S & ReturnType<typeof timestampColumns>, 'sqlite'>
  dialect: 'sqlite'
}>

/** The `user` table with the product's extra columns. */
export type AppAuthUsersTable<U extends AppAuthUserColumns = Record<never, never>> = SQLiteTableWithColumns<{
  name: 'user'
  schema: undefined
  columns: BuildColumns<'user', ReturnType<typeof baseUserColumns> & U & ReturnType<typeof timestampColumns>, 'sqlite'>
  dialect: 'sqlite'
}>

/** Build the better-auth `user`, `session`, `account` and `verification` tables. */
export function createAppAuthTables<
  S extends AppAuthSessionColumns = Record<never, never>,
  U extends AppAuthUserColumns = Record<never, never>,
>(
  options: CreateAppAuthTablesOptions<S, U> = {},
) {
  // The generic spread cannot be inferred through sqliteTable; the declared type is the same build.
  const users = sqliteTable('user', {
    ...baseUserColumns(),
    ...options.userColumns,
    ...timestampColumns(),
  }, (table) => options.userIndexes?.(table as never) ?? []) as unknown as AppAuthUsersTable<U>

  const base = baseSessionColumns()
  base.userId.references(() => users.id, { onDelete: 'cascade' })
  // The generic spread cannot be inferred through sqliteTable; the declared type is the same build.
  const sessions = sqliteTable('session', {
    ...base,
    ...options.sessionColumns,
    ...timestampColumns(),
  }) as unknown as AppAuthSessionsTable<S>

  const account = accountColumns(options.accountIssuerDefault === undefined ? 'local:credential' : options.accountIssuerDefault)
  account.userId.references(() => users.id, { onDelete: 'cascade' })
  const accounts = sqliteTable('account', {
    ...account,
    ...timestampColumns(),
  }, (table) => [
    uniqueIndex(options.accountIssuerIndexName ?? 'account_issuer_account_id_unique').on(table.issuer, table.accountId),
    ...(options.accountIndexes?.(table) ?? []),
  ])

  const verifications = sqliteTable('verification', {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  })

  return { users, sessions, accounts, verifications }
}

/** The tables `createAppAuthTables` returns. */
export type AppAuthTables<
  S extends AppAuthSessionColumns = Record<never, never>,
  U extends AppAuthUserColumns = Record<never, never>,
> = ReturnType<typeof createAppAuthTables<S, U>>
