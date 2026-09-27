/**
 * Suppression: how a product says "this one is deliberate" without switching
 * the gate off.
 *
 * The design constraint is the whole reason this gate exists at all. A checker
 * that cannot be silenced per-line gets silenced per-repo — the config flag is
 * flipped once, in a rush, and nobody ever flips it back. So every finding is
 * individually suppressible; and because a silent suppression is
 * indistinguishable from a disabled check six months later, a suppression
 * without a written reason is ITSELF a finding, and does not suppress.
 *
 *   // legibility-ignore engineering-vocabulary — "conflict" is the term of art
 *   // a litigator uses; renaming it would make the screen less clear, not more
 *   <p>Conflict check cleared</p>
 *
 * Forms:
 *   - a comment on its own line suppresses the NEXT line that has content
 *   - a trailing comment suppresses ITS OWN line
 *   - `legibility-ignore-file <check>` suppresses the check for the whole file
 *   - several checks may be named, comma-separated
 *   - JSX comments (`{​/* … *​/}`) work, since they lex as comments too
 *
 * Honoured suppressions are returned, not swallowed: the report prints the
 * count and `--list-suppressions` prints every one with its reason, so the
 * exemptions stay as visible as the failures.
 */
import type { ScannedFile } from './scan';
import { type LegibilityCheckId, type RawFinding } from './types';
export interface SuppressionIndex {
    /** Decide a finding: honoured suppression, or not. */
    reasonFor(check: LegibilityCheckId, line: number): string | null;
    /** Findings the suppression syntax itself produced (missing reason, unknown check). */
    readonly selfFindings: readonly RawFinding[];
}
/** Parse every `legibility-ignore` directive in one lexed file. */
export declare function buildSuppressionIndex(file: ScannedFile): SuppressionIndex;
