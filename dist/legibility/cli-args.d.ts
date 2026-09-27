/**
 * The bin's argument and config layer, split from `cli.ts` so it can be tested
 * without executing a `main()` that calls `process.exit`.
 *
 * Errors are thrown as {@link LegibilityUsageError} rather than exiting here:
 * exiting is the bin's job, and a parser that exits cannot be exercised.
 */
import { type LegibilityCheckId, type LegibilityConfig } from './types';
export declare const DEFAULT_CONFIG_FILE = "legibility.config.mjs";
/** A usage or config problem — exit code 2, never a finding. */
export declare class LegibilityUsageError extends Error {
}
export interface ParsedArgs {
    srcDirs: string[];
    navFiles: string[];
    ignorePaths: string[];
    skip: LegibilityCheckId[];
    routes?: string;
    config?: string;
    json: boolean;
    listSuppressions: boolean;
    help: boolean;
}
export declare const USAGE: string;
export declare function parseArgs(argv: readonly string[]): ParsedArgs;
/**
 * Merge a config file with the flags. Flags WIN, so a one-off CI invocation can
 * narrow a run without editing the committed config.
 */
export declare function mergeConfig(fromFile: Partial<LegibilityConfig>, args: ParsedArgs): LegibilityConfig;
