import type { SpendBoxPatch, SpendBoxRecord } from './types'

/**
 * Persistence seam for the expectation ledger — the product implements it over
 * its own tables.
 *
 * Deliberately NOT compare-and-set, unlike `MissionStorePort`. A mission has one
 * serialized owner and a lost write corrupts a state machine; a box record is a
 * MONOTONIC FOLD (activity takes a max, a detached-run id joins or leaves a set,
 * delete is set-once) so concurrent writers converge no matter what order they
 * land in. The worst a lost race can do here is leave `lastActivityAt` behind
 * the truth — which makes the derived ceiling TIGHTER, so the failure mode is a
 * false alarm a human dismisses, never a missed charge. That asymmetry is the
 * whole reason the fold is shaped this way.
 *
 * `update` returns null when the row does not exist, never a throw.
 */
export interface SpendLedgerStorePort {
  load(sandboxId: string): Promise<SpendBoxRecord | null>
  /** `extras` are the opaque product-column values — write them in the SAME
   *  statement as the record, or ignore them if the table has no extra columns. */
  insert(record: SpendBoxRecord, extras?: Record<string, unknown>): Promise<SpendBoxRecord>
  update(sandboxId: string, patch: SpendBoxPatch): Promise<SpendBoxRecord | null>
}

/**
 * Apply one fold step. Exported so a SQL implementation and an in-memory one
 * reach the same record, and so a product can unit-test its own store against
 * the canonical answer.
 *
 * The two rules worth stating out loud:
 *
 * - `observedActivityAt` only ever moves `lastActivityAt` FORWARD. A replayed
 *   or out-of-order event cannot rewind the ceiling.
 * - activity later than a recorded `stoppedAt` CLEARS the stop. A box that
 *   worked after the product thought it stopped is running again, and keeping
 *   the stale stop would make the ceiling too tight — inventing an over-ceiling
 *   finding out of the product's own bookkeeping rather than the platform's.
 */
export function foldSpendBoxRecord(record: SpendBoxRecord, patch: SpendBoxPatch): SpendBoxRecord {
  let lastActivityAt = record.lastActivityAt
  let stoppedAt = record.stoppedAt
  let openDetachedRunIds = record.openDetachedRunIds

  if (patch.observedActivityAt !== undefined) {
    lastActivityAt = Math.max(lastActivityAt, patch.observedActivityAt)
    if (stoppedAt !== null && patch.observedActivityAt > stoppedAt) stoppedAt = null
  }
  if (patch.openDetachedRunAdd !== undefined && !openDetachedRunIds.includes(patch.openDetachedRunAdd)) {
    openDetachedRunIds = [...openDetachedRunIds, patch.openDetachedRunAdd]
  }
  if (patch.openDetachedRunRemove !== undefined) {
    openDetachedRunIds = openDetachedRunIds.filter((id) => id !== patch.openDetachedRunRemove)
  }
  if (patch.stoppedAt !== undefined) {
    // Latest-wins, but never behind observed activity: a stop we are told about
    // that predates work we watched is not the stop that closed this box.
    stoppedAt = patch.stoppedAt >= lastActivityAt ? patch.stoppedAt : stoppedAt
  }

  return {
    ...record,
    lastActivityAt,
    stoppedAt,
    openDetachedRunIds,
    // Set-once: a deleted sandbox id never comes back, so a second observation
    // is a duplicate delivery, not a second deletion.
    deletedAt: record.deletedAt ?? patch.deletedAt ?? null,
  }
}

/** An in-memory store that also lets a test inspect and force state. */
export interface InMemorySpendLedgerStore extends SpendLedgerStorePort {
  /** Every record, insertion order. */
  records(): SpendBoxRecord[]
  /** Unguarded direct write — simulates a crash-shaped or platform-seeded row. */
  put(record: SpendBoxRecord): void
}

/** Create an in-memory expectation ledger. Production writers use the same port. */
export function createInMemorySpendLedgerStore(): InMemorySpendLedgerStore {
  const rows = new Map<string, SpendBoxRecord>()
  return {
    async load(sandboxId) {
      const row = rows.get(sandboxId)
      return row ? structuredClone(row) : null
    },
    async insert(record) {
      const stored = structuredClone(record)
      rows.set(record.sandboxId, stored)
      return structuredClone(stored)
    },
    async update(sandboxId, patch) {
      const current = rows.get(sandboxId)
      if (!current) return null
      const next = foldSpendBoxRecord(current, patch)
      rows.set(sandboxId, next)
      return structuredClone(next)
    },
    records() {
      return [...rows.values()].map((row) => structuredClone(row))
    },
    put(record) {
      rows.set(record.sandboxId, structuredClone(record))
    },
  }
}

