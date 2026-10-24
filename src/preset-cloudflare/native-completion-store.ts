import type { NativeCompletionAdmissionStore } from '../chat-routes/native-completion'
import type { TurnTraceSummary, TurnSpanRecord } from '../turn-trace/index'
import type { TurnLockReleaseInput } from '../turn-stream/core'
import type { D1Like } from './index'

/** Server-authorized identities. Products extend this with typed settlement data, never credentials. */
export interface NativeCompletionPayload {
  executionId: string
  nativeExecutionId: string
  turnId: string
  sessionId: string
  workspaceId: string
  threadId: string
  userId: string
  turnStreamId: string
  registeredAt: number
  lock: TurnLockReleaseInput
}

/** Absolute event clocks retain both request and post-admission origins. */
export interface NativeCompletionCheckpoint {
  checkpointTruncated?: boolean
  requestStartedAt: number
  phaseStartedAt?: number
  turnStartedAt: number
  firstVisibleAt?: number
  firstTextAt?: number
  trace: {
    traceId: string
    executionId: string
    rootSpanId: string
    startedAt: number
    spans: TurnSpanRecord[]
    summary: TurnTraceSummary
    truncatedSpans?: number
  }
  phasesMs: Record<string, number>
  concurrentMs: Record<string, number>
  queries: Record<string, number>
}

interface StoredRow {
  payload: string
  checkpoint: string
  state: 'open' | 'closed'
  owner_lease_until: number
  closed_at: number | null
  updated_at: number
  finalized_at: number | null
  vault_reconciled_at: number | null
}

export function createD1NativeCompletionStore<TPayload extends NativeCompletionPayload>(db: D1Like, table: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('Invalid native completion table')
  const read = async (executionId: string) => {
    const row = await db.prepare(`SELECT * FROM ${table} WHERE execution_id = ?`)
      .bind(executionId).first<StoredRow>()
    return row ? { payload: JSON.parse(row.payload) as TPayload,
      checkpoint: JSON.parse(row.checkpoint) as NativeCompletionCheckpoint,
      state: row.state, ownerLeaseUntil: row.owner_lease_until, closedAt: row.closed_at,
      updatedAt: row.updated_at, finalizedAt: row.finalized_at, vaultReconciledAt: row.vault_reconciled_at } : null
  }
  const admission = (row: Awaited<ReturnType<typeof read>>) => row ? {
    executionId: row.payload.executionId, state: row.state,
    admittedTurnIds: [row.payload.nativeExecutionId], ownerLeaseUntil: row.ownerLeaseUntil,
    closedAt: row.closedAt, updatedAt: row.updatedAt,
  } : null
  const admissionStore: NativeCompletionAdmissionStore = {
    read: async id => admission(await read(id)),
    async renew(id, now) {
      await db.prepare(`UPDATE ${table} SET owner_lease_until = ?, updated_at = ?
        WHERE execution_id = ? AND state = 'open'`).bind(now.getTime() + 120_000, now.getTime(), id).run()
      return admission(await read(id))
    },
    async closeExpired(id, now) {
      await db.prepare(`UPDATE ${table} SET state = 'closed', closed_at = ?, updated_at = ?
        WHERE execution_id = ? AND state = 'open' AND owner_lease_until <= ?`)
        .bind(now.getTime(), now.getTime(), id, now.getTime()).run()
      return admission(await read(id))
    },
  }
  return {
    read, admissionStore,
    async projectionEnded(executionId: string) {
      // This relinquishes only the request's admission lease. The observer
      // still requires the exact native ledger to be terminal before closing.
      await db.prepare(`UPDATE ${table} SET owner_lease_until = ?
        WHERE execution_id = ? AND state = 'open'`).bind(Date.now(), executionId).run()
    },
    async register(payload: TPayload, checkpoint: NativeCompletionCheckpoint) {
      await db.prepare(`INSERT INTO ${table}
        (execution_id, payload, checkpoint, owner_lease_until, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(execution_id) DO NOTHING`).bind(payload.executionId, JSON.stringify(payload),
          JSON.stringify(checkpoint), payload.registeredAt + 120_000, payload.registeredAt).run()
      const retained = await read(payload.executionId)
      if (!retained || retained.payload.workspaceId !== payload.workspaceId
        || retained.payload.threadId !== payload.threadId || retained.payload.userId !== payload.userId
        || retained.payload.turnStreamId !== payload.turnStreamId || retained.payload.lock.lockId !== payload.lock.lockId
        || retained.state !== 'open') {
        throw new Error('Native completion identity is already owned by another admission')
      }
      // Model failover stays under the original logical turn and lock. Only
      // its live owner can move the exact native observation to a new attempt.
      const updated = await db.prepare(`UPDATE ${table} SET payload = ?, checkpoint = ?,
        owner_lease_until = ?, updated_at = ? WHERE execution_id = ? AND state = 'open'`)
        .bind(JSON.stringify(payload), JSON.stringify(checkpoint), Date.now() + 120_000,
          Date.now(), payload.executionId).run()
      if ((updated as { meta?: { changes?: number } }).meta?.changes !== 1) throw new Error('Native completion admission closed before dispatch')
    },
    async checkpoint(executionId: string, value: NativeCompletionCheckpoint) {
      // Only two event transitions write after registration: first visible and
      // first text. A delayed request write cannot overwrite terminal state.
      await db.prepare(`UPDATE ${table} SET checkpoint = ?, updated_at = ?
        WHERE execution_id = ? AND finalized_at IS NULL`)
        .bind(JSON.stringify(value), Date.now(), executionId).run()
    },
    async vaultReconciled(executionId: string) {
      await db.prepare(`UPDATE ${table} SET vault_reconciled_at = ?
        WHERE execution_id = ? AND finalized_at IS NULL`).bind(Date.now(), executionId).run()
    },
    async finalized(executionId: string) {
      await db.prepare(`UPDATE ${table} SET state = 'closed', finalized_at = ?,
        closed_at = coalesce(closed_at, ?), updated_at = ? WHERE execution_id = ? AND finalized_at IS NULL`)
        .bind(Date.now(), Date.now(), Date.now(), executionId).run()
    },
  }
}
