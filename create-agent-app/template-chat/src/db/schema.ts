/**
 * src/db/schema.ts — the whole database graph, one drizzle schema.
 *
 * Two halves:
 *   - better-auth's users/sessions/accounts/verifications tables (the standard
 *     shape its drizzle adapter expects — column names must match
 *     `migrations/0001_init.sql`, which the e2e test executes for real).
 *   - the chat thread/message pair from `createChatTables()` (the shell owns
 *     the columns; you never hand-roll them).
 *
 * `workspace_id` on threads is a plain text column here: this template ships
 * single-user workspaces (workspace = user id). Adopting real teams later
 * means passing your workspace table as `createChatTables({ workspaceTable })`
 * — see `@tangle-network/agent-app/teams`.
 */

import { createChatTables } from '@tangle-network/agent-app/chat-store'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ── better-auth tables ──────────────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull(),
})

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const verifications = sqliteTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})

// ── chat tables (shell-owned columns) ───────────────────────────────────────

export const { threads, messages } = createChatTables()
