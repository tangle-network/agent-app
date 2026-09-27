import type { ReconcileSpendOptions } from './reconcile';
/** A usage or config problem — exit code 2, never a finding. */
export declare class SpendUsageError extends Error {
}
export declare const USAGE: string;
export interface SpendCliArgs {
    readonly configFile: string;
    readonly json: boolean;
    readonly asOf: number | undefined;
    readonly skip: readonly string[];
}
/** Parse argv. Split out of `cli.ts` so it is testable without a `process.exit`. */
export declare function parseSpendArgs(argv: readonly string[]): SpendCliArgs;
/**
 * Load the product's reconcile options.
 *
 * A function export is awaited, so a config can open its database connection and
 * mint its platform credential at load time rather than at module scope.
 */
export declare function loadSpendConfig(configFile: string): Promise<ReconcileSpendOptions>;
