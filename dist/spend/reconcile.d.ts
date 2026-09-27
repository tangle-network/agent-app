import type { SpendLedgerStorePort } from './store';
import { type SettlementRow, type SpendBoxRecord, type SpendCheckId, type SpendOwnershipRule, type SpendReport, type SpendWindow } from './types';
export interface VelocityOptions {
    /** Bucket width for a spend window, ms. Default 24 h. */
    readonly windowMs?: number;
    /** Fire when a window exceeds this multiple of the trailing median. Default 5. */
    readonly multiple?: number;
    /**
     * Windows of history required before a median means anything. Default 3.
     * Below this the rule stays silent, so a product's genuine first days of
     * usage are not reported as an anomaly.
     */
    readonly minTrailingWindows?: number;
    /**
     * A window under this never fires, whatever the ratio. Default $1.00.
     *
     * Without a floor the rule is useless: a trailing median of a tenth of a cent
     * makes every ordinary day a 5x outlier. $1.00 is set from the incident's own
     * distribution — the smallest of the eight affected wallets took $1.98, and
     * the two rows in the same window that were GENUINE were sub-cent. So the
     * floor sits above the noise and below every real finding.
     */
    readonly minAbsoluteNanoUsd?: number;
}
/** The balance the product observes, and the floor it must not cross. */
export interface ObservedBalance {
    /** Signed nanodollars, as the platform reports it. */
    readonly nanoUsd: number;
    /** Below this is a finding. Default 0. */
    readonly floorNanoUsd?: number;
}
/**
 * A box's price, nanodollars per hour, used to derive an EXACT billed duration
 * from a charge. Return null when the product does not know the box's rate; the
 * reconciler then falls back to the reference span.
 */
export type BoxRateResolver = (record: SpendBoxRecord | null, sandboxId: string) => number | null | undefined;
export interface ReconcileSpendOptions {
    /**
     * Settled ledger rows, supplied by the product's own authenticated fetch.
     *
     * The fetch can only scope to a WALLET — `product: 'sandbox'` is the
     * platform's service taxonomy, not this product's — so on an account running
     * more than one of our products these rows carry the siblings' boxes too.
     * {@link ReconcileSpendOptions.ownership} is what separates them.
     */
    readonly rows: readonly SettlementRow[];
    /** The product's expectation ledger. */
    readonly store: SpendLedgerStorePort;
    /**
     * Which of those rows are THIS product's — see {@link SpendOwnershipRule} and
     * the shipped `ownedByBillingKeys`.
     *
     * Omitting it is safe and changes nothing: the pass claims every box, which is
     * the behaviour that shipped, and the direction that over-reports rather than
     * under-reports. It is not silent about it — `report.ownership.declared` is
     * `false`, `formatSpendReport` says so above the findings, and every
     * `unknown-box` finding states on its face that a sibling product's box is
     * indistinguishable from a charge that is not ours.
     *
     * Declaring it never weakens the ledger-backed checks: ownership is consulted
     * ONLY for boxes with no expectation record, so `over-ceiling` on a recorded
     * box fires whatever the rule says.
     */
    readonly ownership?: SpendOwnershipRule;
    /** Treated as "now". Default `Date.now()`. */
    readonly asOf?: number;
    /** Ceiling slack. Default {@link DEFAULT_CEILING_TOLERANCE_MS}. */
    readonly toleranceMs?: number;
    /** Box price, for the exact duration basis. A number applies to every box. */
    readonly nanoUsdPerHour?: number | BoxRateResolver;
    /** Velocity tuning, or `false` to skip the rule. */
    readonly velocity?: VelocityOptions | false;
    /** The workspace balance, when the product can see one. Omitted skips the rule. */
    readonly balance?: ObservedBalance;
    /** Stamped onto findings so an alert names the tenant. */
    readonly workspaceId?: string;
    /** Checks to leave out of this pass. */
    readonly skip?: readonly SpendCheckId[];
    /**
     * The stretch of time these `rows` were fetched for.
     *
     * Declaring it — together with a store that implements `listLiveBetween` — is
     * what lets the pass answer the direction every settlement-driven rule is
     * blind to: *were we NOT billed for something we DID ask for*. The expectation
     * ledger already holds the answer; nothing new is stored for it.
     *
     * Omitting it is additive and changes no existing finding. It is not silent:
     * `report.expectation.declared` is `false`, `formatSpendReport` prints
     * `expectation: NOT DECLARED` above the findings, and a pass that also
     * examined none of this product's settlements reports `coverage: 'unverified'`
     * and cannot render as a clean bill.
     */
    readonly window?: SpendWindow;
    /**
     * Live ms a box needs inside the window before a settlement is EXPECTED of it.
     * Default {@link DEFAULT_EXPECTATION_GRACE_MS} (15 min — the platform's own
     * declared-normal settlement lag). Shrink it for a short window.
     */
    readonly expectationGraceMs?: number;
}
/**
 * Diff what the platform charged against what the product believes it asked for.
 *
 * Never disputes anything and never writes: the output is a report a human acts
 * on. The platform's ledger stays authoritative — this only ever produces the
 * evidence for a conversation with it.
 */
export declare function reconcileSpend(options: ReconcileSpendOptions): Promise<SpendReport>;
