import type { SpendReport } from './types';
/**
 * Render a reconciliation for a human deciding whether to open a dispute.
 *
 * Every finding prints its numbers, not a summary of them: the reader's next
 * action is a conversation with the platform about specific reference ids, and a
 * report that made them re-derive the durations would just be re-read alongside
 * the raw rows anyway.
 */
export declare function formatSpendReport(report: SpendReport): string;
/** The report as a plain JSON value, for an alerting pipeline. */
export declare function spendReportToJson(report: SpendReport): string;
