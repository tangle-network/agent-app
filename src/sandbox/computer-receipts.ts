/**
 * Computer-step receipts: the durable record of one `sandbox_run` call, keyed
 * by its step id (the turn's execution, the session and the tool call).
 *
 * `prepared` is written before the task is sent and holds the Vault listing
 * taken then, so a repeated call after a lost request still copies the files
 * the first send wrote. `settled` holds the answer the model read, the model
 * that ran and the file receipt; a repeated call returns it and sends nothing.
 * A receipt holds no credential.
 */
import type { ComputerFileListing, ComputerFileReceipt } from './computer-files'

export interface ComputerStepReceipt {
  stepId: string
  state: 'prepared' | 'settled'
  sessionId: string
  model?: string
  /** The Vault listing before the first send, while `prepared`. */
  before?: ComputerFileListing
  /** The answer the model read, file receipt line included, once `settled`. */
  answer?: string
  files?: ComputerFileReceipt
  updatedAt: number
}

export interface ComputerStepReceipts {
  read(stepId: string): Promise<ComputerStepReceipt | null>
  /** A `settled` receipt is final: a later `prepared` write for the same step never replaces it. */
  write(receipt: ComputerStepReceipt): Promise<void>
}

/** The D1 surface the store uses. A real `D1Database` satisfies it. */
export interface ComputerStepReceiptD1Like {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>
      run(): Promise<unknown>
    }
  }
}

export const DEFAULT_COMPUTER_STEP_RECEIPT_TABLE = 'computer_step_receipts'

/** Paste into a product migration; the store never runs DDL. Times are epoch ms. */
export const COMPUTER_STEP_RECEIPT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DEFAULT_COMPUTER_STEP_RECEIPT_TABLE} (
  step_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  receipt TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${DEFAULT_COMPUTER_STEP_RECEIPT_TABLE}_by_age ON ${DEFAULT_COMPUTER_STEP_RECEIPT_TABLE} (updated_at)`

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const PRUNE_EVERY_WRITES = 64
const DEFAULT_RETENTION_MS = 30 * 24 * 3600_000

/** Receipts in one D1 table, shared by every isolate. Rows older than `retentionMs` (default 30 days) are pruned. */
export function createD1ComputerStepReceipts(db: ComputerStepReceiptD1Like, options: {
  table?: string; retentionMs?: number; now?: () => number
} = {}): ComputerStepReceipts {
  const table = options.table ?? DEFAULT_COMPUTER_STEP_RECEIPT_TABLE
  if (!SAFE_IDENTIFIER.test(table)) throw new Error(`Invalid computer step receipt table name: ${JSON.stringify(table)}`)
  const now = options.now ?? (() => Date.now())
  const readSql = `SELECT receipt FROM ${table} WHERE step_id = ?1`
  const writeSql = `INSERT INTO ${table} (step_id, state, receipt, updated_at) VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(step_id) DO UPDATE SET state = ?2, receipt = ?3, updated_at = ?4 WHERE ${table}.state <> 'settled'`
  const pruneSql = `DELETE FROM ${table} WHERE updated_at < ?1`
  let writes = 0
  return {
    async read(stepId) {
      const row = await db.prepare(readSql).bind(stepId).first<{ receipt: string }>()
      return row ? JSON.parse(row.receipt) as ComputerStepReceipt : null
    },
    async write(receipt) {
      await db.prepare(writeSql).bind(receipt.stepId, receipt.state, JSON.stringify(receipt), receipt.updatedAt).run()
      if (++writes % PRUNE_EVERY_WRITES === 0) await db.prepare(pruneSql).bind(now() - (options.retentionMs ?? DEFAULT_RETENTION_MS)).run()
    },
  }
}
