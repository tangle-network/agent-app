/**
 * Check 1 — engineering vocabulary on screen.
 *
 * The defect: a word from the codebase reaches the reader. Shipped instances
 * include "materialized" inside a user-facing error, a column of `sourceKind`,
 * and a chip reading `undefined`. Nobody decided to say those words; they leaked
 * because the label and the field name were the same string.
 *
 * ── Precision over recall, deliberately ──────────────────────────────────────
 *
 * A vocabulary gate lives or dies on false positives: one bad report and the
 * check is disabled, after which it guards nothing. `grep -i artifact` over one
 * product's `apps/web/src` returns 11 hits, all of them imports, prop names or
 * doc comments — a checker that reports those is deleted in a week.
 *
 * So this check only reads positions the lexer PROVES are copy, in two tiers
 * that are ON by default:
 *
 *  1. JSX text — `<p>No artifact yet</p>`. Unambiguous.
 *  2. A JSX attribute value, when the attribute is in {@link COPY_KEYS}. An
 *     allowlist, so `className`, `data-*`, `aria-*`, `id`, `href` and every
 *     other internal attribute are excluded by construction rather than by a
 *     denylist that goes stale.
 *  3. The first argument of a call in {@link COPY_CALLS} — `toast.error('…')`,
 *     `new Error('…')`, `setError('…')`. This is the tier that catches the
 *     flagship defect: "materialization" reached a reader from a `new Error`
 *     in a server module, not from a component.
 *
 * And ONE tier that is off by default, `includeObjectCopy`:
 *
 *  4. A string or template filling an object key named in {@link COPY_KEYS}
 *     (`emptyTitle: '…'`, `description: '…'`).
 *
 * Tier 4 is off because it was MEASURED as the false-positive tier. Over two
 * production verticals it produced findings on a system prompt (`prompt:` in an
 * agent profile), an MCP tool description the model reads, and the body of a
 * legal document template where "Records" is a term of the drafted document —
 * none of them on any screen. A key named `description` is model-facing about
 * as often as it is reader-facing, and a checker that cannot tell them apart
 * must not be the one that fails the build. Products whose data modules really
 * do hold UI copy turn it on.
 *
 * Everything else — a bare string in code, an import specifier, a comment, an
 * identifier, a test file — is not read at all. The cost is real recall: copy
 * assembled through a variable (`const msg = base + suffix`) is invisible here,
 * and no lexer can see it. That is the trade this check makes on purpose.
 */
import type { ScannedFile } from '../scan';
import type { BannedTerm, RawFinding, VocabularyOptions } from '../types';
/**
 * The default list. Every entry has shipped to a real screen in this fleet or
 * its verticals, and every one carries the sentence that replaces it — a gate
 * that only says "don't" leaves the author to guess.
 */
export declare const DEFAULT_BANNED_TERMS: readonly BannedTerm[];
/**
 * Attributes and object keys whose string value is copy. An allowlist: an
 * attribute that is not here is never read, which is how `aria-label`,
 * `className`, `data-testid` and `href` stay out without being enumerated.
 */
export declare const COPY_KEYS: readonly string[];
/** Calls whose first string argument reaches the reader. */
export declare const COPY_CALLS: readonly string[];
/** Run the vocabulary check over one lexed file. */
export declare function checkVocabulary(file: ScannedFile, options?: VocabularyOptions): RawFinding[];
