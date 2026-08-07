import type {
  SettlementRow,
  SpendOwnershipRule,
  SpendOwnershipVerdict,
} from './types'

/**
 * Which settlements belong to the product running the reconciliation.
 *
 * ## The problem this module is the answer to
 *
 * A product fetches its settled rows from `/v1/billing/transactions`, scoped to
 * the BILLING OWNER — the wallet whose key paid. `product: 'sandbox'` narrows
 * that to compute, but `sandbox` is the PLATFORM's service taxonomy: every
 * consumer app's box compute wears it. So a Tangle account running two of our
 * products hands each product's reconciliation the other product's boxes, and
 * `unknown-box` — correctly, by its own rule — reports one finding per sibling
 * box. Two products on one wallet make each other's spend check useless.
 *
 * ## Why the obvious fix is the wrong fix
 *
 * The obvious fix is to reconcile only the boxes already in the product's
 * expectation ledger. That removes the false findings and removes the check:
 * `unknown-box` exists to catch "we were billed for a box we never asked for",
 * which is the 2026-08-05 incident's day-one signature and the ONLY thing a
 * product with no lifecycle bookkeeping can catch at all. Filtering to the
 * ledger makes a phantom charge unrepresentable — the ledger's own contents
 * would define the answer.
 *
 * So the residue — settlements against boxes with no ledger record — has to be
 * SPLIT, not dropped. A sibling's box and a phantom charge are indistinguishable
 * unless something outside the product's own bookkeeping tells them apart.
 *
 * ## What can tell them apart
 *
 * Exactly one field on a settlement row, and it is not the sandbox id. The
 * platform mints that id as `sandbox-<12 hex>` — a hash of (owner, idempotency
 * key) — so a product's own box naming never reaches the ledger row, and the
 * charge's `description` carries only the resource spec. What does survive is
 * `credit_transactions.key_id`: the platform API key the box was created under,
 * stamped from the box's own creation metadata at settlement and filterable on
 * the transactions endpoint. Each product deploys with its own key, so the key
 * is the product's billing identity as the PLATFORM recorded it — not as the
 * product asserts it after the fact.
 *
 * That asymmetry is what makes the split safe. A product cannot widen its own
 * claim by claiming; it can only recognise a stamp the platform already wrote.
 *
 * ## The three rules that keep the detection intact
 *
 * 1. **A recorded box is never excluded.** Ownership is consulted only for
 *    boxes with no ledger record. A rule that is wrong or over-narrow therefore
 *    cannot hide an `over-ceiling` finding on a box the product recorded — the
 *    incident's own 23 findings survive any rule at all.
 * 2. **Undecidable fails closed.** A row with no key attribution is `mine`, so
 *    an unattributable charge on a shared wallet is reported. Silence is never
 *    the answer to "I don't know."
 * 3. **A box is claimed if ANY of its rows claims it.** The fold is
 *    `mine > undecidable > foreign`, which is the module's standing asymmetry:
 *    every derivation error pushes toward a false alarm, never toward a missed
 *    charge.
 */

/**
 * Claim every settlement the platform stamped with one of these API keys.
 *
 * The shipped rule, because it is the only one built on a field the PLATFORM
 * writes. Give each product its own platform key and this separates them
 * exactly; give two products the same key and no consumer-side rule can tell
 * them apart, because after settlement there is nothing left that differs — the
 * fix then is a second key, not a cleverer predicate.
 *
 * A row with no `keyId` (a legacy row, or an export that drops the column) is
 * `undecidable`, never `foreign`: the absence of an attribution is not evidence
 * that the charge is someone else's.
 *
 * @param keyIds The product's own platform API key ids. Must be non-empty — a
 *   rule that owns nothing would classify every settlement as another product's
 *   and report a clean bill for an account nobody is checking.
 */
export function ownedByBillingKeys(keyIds: readonly string[]): SpendOwnershipRule {
  const owned = new Set(keyIds.map((id) => id.trim()).filter(Boolean))
  if (owned.size === 0) {
    throw new Error(
      'ownedByBillingKeys needs at least one key id: a rule that owns no key classifies every ' +
        'settlement as another product\'s and reports a clean bill for an unchecked account.',
    )
  }
  const label = `billing key ${[...owned].join(', ')}`
  return {
    label,
    decide({ row }) {
      const keyId = row.keyId?.trim()
      if (!keyId) return 'undecidable'
      return owned.has(keyId) ? 'mine' : 'foreign'
    },
  }
}

/**
 * One box's verdict, folded over every row that settled against it.
 *
 * `mine` wins over `undecidable`, which wins over `foreign`: it takes one row
 * attributable to this product to make the box this product's problem, and one
 * unattributable row to stop the box being excluded. Both directions push
 * toward reporting, which is the only direction that cannot lose money.
 *
 * Exported because a product auditing its own scoping wants the same answer the
 * reconciler reached, not a re-derivation of it.
 */
export function decideBoxOwnership(
  rule: SpendOwnershipRule,
  sandboxId: string,
  rows: readonly SettlementRow[],
): SpendOwnershipVerdict {
  let verdict: SpendOwnershipVerdict = 'foreign'
  for (const row of rows) {
    const rowVerdict = rule.decide({ row, sandboxId })
    if (rowVerdict === 'mine') return 'mine'
    if (rowVerdict === 'undecidable') verdict = 'undecidable'
  }
  return verdict
}
