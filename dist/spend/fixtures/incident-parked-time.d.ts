/**
 * The 2026-08-05 parked-time settlement incident, as a fixture.
 *
 * A gate calibrated only against invented data proves nothing about the failure
 * it was built for, so this reconstructs the real one. What comes from the
 * receipts on agent-dev-container#4422 and its runbook, and what is
 * reconstructed, is marked per field below — because a fixture that quietly
 * blends the two is how a calibration stops meaning anything.
 *
 * MEASURED (from the incident receipts):
 *   - The reporter's refund totalled $514.161090533, one of eight wallets
 *     refunded for a combined $614.31.
 *   - 23 settlements, interval starts in July, durations 124–268 h, all settled
 *     inside one burst in the 02:40–04:00 UTC window on 2026-08-05.
 *   - Two sub-cent rows in the same window were GENUINE short intervals and
 *     were deliberately not refunded.
 *   - The ledger reference id is `sandbox:stop:<sandboxId>:<intervalStart>`
 *     with the interval start in epoch ms; amounts are signed nanodollars,
 *     negative for a charge; the group key is `sandbox:<sandboxId>`.
 *   - Both shipped products run `idleTimeoutSeconds: 3600` and
 *     `maxLifetimeSeconds: 86400`.
 *
 * RECONSTRUCTED (the per-row split is not published in the issue):
 *   - How the 23 durations distribute inside 124–268 h — spread linearly.
 *   - The implied price, derived so the 23 amounts sum to the refunded total to
 *     the nanodollar ($0.114055/h for the 2 vCPU / 4 GB box both products run).
 *   - The fourteen ordinary days of prior spend, which the receipts do not
 *     enumerate but which the velocity rule needs in order to have a trailing
 *     median at all.
 *
 * One published figure is NOT reproduced here: the brief's aggregate of ~10 718
 * billed hours cannot be reconciled with 23 rows of 124–268 h, whose arithmetic
 * maximum is 6 164 h. The per-row bounds are the more specific claim and are
 * what this uses; the aggregate may span more rows or more wallets than the
 * reporter's 23. Nothing in the calibration depends on it.
 */
import type { SettlementRow, SpendBoxRecord } from '../types';
/** The reporter's refund, to the nanodollar. */
export declare const REPORTER_REFUND_NANO_USD = 514161090533;
export interface IncidentFixture {
    /** Every settled row an operator's fetch would return, oldest first. */
    readonly rows: readonly SettlementRow[];
    /** The expectation ledger a product that had adopted `/spend` would hold. */
    readonly records: readonly SpendBoxRecord[];
    /** The 23 over-billed boxes. */
    readonly incidentSandboxIds: readonly string[];
    /** The two boxes whose short intervals in the same window were genuine. */
    readonly genuineSandboxIds: readonly string[];
    readonly asOf: number;
}
/**
 * Build the incident. Deterministic — no clock, no randomness — so the
 * calibration test asserts exact numbers rather than ranges.
 */
export declare function incidentFixture(): IncidentFixture;
