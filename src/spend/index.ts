/**
 * Consumer-side spend verification: the product's own record of what it asked
 * the platform for, diffed against what the platform charged.
 *
 * Three parts, in the order a product adopts them:
 *
 * 1. **Expectation ledger** (`store.ts`) — a storage-port-parameterized record
 *    of box lifecycle, and the upper bound on billable time it implies
 *    (`ceiling.ts`).
 * 2. **Reconciler** (`reconcile.ts`) — settled ledger rows against that record,
 *    producing typed findings a human disputes.
 * 3. **Budget guard** (`budget.ts`) — a per-workspace compute cap enforced at
 *    the one moment a consumer still can: before asking for another box.
 *
 * What this is NOT: a way for a product to certify its own charges. The
 * platform's ledger stays authoritative. This produces evidence for a dispute
 * and an alert when the numbers stop agreeing — nothing here writes to a ledger,
 * refunds anything, or suppresses a charge.
 *
 * The threat model, the exact limits of what the ceiling can bound, and the
 * adoption seams for tax-agent and legal-agent are in
 * [`docs/spend-verification.md`](../../docs/spend-verification.md).
 */

export {
  SPEND_CHECKS,
  type BilledDurationBasis,
  type CeilingBasis,
  type ExpectedCeiling,
  type SettlementReference,
  type SettlementRow,
  type SpendBoxPatch,
  type SpendBoxRecord,
  type SpendCheckId,
  type SpendFinding,
  type SpendReport,
} from './types'

export {
  createInMemorySpendLedgerStore,
  createSpendLedger,
  foldSpendBoxRecord,
  type InMemorySpendLedgerStore,
  type ObserveSandboxInput,
  type SpendLedger,
  type SpendLedgerOptions,
  type SpendLedgerStorePort,
} from './store'

export {
  DEFAULT_CEILING_TOLERANCE_MS,
  computeExpectedCeiling,
  type ComputeExpectedCeilingOptions,
} from './ceiling'

export {
  chargeNanoUsd,
  isCharge,
  parseSandboxGroupKey,
  parseSettlementReference,
  settlementSandboxId,
} from './reference'

export {
  reconcileSpend,
  type BoxRateResolver,
  type ObservedBalance,
  type ReconcileSpendOptions,
  type VelocityOptions,
} from './reconcile'

export {
  ComputeBudgetExceededError,
  assertComputeBudget,
  createSandboxSpendHooks,
  type ComputeBudget,
  type ComputeBudgetRefusal,
  type SandboxProvisionObservation,
  type SandboxSpendHooksOptions,
  type SandboxSpendSeam,
} from './budget'

export { formatSpendReport, spendReportToJson } from './report'
