/** Atomic D1 adapter for `/agent-profiles`. Products apply the SQL in their own migration. */
import { snapshotAgentProfile } from '@tangle-network/agent-interface'
import {
  parseProfileRevisionDiff,
  ProfileConflictError,
  serializeProfileRevisionDiff,
  type ProfileBinding,
  type ProfileBindingKey,
  type ProfileKnowledgeEvent,
  type ProfileRevision,
  type ProfileRevisionStore,
  type ProfileSwitchReceipt,
  type ProfileTurnPin,
} from './index'

/** Structural subset of Cloudflare D1; keeps the optional driver out of other subpaths. */
export interface ProfileD1Statement {
  bind(...values: (string | number | null)[]): ProfileD1Statement
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}

export interface ProfileD1Database {
  prepare(sql: string): ProfileD1Statement
  batch(statements: ProfileD1Statement[]): Promise<{ meta: { changes: number } }[]>
}

export const AGENT_PROFILE_D1_SCHEMA_SQL = `
CREATE TABLE agent_profile_revision (
  revision_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  parent_id TEXT,
  profile_json TEXT NOT NULL,
  knowledge_text TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent', 'optimizer')),
  author_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  authority_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'candidate', 'pending-consent')),
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_profile_revision_history ON agent_profile_revision(workspace_id, profile_id, created_at DESC);
CREATE TRIGGER agent_profile_revision_immutable_update BEFORE UPDATE ON agent_profile_revision
BEGIN SELECT RAISE(ABORT, 'Profile revisions are immutable'); END;
CREATE TRIGGER agent_profile_revision_immutable_delete BEFORE DELETE ON agent_profile_revision
BEGIN SELECT RAISE(ABORT, 'Profile revisions are immutable'); END;
CREATE TABLE agent_profile_activation_event (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  revision_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, profile_id, version),
  FOREIGN KEY (revision_id) REFERENCES agent_profile_revision(revision_id)
);
CREATE TABLE agent_profile_binding_event (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  pinned_revision_id TEXT,
  authority_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  source_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, member_id, channel, version),
  UNIQUE (workspace_id, member_id, channel, source_message_id)
);
CREATE TABLE agent_profile_switch_receipt (
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  conversation_id TEXT,
  created_at INTEGER NOT NULL,
  profile_id TEXT,
  revision_id TEXT,
  pinned_revision_id TEXT,
  authority_digest TEXT,
  plan_digest TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('switched', 'refused')),
  message TEXT NOT NULL,
  conflicts_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, member_id, channel, message_id)
);
CREATE INDEX agent_profile_switch_conversation ON agent_profile_switch_receipt(workspace_id, conversation_id, created_at);
CREATE TABLE agent_profile_turn_pin (
  workspace_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  message_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  authority_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  PRIMARY KEY (workspace_id, member_id, channel, message_id)
);
CREATE TABLE agent_profile_knowledge_event (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('add', 'remove')),
  content TEXT,
  observed_add_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((kind = 'add' AND content IS NOT NULL) OR (kind = 'remove' AND content IS NULL))
);
CREATE INDEX agent_profile_knowledge_history ON agent_profile_knowledge_event(workspace_id, profile_id, document_id, created_at);
CREATE TRIGGER agent_profile_activation_immutable_update BEFORE UPDATE ON agent_profile_activation_event
BEGIN SELECT RAISE(ABORT, 'Profile activation events are immutable'); END;
CREATE TRIGGER agent_profile_activation_immutable_delete BEFORE DELETE ON agent_profile_activation_event
BEGIN SELECT RAISE(ABORT, 'Profile activation events are immutable'); END;
CREATE TRIGGER agent_profile_binding_immutable_update BEFORE UPDATE ON agent_profile_binding_event
BEGIN SELECT RAISE(ABORT, 'Profile binding events are immutable'); END;
CREATE TRIGGER agent_profile_binding_immutable_delete BEFORE DELETE ON agent_profile_binding_event
BEGIN SELECT RAISE(ABORT, 'Profile binding events are immutable'); END;
CREATE TRIGGER agent_profile_switch_immutable_update BEFORE UPDATE ON agent_profile_switch_receipt
BEGIN SELECT RAISE(ABORT, 'Profile switch receipts are immutable'); END;
CREATE TRIGGER agent_profile_switch_immutable_delete BEFORE DELETE ON agent_profile_switch_receipt
BEGIN SELECT RAISE(ABORT, 'Profile switch receipts are immutable'); END;
CREATE TRIGGER agent_profile_turn_immutable_update BEFORE UPDATE ON agent_profile_turn_pin
BEGIN SELECT RAISE(ABORT, 'Profile turn pins are immutable'); END;
CREATE TRIGGER agent_profile_turn_immutable_delete BEFORE DELETE ON agent_profile_turn_pin
BEGIN SELECT RAISE(ABORT, 'Profile turn pins are immutable'); END;
CREATE TRIGGER agent_profile_knowledge_immutable_update BEFORE UPDATE ON agent_profile_knowledge_event
BEGIN SELECT RAISE(ABORT, 'Profile knowledge events are immutable'); END;
CREATE TRIGGER agent_profile_knowledge_immutable_delete BEFORE DELETE ON agent_profile_knowledge_event
BEGIN SELECT RAISE(ABORT, 'Profile knowledge events are immutable'); END;`

