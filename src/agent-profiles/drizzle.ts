/** Drizzle table definitions matching `AGENT_PROFILE_D1_SCHEMA_SQL`. */
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export function createAgentProfileTables() {
  const revisions = sqliteTable('agent_profile_revision', {
    id: text('revision_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    profileId: text('profile_id').notNull(),
    parentId: text('parent_id'),
    profileJson: text('profile_json').notNull(),
    knowledgeText: text('knowledge_text').notNull(),
    authorKind: text('author_kind', { enum: ['person', 'agent', 'optimizer'] }).notNull(),
    authorId: text('author_id').notNull(),
    reason: text('reason').notNull(),
    diffJson: text('diff_json').notNull(),
    authorityDigest: text('authority_digest').notNull(),
    planDigest: text('plan_digest').notNull(),
    state: text('state', { enum: ['active', 'candidate', 'pending-consent'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  }, table => [index('agent_profile_revision_history')
    .on(table.workspaceId, table.profileId, table.createdAt)])

  const activations = sqliteTable('agent_profile_activation_event', {
    eventId: text('event_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    profileId: text('profile_id').notNull(),
    version: integer('version').notNull(),
    revisionId: text('revision_id').notNull().references(() => revisions.id),
    createdAt: integer('created_at').notNull(),
  }, table => [uniqueIndex('agent_profile_activation_order').on(table.workspaceId, table.profileId, table.version)])

  const bindingEvents = sqliteTable('agent_profile_binding_event', {
    eventId: text('event_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    memberId: text('member_id').notNull(),
    channel: text('channel').notNull(),
    profileId: text('profile_id').notNull(),
    pinnedRevisionId: text('pinned_revision_id'),
    authorityDigest: text('authority_digest').notNull(),
    planDigest: text('plan_digest').notNull(),
    version: integer('version').notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    createdAt: integer('created_at').notNull(),
  }, table => [
    uniqueIndex('agent_profile_binding_order').on(table.workspaceId, table.memberId, table.channel, table.version),
    uniqueIndex('agent_profile_binding_source').on(table.workspaceId, table.memberId, table.channel, table.sourceMessageId),
  ])

  const switchReceipts = sqliteTable('agent_profile_switch_receipt', {
    workspaceId: text('workspace_id').notNull(),
    memberId: text('member_id').notNull(),
    channel: text('channel').notNull(),
    messageId: text('message_id').notNull(),
    inputHash: text('input_hash').notNull(),
    profileId: text('profile_id'),
    revisionId: text('revision_id'),
    pinnedRevisionId: text('pinned_revision_id'),
    authorityDigest: text('authority_digest'),
    planDigest: text('plan_digest'),
    outcome: text('outcome', { enum: ['switched', 'refused'] }).notNull(),
    message: text('message').notNull(),
    conflictsJson: text('conflicts_json').notNull(),
  }, table => [primaryKey({ columns: [table.workspaceId, table.memberId, table.channel, table.messageId] })])

  const turnPins = sqliteTable('agent_profile_turn_pin', {
    workspaceId: text('workspace_id').notNull(),
    memberId: text('member_id').notNull(),
    channel: text('channel').notNull(),
    messageId: text('message_id').notNull(),
    inputHash: text('input_hash').notNull(),
    profileId: text('profile_id').notNull(),
    revisionId: text('revision_id').notNull(),
    authorityDigest: text('authority_digest').notNull(),
    planDigest: text('plan_digest').notNull(),
  }, table => [primaryKey({ columns: [table.workspaceId, table.memberId, table.channel, table.messageId] })])

  const knowledgeEvents = sqliteTable('agent_profile_knowledge_event', {
    eventId: text('event_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    profileId: text('profile_id').notNull(),
    documentId: text('document_id').notNull(),
    kind: text('kind', { enum: ['add', 'remove'] }).notNull(),
    content: text('content'),
    observedAddIdsJson: text('observed_add_ids_json').notNull(),
    createdAt: integer('created_at').notNull(),
  }, table => [index('agent_profile_knowledge_history')
    .on(table.workspaceId, table.profileId, table.documentId, table.createdAt)])

  return { revisions, activations, bindingEvents, switchReceipts, turnPins, knowledgeEvents }
}
