import type { SpendLedger } from './store'

/** Why provisioning was refused, with every number the decision used. */
export interface ComputeBudgetRefusal {
  readonly workspaceId: string
  /** The cap, unsigned nanodollars. */
  readonly limitNanoUsd: number
  /** Cumulative settled compute spend for this workspace, unsigned nanodollars. */
  readonly settledNanoUsd: number
  /** How far past the cap it already is. */
  readonly overageNanoUsd: number
  readonly at: number
}

/**
 * Provisioning refused because the workspace is already past its compute cap.
 *
 * Correctable by design: every number the decision used is on the error, so a
 * product can render "this workspace has spent $X of its $Y compute budget" and
 * an operator can raise the cap or investigate without reading logs.
 *
 * This is the failure mode the module exists to produce. A platform billing
 * defect that used to end in a silent negative balance now ends in provisioning
 * stopping and something loud happening instead.
 */
export class ComputeBudgetExceededError extends Error {
  readonly workspaceId: string
  readonly limitNanoUsd: number
  readonly settledNanoUsd: number
  readonly overageNanoUsd: number

  constructor(refusal: ComputeBudgetRefusal) {
    super(
      `Compute budget exceeded for workspace ${refusal.workspaceId}: ` +
        `$${(refusal.settledNanoUsd / 1_000_000_000).toFixed(2)} settled against a cap of ` +
        `$${(refusal.limitNanoUsd / 1_000_000_000).toFixed(2)} ` +
        `(over by $${(refusal.overageNanoUsd / 1_000_000_000).toFixed(2)}). ` +
        'No sandbox was provisioned. Raise the cap or reconcile the spend before retrying.',
    )
    this.name = 'ComputeBudgetExceededError'
    this.workspaceId = refusal.workspaceId
    this.limitNanoUsd = refusal.limitNanoUsd
    this.settledNanoUsd = refusal.settledNanoUsd
    this.overageNanoUsd = refusal.overageNanoUsd
  }
}

/**
 * A per-workspace cap on sandbox compute.
 *
 * `/billing`'s budget primitive caps MODEL keys, and it works because the
 * platform enforces the cap at the key it minted. Sandbox compute has no such
 * key: a box bills the shared company wallet, so nothing upstream refuses. This
 * carries the same shape to the one place a consumer can still act — the moment
 * before it asks for another box.
 *
 * `settledNanoUsd` is a callback rather than a number because the authority is
 * the platform ledger, not this package: the product reads the same rows it
 * hands the reconciler. Cache it if the read is expensive; a cap is a
 * coarse-grained control and a slightly stale total still refuses.
 */
export interface ComputeBudget {
  /** The cap, unsigned nanodollars. */
  readonly limitNanoUsd: number
  /** Cumulative settled compute spend for the workspace, unsigned nanodollars. */
  readonly settledNanoUsd: (workspaceId: string) => Promise<number> | number
  /**
   * Called on every refusal, before the error is thrown. This is the alert
   * seam: a refusal nobody hears is a product that silently stopped working.
   */
  readonly onRefusal?: (refusal: ComputeBudgetRefusal) => void
  /** Injectable clock (epoch ms). Default `Date.now`. */
  readonly now?: () => number
}

/**
 * Throw {@link ComputeBudgetExceededError} when the workspace is already past
 * its cap. Returns normally — and reads nothing — when no budget is configured.
 *
 * Deliberately a pre-check against spend ALREADY SETTLED, not a reservation
 * against spend about to happen: settlement lags provisioning by design (the
 * platform's durable settlement queue), so there is no instant at which a
 * consumer could hold an accurate running total. The cap therefore overshoots by
 * at most the unsettled tail, which is bounded by the box's own idle timeout.
 * A cap that refuses one box late is worth far more than one that cannot be
 * implemented honestly.
 */
export async function assertComputeBudget(
  budget: ComputeBudget | undefined,
  workspaceId: string,
): Promise<void> {
  if (!budget) return
  const settledNanoUsd = await budget.settledNanoUsd(workspaceId)
  if (settledNanoUsd < budget.limitNanoUsd) return

  const refusal: ComputeBudgetRefusal = {
    workspaceId,
    limitNanoUsd: budget.limitNanoUsd,
    settledNanoUsd,
    overageNanoUsd: settledNanoUsd - budget.limitNanoUsd,
    at: (budget.now ?? Date.now)(),
  }
  budget.onRefusal?.(refusal)
  throw new ComputeBudgetExceededError(refusal)
}

// ── the /sandbox seam ─────────────────────────────────────────────────────────

/**
 * What `/sandbox` reports once a box is provisioned, reused or resumed.
 *
 * Structurally identical to `SandboxProvisionedObservation` in `/sandbox`, and
 * deliberately re-declared rather than imported: `/spend` composes `/sandbox`,
 * so a type import in the other direction would invert the dependency. The two
 * are pinned together by a compile-time assignment in this module's tests.
 */
export interface SandboxProvisionObservation {
  readonly workspaceId: string
  readonly userId?: string
  readonly sandboxId: string
  readonly boxKey?: string | undefined
  readonly idleTimeoutSeconds: number
  readonly maxLifetimeSeconds?: number | undefined
  readonly at: number
}

/** The optional seam `EnsureWorkspaceSandboxOptions.spend` accepts. */
export interface SandboxSpendSeam {
  beforeProvision?(input: { workspaceId: string; userId?: string }): Promise<void> | void
  onProvisioned?(observation: SandboxProvisionObservation): Promise<void> | void
}

export interface SandboxSpendHooksOptions {
  /** Records box lifecycle. Omit to run the budget guard alone. */
  readonly ledger?: SpendLedger
  /** Refuses provisioning past a cap. Omit to record alone. */
  readonly budget?: ComputeBudget
  /**
   * Called when RECORDING fails. Recording is best-effort — a bookkeeping
   * failure must never take down the provisioning it is bookkeeping — so this
   * is the only place such a failure is visible. A refusal is NOT routed here;
   * refusals throw, by design.
   */
  readonly onError?: (error: unknown) => void
}

/**
 * Build the object to hand `ensureWorkspaceSandbox`'s `spend` option.
 *
 * Wiring it is the entire adoption cost: one field, and the product's boxes are
 * both budget-capped and recorded.
 */
export function createSandboxSpendHooks(options: SandboxSpendHooksOptions): SandboxSpendSeam {
  const { ledger, budget, onError } = options
  return {
    async beforeProvision(input) {
      await assertComputeBudget(budget, input.workspaceId)
    },
    async onProvisioned(observation) {
      if (!ledger) return
      try {
        await ledger.observeSandbox({
          sandboxId: observation.sandboxId,
          workspaceId: observation.workspaceId,
          idleTimeoutSeconds: observation.idleTimeoutSeconds,
          maxLifetimeSeconds: observation.maxLifetimeSeconds ?? null,
          at: observation.at,
        })
      } catch (err) {
        onError?.(err)
      }
    },
  }
}
