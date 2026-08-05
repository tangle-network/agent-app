import type { SettlementReference, SettlementRow } from './types'

/**
 * Parse the platform's settlement idempotency key.
 *
 * The platform mints it as `sandbox:<kind>:<resourceId>:<intervalStart>`
 * (`d1-usage-service.ts`), where `intervalStart` is the interval cursor in epoch
 * ms — the SAME `last_started_at` the settlement subtracts from to get its
 * billed duration. That makes this string the only place a consumer can read the
 * billed interval's start, because the ledger row itself stores no duration.
 *
 * Kinds seen in production: `stop` (an interval closing), `compute` (a heartbeat
 * claim), `egress`, `gpu-lease`. `stop` deliberately covers both a settle and a
 * late stop racing over the same claim, so the two derive one reference id and
 * the ledger's uniqueness constraint makes the overlap safe.
 *
 * Returns null for anything that is not a sandbox reference — a router
 * inference row, a grant, a refund — rather than guessing.
 */
export function parseSettlementReference(referenceId: string | null | undefined): SettlementReference | null {
  if (!referenceId) return null
  const parts = referenceId.split(':')
  if (parts.length < 3 || parts[0] !== 'sandbox') return null
  const kind = parts[1]
  if (!kind) return null

  // The trailing segment is the interval cursor ONLY when it reads as an epoch
  // instant. `sandbox:gpu-lease:<leaseId>` has no cursor, and a resource id that
  // happened to contain a colon must not have its tail eaten as one.
  const tail = parts[parts.length - 1] as string
  const tailMs = /^\d+$/.test(tail) ? Number(tail) : Number.NaN
  const hasCursor = parts.length >= 4 && Number.isSafeInteger(tailMs) && tailMs > 0

  const resourceId = hasCursor ? parts.slice(2, -1).join(':') : parts.slice(2).join(':')
  if (!resourceId) return null

  return { kind, resourceId, intervalStartMs: hasCursor ? tailMs : null }
}

/**
 * Read the sandbox id out of the platform's aggregation key, `sandbox:<id>`.
 *
 * Distinct from the reference id: `groupKey` is the unit a billing statement
 * groups by and is deliberately NOT unique per row, while `referenceId` is
 * unique per interval. A null group key means "do not aggregate" (grants,
 * top-ups, refunds, transfers) and is not an error.
 */
export function parseSandboxGroupKey(groupKey: string | null | undefined): string | null {
  if (!groupKey) return null
  const parts = groupKey.split(':')
  if (parts.length < 2 || parts[0] !== 'sandbox') return null
  const id = parts.slice(1).join(':')
  return id || null
}

/**
 * The sandbox a settlement row is attributable to.
 *
 * The reference id wins over the group key because it is the field the platform
 * dedups on, so it is the one guaranteed present and correct on a compute
 * settlement; the group key is the fallback for rows written before a producer
 * stamped a reference, and for kinds whose reference names something else (a GPU
 * lease id, not a box).
 */
export function settlementSandboxId(row: SettlementRow): string | null {
  const reference = parseSettlementReference(row.referenceId)
  if (reference && reference.intervalStartMs !== null) return reference.resourceId
  return parseSandboxGroupKey(row.groupKey) ?? (reference ? reference.resourceId : null)
}

/** True when a row is a charge (the ledger stores charges as negative amounts). */
export function isCharge(row: SettlementRow): boolean {
  return row.amountNanoUsd < 0
}

/** A charge's magnitude in unsigned nanodollars; 0 for credits. */
export function chargeNanoUsd(row: SettlementRow): number {
  return row.amountNanoUsd < 0 ? -row.amountNanoUsd : 0
}
