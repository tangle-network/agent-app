import type { SignoffReport, SignoffStepResult } from './types';
/** Concurrency actually achieved, measured from the step windows rather than
 *  asserted from the config. A claimed speedup nobody measured is a wish. */
export declare function peakConcurrency(steps: readonly SignoffStepResult[]): number;
export declare function formatSignoffReport(report: SignoffReport): string;
/** One line for a commit message, a PR comment, or a chat handoff. */
export declare function formatSignoffLine(report: SignoffReport): string;
