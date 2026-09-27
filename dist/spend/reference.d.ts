import type { SettlementReference, SettlementRow } from './types';
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
export declare function parseSettlementReference(referenceId: string | null | undefined): SettlementReference | null;
/**
 * Read the sandbox id out of the platform's aggregation key, `sandbox:<id>`.
 *
 * Distinct from the reference id: `groupKey` is the unit a billing statement
 * groups by and is deliberately NOT unique per row, while `referenceId` is
 * unique per interval. A null group key means "do not aggregate" (grants,
 * top-ups, refunds, transfers) and is not an error.
 */
export declare function parseSandboxGroupKey(groupKey: string | null | undefined): string | null;
/**
 * The sandbox a settlement row is attributable to.
 *
 * The reference id wins over the group key because it is the field the platform
 * dedups on, so it is the one guaranteed present and correct on a compute
 * settlement; the group key is the fallback for rows written before a producer
 * stamped a reference, and for kinds whose reference names something else (a GPU
 * lease id, not a box).
 */
export declare function settlementSandboxId(row: SettlementRow): string | null;
/** True when a row is a charge (the ledger stores charges as negative amounts). */
export declare function isCharge(row: SettlementRow): boolean;
/** A charge's magnitude in unsigned nanodollars; 0 for credits. */
export declare function chargeNanoUsd(row: SettlementRow): number;
