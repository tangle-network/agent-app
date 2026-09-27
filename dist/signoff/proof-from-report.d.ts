/**
 * The join between the runner and the proof: one sign-off run produces one
 * report, and this turns that report into the signed, attachable record.
 *
 * Nothing here re-runs or re-judges anything. The runner owns what happened; the
 * proof owns what is provable about it later. Keeping the two in one direction
 * is what stops a second, drifting idea of "which steps ran" from appearing.
 */
import { type SignoffProof } from './proof-record';
import type { SignoffReport } from './types';
export interface ProofFromReportInput {
    readonly report: SignoffReport;
    /** Repo identity the verifier's required-step table is keyed on. */
    readonly repo: string;
    /** Source repository. Defaults to the root the run recorded. */
    readonly repoDir?: string;
    /** Step ids the run treated as required. Defaults to every step the report carries. */
    readonly declaredRequired?: readonly string[];
    readonly key?: Uint8Array;
    readonly now?: Date;
}
export declare function proofFromSignoffReport(input: ProofFromReportInput): SignoffProof;