interface RevisionRow {
  revision_id: string
  workspace_id: string
  profile_id: string
  parent_id: string | null
  profile_json: string
  knowledge_text: string
  author_kind: ProfileRevision['author']['kind']
  author_id: string
  reason: string
  diff_json: string
  authority_digest: string
  plan_digest: string
  state: ProfileRevision['state']
  created_at: number
}

interface BindingRow {
  workspace_id: string
  member_id: string
  channel: string
  profile_id: string
  pinned_revision_id: string | null
  authority_digest: string
  plan_digest: string
  version: number
}

interface SwitchRow {
  workspace_id: string
  member_id: string
  channel: string
  message_id: string
  input_hash: string
  conversation_id: string | null
  created_at: number
  profile_id: string | null
  revision_id: string | null
  pinned_revision_id: string | null
  authority_digest: string | null
  plan_digest: string | null
  outcome: ProfileSwitchReceipt['outcome']
  message: string
  conflicts_json: string
}

interface TurnRow {
  workspace_id: string
  member_id: string
  channel: string
  message_id: string
  input_hash: string
  profile_id: string
  revision_id: string
  authority_digest: string
  plan_digest: string
}

interface KnowledgeRow {
  event_id: string
  workspace_id: string
  profile_id: string
  document_id: string
  kind: ProfileKnowledgeEvent['kind']
  content: string | null
  observed_add_ids_json: string
  created_at: number
}

const keyValues = (key: ProfileBindingKey) => [key.workspaceId, key.memberId, key.channel] as const

function revisionFromRow(row: RevisionRow): ProfileRevision {
  return { id: row.revision_id, workspaceId: row.workspace_id, profileId: row.profile_id,
    parentId: row.parent_id, profile: snapshotAgentProfile(JSON.parse(row.profile_json)),
    knowledgeText: row.knowledge_text, author: { kind: row.author_kind, id: row.author_id },
    reason: row.reason, ...parseProfileRevisionDiff(row.diff_json),
    authorityDigest: row.authority_digest, planDigest: row.plan_digest,
    state: row.state, createdAt: row.created_at }
}

function receiptFromRow(row: SwitchRow): ProfileSwitchReceipt {
  return { key: { workspaceId: row.workspace_id, memberId: row.member_id, channel: row.channel },
    messageId: row.message_id, inputHash: row.input_hash, profileId: row.profile_id,
    conversationId: row.conversation_id, createdAt: row.created_at,
    revisionId: row.revision_id, pinnedRevisionId: row.pinned_revision_id,
    authorityDigest: row.authority_digest, planDigest: row.plan_digest,
    outcome: row.outcome, message: row.message,
    conflicts: JSON.parse(row.conflicts_json) as string[] }
}

/** Product auth stays outside this read. The receipt itself is the durable chat marker. */
export async function listD1ProfileSwitchReceipts(
  db: ProfileD1Database,
  workspaceId: string,
  conversationId: string,
): Promise<ProfileSwitchReceipt[]> {
  const rows = await db.prepare(`SELECT * FROM agent_profile_switch_receipt
    WHERE workspace_id = ? AND conversation_id = ? AND outcome = 'switched'
    ORDER BY created_at, message_id`).bind(workspaceId, conversationId).all<SwitchRow>()
  return rows.results.map(receiptFromRow)
}

