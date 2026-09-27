/**
 * Calibration — prove a gate can FAIL before believing that it PASSED, and
 * prove a probe can SEE before believing the zero it reported.
 *
 * Every expensive failure this package has shipped was a check that verified
 * its own input instead of the world, and reported green:
 *
 *   - `quote_verification 16/16` passed a work product whose nine citations
 *     claimed a figure the cited document never mentions.
 *   - `audit_form passed=3 failed=0` passed a form fill whose values landed in
 *     "Combat zone" — the audit re-read the field paths the writer had just
 *     invented, so a wrong path could not be wrong.
 *   - `evidence_coverage 0/0` passed vacuously because the artifact it was
 *     counting targets from was null.
 *   - A benchmark reported 6/8 for the product while a bare
 *     "You are a helpful assistant." scored 8/8 on the same cases.
 *
 * A gate is only evidence if it REJECTS something. A metric is only evidence
 * if a worse system scores worse on it. Neither property is implied by a
 * green run, and neither is visible in the output — which is why both have to
 * be asserted separately, in code, next to the gate.
 *
 * This module is deliberately domain-free: a "gate" is any predicate over any
 * input. Products supply the known-good and known-bad cases, because only the
 * product knows what bad looks like in its domain.
 */
/** A case whose verdict is known in advance, used to calibrate a gate. */
export interface CalibrationCase<TInput> {
    /** What this case represents, e.g. `'quote that does not occur in the source'`. */
    readonly label: string;
    readonly input: TInput;
    /** `'reject'` — the gate MUST refuse this. `'accept'` — it MUST allow it. */
    readonly expect: 'accept' | 'reject';
}
export interface CalibrationOutcome {
    readonly label: string;
    readonly expected: 'accept' | 'reject';
    readonly actual: 'accept' | 'reject';
    readonly ok: boolean;
    /** Set when the gate threw; a throw counts as `'reject'`. */
    readonly threw?: string;
}
export interface CalibrationReport {
    /** True only when every case matched AND both controls were present. */
    readonly discriminates: boolean;
    readonly outcomes: readonly CalibrationOutcome[];
    readonly failures: readonly CalibrationOutcome[];
    /** Why the gate is not trustworthy. Absent when `discriminates` is true. */
    readonly reason?: string;
}
/**
 * A gate under calibration. Returning `false` OR throwing both count as a
 * rejection — a fail-loud gate (`ToolInputError`) and a boolean gate calibrate
 * through the same path.
 */
export type GateFn<TInput> = (input: TInput) => boolean | Promise<boolean>;
/**
 * Run a gate against cases whose verdicts are known, and report whether it
 * actually discriminates.
 *
 * Requires BOTH controls:
 *   - at least one `'reject'` case — without it a gate that returns `true`
 *     unconditionally is indistinguishable from a working one. This is the
 *     control that all four failures above were missing.
 *   - at least one `'accept'` case — without it a gate that refuses everything
 *     scores perfectly, and an unsatisfiable gate does not stop bad work, it
 *     selects for invented work (measured: 38 fabricated citations written to
 *     clear a coverage gate no honest answer could satisfy).
 */
export declare function calibrateGate<TInput>(gate: GateFn<TInput>, cases: readonly CalibrationCase<TInput>[]): Promise<CalibrationReport>;
/**
 * `calibrateGate`, but throws instead of reporting. Use in a test or at wiring
 * time so an uncalibrated gate cannot ship silently.
 */
export declare function assertGateDiscriminates<TInput>(name: string, gate: GateFn<TInput>, cases: readonly CalibrationCase<TInput>[]): Promise<CalibrationReport>;
export interface ProbeReport<TValue> {
    /** True when the positive control registered something, so a zero is real. */
    readonly canSee: boolean;
    readonly measured: number;
    readonly control: number;
    readonly value: TValue;
    readonly reason?: string;
}
/**
 * Measure something, but only after proving the instrument can register a
 * non-zero — because an absence is a claim about the measurement first.
 *
 * Six blind probes were mistaken for real zeros in a single day: a SQL `LIKE`
 * over a column the product encrypts (which equally returned 0 for `"text"`
 * across every row — the tell), a `grep` run against worktrees on stale
 * branches, a status-code comparison that never read the response bodies, a
 * live event count taken from a run that was never dispatched, `rg --hidden`
 * silently exiting 2 because `rg` was aliased to `grep`, and an intercepted
 * `git show` returning an empty diff. Each nearly caused a wrong fix.
 *
 * `control` must count something that MUST exist. If it counts zero, the
 * measurement is unusable regardless of what `measure` returned.
 */
export declare function measureWithControl<TValue>(opts: {
    readonly measure: () => TValue | Promise<TValue>;
    /** Must return a value whose count is non-zero, or the probe is blind. */
    readonly control: () => TValue | Promise<TValue>;
    readonly count: (value: TValue) => number;
    /** Describes what the control counts, for the failure message. */
    readonly controlLabel: string;
}): Promise<ProbeReport<TValue>>;