/** What the product tells the ledger when it first sees a box. */
export interface ObserveSandboxInput {
  readonly sandboxId: string
  readonly workspaceId: string
  /** The idle timeout the product asked the platform for, seconds. */
  readonly idleTimeoutSeconds: number
  /** The max lifetime the product asked for, seconds, when it asked for one. */
  readonly maxLifetimeSeconds?: number | null
  /** Defaults to the ledger's clock. */
  readonly at?: number
}

export interface SpendLedgerOptions {
  readonly store: SpendLedgerStorePort
  /** Injectable clock (epoch ms). Default `Date.now`. */
  readonly now?: () => number
  /** Product columns written verbatim on every insert. */
  readonly extras?: Record<string, unknown>
}

/**
 * The recording half of spend verification: the product's own account of what
 * it asked the platform for.
 *
 * Every method is best-effort from the caller's point of view — a product wires
 * these into paths that must not fail because bookkeeping failed. They still
 * reject on a store error rather than swallowing it, so a caller that wants
 * fire-and-forget says so at the call site (`/sandbox`'s hook does).
 */
export interface SpendLedger {
  /**
   * Record that a box exists and is billable from now. Inserts on first sight,
   * and otherwise records activity — reuse and resume are both "the platform is
   * charging for this box again", and the record's own existence is what
   * distinguishes them, so no caller has to know which happened.
   */
  observeSandbox(input: ObserveSandboxInput): Promise<SpendBoxRecord>
  /** Record that the product saw this box do work. */
  recordActivity(sandboxId: string, at?: number): Promise<SpendBoxRecord | null>
  /**
   * Record that the product handed the platform work it will NOT watch finish.
   * Until the matching end is recorded, this box's ceiling cannot rest on
   * observed activity — see `computeExpectedCeiling`.
   */
  recordDetachedRunStarted(sandboxId: string, runId: string, at?: number): Promise<SpendBoxRecord | null>
  /** Record that a detached run was confirmed finished. */
  recordDetachedRunEnded(sandboxId: string, runId: string, at?: number): Promise<SpendBoxRecord | null>
  /** Record that the product knows this box stopped. */
  recordStopped(sandboxId: string, at?: number): Promise<SpendBoxRecord | null>
  /** Record that the product knows this box was deleted. */
  recordDeleted(sandboxId: string, at?: number): Promise<SpendBoxRecord | null>
}

/** Create the recording half over a product-supplied store. */
export function createSpendLedger(options: SpendLedgerOptions): SpendLedger {
  const { store } = options
  const clock = options.now ?? Date.now

  return {
    async observeSandbox(input) {
      const at = input.at ?? clock()
      const existing = await store.load(input.sandboxId)
      if (existing) {
        const updated = await store.update(input.sandboxId, { observedActivityAt: at })
        return updated ?? existing
      }
      return await store.insert(
        {
          sandboxId: input.sandboxId,
          workspaceId: input.workspaceId,
          createdAt: at,
          idleTimeoutSeconds: input.idleTimeoutSeconds,
          maxLifetimeSeconds: input.maxLifetimeSeconds ?? null,
          lastActivityAt: at,
          openDetachedRunIds: [],
          stoppedAt: null,
          deletedAt: null,
        },
        options.extras,
      )
    },
    async recordActivity(sandboxId, at) {
      return await store.update(sandboxId, { observedActivityAt: at ?? clock() })
    },
    async recordDetachedRunStarted(sandboxId, runId, at) {
      return await store.update(sandboxId, {
        observedActivityAt: at ?? clock(),
        openDetachedRunAdd: runId,
      })
    },
    async recordDetachedRunEnded(sandboxId, runId, at) {
      return await store.update(sandboxId, {
        observedActivityAt: at ?? clock(),
        openDetachedRunRemove: runId,
      })
    },
    async recordStopped(sandboxId, at) {
      return await store.update(sandboxId, { stoppedAt: at ?? clock() })
    },
    async recordDeleted(sandboxId, at) {
      return await store.update(sandboxId, { deletedAt: at ?? clock() })
    },
  }
}
