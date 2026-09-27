/**
 * The report a product reads in its CI log.
 *
 * A gate is only as good as the sentence a developer reads at 6pm with a red
 * build. So every finding prints three things and never fewer: WHERE
 * (`file:line:col`, clickable in every terminal and editor), WHAT is wrong in
 * the reader's terms, and WHAT TO DO about it. A finding without a remedy is a
 * complaint, and complaints get suppressed rather than fixed.
 *
 * Honoured suppressions are counted in the summary and listed on request. A
 * suppression that nobody can see is a disabled check with extra steps.
 */
import { type LegibilityReport } from './types';
export interface FormatOptions {
    /** Print every honoured suppression with its reason. */
    readonly listSuppressions?: boolean;
    /** Wrap check names in ANSI colour. Off by default — CI logs keep the bytes. */
    readonly colour?: boolean;
}
export declare function formatLegibilityReport(report: LegibilityReport, options?: FormatOptions): string;
/** The machine-readable form, for a product that posts findings somewhere. */
export declare function legibilityReportToJson(report: LegibilityReport): string;
