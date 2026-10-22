/**
 * The authenticated read of settled rows from the Tangle platform's
 * `/v1/billing/transactions` — `reconcileSpend`'s `rows` input and the budget
 * guard's `settledNanoUsd`.
 *
 * SCOPING. The narrowest scope this endpoint offers is a WALLET: `product` is
 * the platform's own service taxonomy, stamped on every charge from every
 * consumer app, so a wallet that runs two of our products returns both. Which
 * wallets to read, and with which key, is the product's decision; separating
 * one product's boxes from a sibling's inside one wallet is `ownership.ts`'s.
 * Rows therefore carry `keyId` through this boundary untouched — dropping it
 * would make every row `undecidable` and the ownership rule useless.
 *
 * BOUNDED. Unfiltered, a heavily used account's transaction history can carry
 * tens of thousands of rows. Every read is bounded by `dateFrom` and a hard
 * page cap that THROWS on hit — a loud truncation, never a silent undercount
 * that would blow a Worker's per-invocation subrequest budget while reading as
 * a clean pass.
 */
import { chargeNanoUsd, settlementSandboxId } from './reference'
import type { SettlementRow } from './types'

const TRANSACTIONS_PAGE_SIZE = 200

/** Hard stop at 25 pages (5,000 rows) per key per read. Hitting it throws. */
const MAX_TRANSACTION_PAGES = 25

const DAY_MS = 24 * 60 * 60 * 1000

/** The reconciliation pass runs daily; three days of lookback is ample margin
 *  over that cadence plus the platform's own settlement lag, without
 *  re-reading months of already-reconciled history on every run. */
export const SPEND_RECONCILE_LOOKBACK_MS = 3 * DAY_MS

/** The budget guard enforces a ROLLING cap, not a lifetime one. It runs on the
 *  provisioning path, where an unbounded read would risk the subrequest limit
 *  on an active account, and 30 days is generous for a cap meant to catch an
 *  ongoing leak rather than audit a workspace's full history. */
export const SPEND_BUDGET_LOOKBACK_MS = 30 * DAY_MS

interface PlatformTransactionItem {
  readonly id: string
  readonly amount: number
  readonly type: string
  readonly product: string | null
  readonly description: string | null
  readonly createdAt: string
  readonly referenceId?: string | null
  readonly groupKey?: string | null
  readonly costBasis?: number | null
  readonly keyId?: string | null
}

interface PlatformTransactionsResponse {
  readonly success: boolean
  readonly data: {
    readonly items: readonly PlatformTransactionItem[]
    readonly total: number
    readonly limit: number
    readonly offset: number
  }
}

/** Read the settled rows one platform API key can see. */
export interface FetchPlatformSettlementRowsInput {
  /** The platform origin, e.g. `https://id.tangle.tools`. Trailing slashes are ignored. */
  readonly platformUrl: string
  /** The wallet owner's own platform key — the only credential that can read its ledger. */
  readonly apiKey: string
  /** Earliest `createdAt` to read, epoch ms. */
  readonly dateFromMs: number
  /**
   * The platform's billing product, one per read: `credit_transactions.product`
   * spans router | sandbox | intelligence | blueprint-agent | evals | agent-builder.
   * Defaults to `sandbox`, the compute the reconciler bounds.
   *
   * Deliberately no `keyId` filter: the endpoint accepts one, but it drops rows
   * the platform left unattributed, and those are exactly the rows worth
   * seeing. Ownership is declared in the reconciler, where the exclusion is
   * reported, not hidden in a query string.
   */
  readonly product?: string
  readonly fetch?: typeof fetch
}

function toSettlementRow(item: PlatformTransactionItem): SettlementRow {
  return {
    id: item.id,
    // `sandbox:<kind>:<sandboxId>:<intervalStartMs>` — the ONLY place the
    // billed interval's start is recorded, and what `settlementSandboxId`
    // prefers over `groupKey`. Dropping it silently disables `over-ceiling`.
    referenceId: item.referenceId ?? null,
    // SIGNED exactly as the ledger stores it: negative is a charge, positive a
    // credit. Never abs() at this boundary — `chargeNanoUsd` gives the unsigned
    // magnitude and 0 for credits.
    amountNanoUsd: Math.round(item.amount * 1_000_000_000),
    type: item.type,
    product: item.product,
    groupKey: item.groupKey ?? null,
    createdAt: Date.parse(item.createdAt),
    description: item.description ?? null,
    costBasisNanoUsd: item.costBasis != null ? Math.round(item.costBasis * 1_000_000_000) : null,
    // This endpoint never returns a duration. `reconcileSpend` recovers one via
    // `reference-span` (the interval start embedded in `referenceId`); inventing
    // a value here would replace a bounded estimate with a guess.
    billedMs: null,
    // The API key the charge was created under: the only field that attributes
    // a row to a PRODUCT rather than to a wallet. `null` is a real answer
    // (legacy rows carry none) the ownership rule treats as undecidable, never
    // foreign.
    keyId: item.keyId ?? null,
  }
}

/**
 * Every settled row of one product the key's wallet holds since `dateFromMs`.
 * Throws on a non-2xx response or when the page cap is hit; a caller sweeping
 * several wallets catches per wallet so one bad credential never aborts the pass.
 */
export async function fetchPlatformSettlementRows(input: FetchPlatformSettlementRowsInput): Promise<SettlementRow[]> {
  const fetchImpl = input.fetch ?? fetch
  const base = input.platformUrl.replace(/\/+$/, '')
  const product = input.product ?? 'sandbox'
  const dateFrom = encodeURIComponent(new Date(input.dateFromMs).toISOString())
  const rows: SettlementRow[] = []
  let offset = 0
  for (let page = 0; ; page++) {
    if (page >= MAX_TRANSACTION_PAGES) {
      throw new Error(
        `platform billing transactions truncated at ${MAX_TRANSACTION_PAGES} pages (${offset} rows) — ` +
          "narrow the lookback window, or this owner's settlement volume needs its own investigation",
      )
    }
    const url =
      `${base}/v1/billing/transactions?product=${encodeURIComponent(product)}` +
      `&limit=${TRANSACTIONS_PAGE_SIZE}&offset=${offset}&dateFrom=${dateFrom}`
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${input.apiKey}` } })
    if (!res.ok) {
      throw new Error(`platform billing transactions fetch failed (${res.status}) at offset ${offset}`)
    }
    const result = (await res.json()) as PlatformTransactionsResponse
    for (const item of result.data.items) rows.push(toSettlementRow(item))
    offset += result.data.items.length
    if (result.data.items.length === 0 || offset >= result.data.total) break
  }
  return rows
}

/**
 * Unsigned charge of the rows whose sandbox is in `sandboxIds`.
 *
 * The budget cap is per WORKSPACE while the settlement feed is per WALLET, so a
 * row counts only when the product's own ledger attributes its box to this
 * workspace. The residue is excluded on purpose: an undercount lets one more
 * box through, an overcount refuses a box for someone else's spend.
 */
export function sandboxChargeNanoUsd(rows: readonly SettlementRow[], sandboxIds: ReadonlySet<string>): number {
  return rows.reduce((sum, row) => {
    const sandboxId = settlementSandboxId(row)
    return sandboxId && sandboxIds.has(sandboxId) ? sum + chargeNanoUsd(row) : sum
  }, 0)
}