function turnFromRow(row: TurnRow): ProfileTurnPin {
  return { workspaceId: row.workspace_id, memberId: row.member_id, channel: row.channel,
    messageId: row.message_id, inputHash: row.input_hash, profileId: row.profile_id,
    revisionId: row.revision_id, authorityDigest: row.authority_digest, planDigest: row.plan_digest }
}

export function createD1ProfileRevisionStore(db: ProfileD1Database): ProfileRevisionStore {
  const currentActivation = `(SELECT revision_id FROM agent_profile_activation_event
    WHERE workspace_id = ? AND profile_id = ? ORDER BY version DESC LIMIT 1)`
  const bindingVersion = `(SELECT COALESCE(MAX(version), 0) FROM agent_profile_binding_event
    WHERE workspace_id = ? AND member_id = ? AND channel = ?)`

  async function getRevision(workspaceId: string, profileId: string, revisionId: string) {
    const row = await db.prepare(`SELECT * FROM agent_profile_revision WHERE workspace_id = ? AND profile_id = ? AND revision_id = ?`)
      .bind(workspaceId, profileId, revisionId).first<RevisionRow>()
    return row ? revisionFromRow(row) : null
  }

  async function getActiveRevision(workspaceId: string, profileId: string) {
    const row = await db.prepare(`SELECT r.* FROM agent_profile_activation_event h JOIN agent_profile_revision r
      ON r.revision_id = h.revision_id WHERE h.workspace_id = ? AND h.profile_id = ?
      ORDER BY h.version DESC LIMIT 1`)
      .bind(workspaceId, profileId).first<RevisionRow>()
    return row ? revisionFromRow(row) : null
  }

  async function getBinding(key: ProfileBindingKey): Promise<ProfileBinding | null> {
    const row = await db.prepare(`SELECT * FROM agent_profile_binding_event
      WHERE workspace_id = ? AND member_id = ? AND channel = ? ORDER BY version DESC LIMIT 1`)
      .bind(...keyValues(key)).first<BindingRow>()
    return row ? { workspaceId: row.workspace_id, memberId: row.member_id, channel: row.channel,
      profileId: row.profile_id, pinnedRevisionId: row.pinned_revision_id,
      authorityDigest: row.authority_digest, planDigest: row.plan_digest, version: row.version } : null
  }

  async function getSwitchReceipt(key: ProfileBindingKey, messageId: string, inputHash: string) {
    const row = await db.prepare(`SELECT * FROM agent_profile_switch_receipt WHERE workspace_id = ?
      AND member_id = ? AND channel = ? AND message_id = ?`)
      .bind(...keyValues(key), messageId).first<SwitchRow>()
    if (row && row.input_hash !== inputHash) throw new ProfileConflictError('Message id was reused with different input')
    return row ? receiptFromRow(row) : null
  }

  async function getTurnPin(key: ProfileBindingKey, messageId: string, inputHash: string) {
    const row = await db.prepare(`SELECT * FROM agent_profile_turn_pin WHERE workspace_id = ?
      AND member_id = ? AND channel = ? AND message_id = ?`)
      .bind(...keyValues(key), messageId).first<TurnRow>()
    if (row && row.input_hash !== inputHash) throw new ProfileConflictError('Message id was reused with different input')
    return row ? turnFromRow(row) : null
  }

  return {
    getRevision,
    getActiveRevision,
    getBinding,
    getSwitchReceipt,
    getTurnPin,
    async listKnowledgeEvents(workspaceId, profileId) {
      const rows = await db.prepare(`SELECT * FROM agent_profile_knowledge_event
        WHERE workspace_id = ? AND profile_id = ? ORDER BY created_at, event_id`)
        .bind(workspaceId, profileId).all<KnowledgeRow>()
      return rows.results.map(row => ({ id: row.event_id, workspaceId: row.workspace_id,
        profileId: row.profile_id, documentId: row.document_id, kind: row.kind,
        content: row.content, observedAddIds: JSON.parse(row.observed_add_ids_json) as string[],
        createdAt: row.created_at }))
    },
    async appendKnowledgeEvent(event) {
      await db.prepare(`INSERT INTO agent_profile_knowledge_event
        (event_id, workspace_id, profile_id, document_id, kind, content, observed_add_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(event.id, event.workspaceId, event.profileId,
        event.documentId, event.kind, event.content, JSON.stringify(event.observedAddIds), event.createdAt).run()
    },
    async appendRevision(revision, expectedActiveId, activate) {
      const rowValues = [revision.id, revision.workspaceId, revision.profileId, revision.parentId,
        JSON.stringify(revision.profile), revision.knowledgeText, revision.author.kind, revision.author.id,
        revision.reason, serializeProfileRevisionDiff(revision), revision.authorityDigest, revision.planDigest,
        revision.state, revision.createdAt]
      const insert = db.prepare(`INSERT INTO agent_profile_revision
        (revision_id, workspace_id, profile_id, parent_id, profile_json, knowledge_text,
         author_kind, author_id, reason, diff_json, authority_digest, plan_digest, state, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${expectedActiveId === null
          ? `${currentActivation} IS NULL`
          : `${currentActivation} = ?`}`)
        .bind(...rowValues, revision.workspaceId, revision.profileId,
          ...(expectedActiveId === null ? [] : [expectedActiveId]))
      if (!activate) return (await insert.run()).meta.changes === 1
      const activateEvent = db.prepare(`INSERT INTO agent_profile_activation_event
        (event_id, workspace_id, profile_id, version, revision_id, created_at)
        SELECT ?, ?, ?, COALESCE((SELECT MAX(version) FROM agent_profile_activation_event
          WHERE workspace_id = ? AND profile_id = ?), 0) + 1, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_profile_revision WHERE revision_id = ?
          AND workspace_id = ? AND profile_id = ?)
          AND ${expectedActiveId === null ? `${currentActivation} IS NULL` : `${currentActivation} = ?`}`)
        .bind(crypto.randomUUID(), revision.workspaceId, revision.profileId,
          revision.workspaceId, revision.profileId, revision.id, Date.now(),
          revision.id, revision.workspaceId, revision.profileId,
          revision.workspaceId, revision.profileId, ...(expectedActiveId === null ? [] : [expectedActiveId]))
      const [inserted, activated] = await db.batch([insert, activateEvent])
      return inserted?.meta.changes === 1 && activated?.meta.changes === 1
    },
    async promoteRevision(workspaceId, profileId, revisionId, expectedActiveId) {
      const query = db.prepare(`INSERT INTO agent_profile_activation_event
        (event_id, workspace_id, profile_id, version, revision_id, created_at)
        SELECT ?, ?, ?, COALESCE((SELECT MAX(version) FROM agent_profile_activation_event
          WHERE workspace_id = ? AND profile_id = ?), 0) + 1, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_profile_revision WHERE workspace_id = ?
          AND profile_id = ? AND revision_id = ? AND parent_id IS ?)
          AND ${expectedActiveId === null ? `${currentActivation} IS NULL` : `${currentActivation} = ?`}`)
        .bind(crypto.randomUUID(), workspaceId, profileId, workspaceId, profileId,
          revisionId, Date.now(), workspaceId, profileId, revisionId, expectedActiveId,
          workspaceId, profileId, ...(expectedActiveId === null ? [] : [expectedActiveId]))
      return (await query.run()).meta.changes === 1
    },
    async recordSwitch(receipt, expectedVersion) {
      const key = receipt.key
      const versionGuard = `${bindingVersion} = ?`
      const insertReceipt = (requireEventId?: string) => db.prepare(`INSERT INTO agent_profile_switch_receipt
        (workspace_id, member_id, channel, message_id, input_hash, conversation_id, created_at, profile_id, revision_id,
         pinned_revision_id, authority_digest, plan_digest, outcome, message, conflicts_json)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ${requireEventId ? `(SELECT ? WHERE EXISTS (SELECT 1 FROM agent_profile_binding_event WHERE event_id = ?))` : '?'}, ?
        WHERE ${versionGuard} ${requireEventId ? '' : 'ON CONFLICT DO NOTHING'}`)
        .bind(...keyValues(key), receipt.messageId, receipt.inputHash,
          receipt.conversationId ?? null, receipt.createdAt ?? Date.now(),
          receipt.profileId, receipt.revisionId, receipt.pinnedRevisionId,
          receipt.authorityDigest, receipt.planDigest, receipt.outcome,
          receipt.message, ...(requireEventId ? [requireEventId] : []),
          JSON.stringify(receipt.conflicts), ...keyValues(key),
          requireEventId ? expectedVersion + 1 : expectedVersion)
      if (receipt.outcome === 'refused') {
        await insertReceipt().run()
      } else {
        const eventId = crypto.randomUUID()
        const move = db.prepare(`INSERT INTO agent_profile_binding_event
          (event_id, workspace_id, member_id, channel, profile_id, pinned_revision_id,
           authority_digest, plan_digest, version, source_message_id, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${versionGuard}
            AND EXISTS (SELECT 1 FROM agent_profile_revision r WHERE r.workspace_id = ?
              AND r.profile_id = ? AND r.revision_id = ? AND r.authority_digest = ?)
            AND (? IS NOT NULL OR ${currentActivation} = ?)
          ON CONFLICT DO NOTHING`)
          .bind(eventId, ...keyValues(key), receipt.profileId, receipt.pinnedRevisionId,
            receipt.authorityDigest, receipt.planDigest, expectedVersion + 1,
            receipt.messageId, Date.now(), ...keyValues(key), expectedVersion,
            key.workspaceId, receipt.profileId, receipt.revisionId, receipt.authorityDigest,
            receipt.pinnedRevisionId, key.workspaceId, receipt.profileId, receipt.revisionId)
        // A failed event makes the receipt's required message NULL. D1's batch
        // rolls back both writes instead of leaving a success receipt without a binding.
        const [moved, inserted] = await db.batch([move, insertReceipt(eventId)])
        if (moved?.meta.changes !== 1 || inserted?.meta.changes !== 1) {
          throw new ProfileConflictError('Profile binding changed during switch')
        }
      }
      const saved = await getSwitchReceipt(key, receipt.messageId, receipt.inputHash)
      if (!saved) throw new ProfileConflictError('Profile binding changed during switch')
      return saved
    },
    async pinTurn(pin, expectedBindingVersion) {
      const key = pin
      const prior = await getTurnPin(key, pin.messageId, pin.inputHash)
      if (prior) return prior
      const inserted = await db.prepare(`INSERT INTO agent_profile_turn_pin
        (workspace_id, member_id, channel, message_id, input_hash, profile_id, revision_id,
         authority_digest, plan_digest)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM agent_profile_binding_event b WHERE b.workspace_id = ? AND b.member_id = ?
            AND b.channel = ? AND b.version = ? AND b.profile_id = ?
            AND b.version = (SELECT MAX(version) FROM agent_profile_binding_event
              WHERE workspace_id = b.workspace_id AND member_id = b.member_id AND channel = b.channel)
            AND b.authority_digest = ?
            AND (b.pinned_revision_id = ? OR (b.pinned_revision_id IS NULL AND EXISTS (
              SELECT 1 FROM agent_profile_activation_event h WHERE h.workspace_id = b.workspace_id
                AND h.profile_id = b.profile_id AND h.revision_id = ?
                AND h.version = (SELECT MAX(version) FROM agent_profile_activation_event
                  WHERE workspace_id = b.workspace_id AND profile_id = b.profile_id))))
        ) AND EXISTS (SELECT 1 FROM agent_profile_revision r WHERE r.workspace_id = ?
          AND r.profile_id = ? AND r.revision_id = ? AND r.authority_digest = ?)
        ON CONFLICT DO NOTHING`)
        .bind(...keyValues(key), pin.messageId, pin.inputHash, pin.profileId, pin.revisionId,
          pin.authorityDigest, pin.planDigest, ...keyValues(key), expectedBindingVersion,
          pin.profileId, pin.authorityDigest,
          pin.revisionId, pin.revisionId, key.workspaceId,
          pin.profileId, pin.revisionId, pin.authorityDigest).run()
      const saved = await getTurnPin(key, pin.messageId, pin.inputHash)
      if (!saved || (inserted.meta.changes === 0 && saved.revisionId !== pin.revisionId)) {
        throw new ProfileConflictError('Profile binding changed during turn admission')
      }
      return saved
    },
  }
}
