/**
 * Check 2 — dead-end empty states.
 *
 * The defect, measured on one vertical: 21 empty states, 11 of them offering no
 * next action. A screen that says "No deadlines tracked yet" and nothing else
 * has told the reader they are in the right place and stranded them there. It
 * is the cheapest, most repeated legibility failure in the fleet, and it is
 * mechanically detectable: the empty branch renders no button, no link, no form
 * control.
 *
 * ── How the empty branch is scoped ───────────────────────────────────────────
 *
 * The interesting part is not finding the words, it is deciding what subtree
 * "the empty state" means. Walking up to the page root would find some button
 * somewhere and never report anything; stopping at the `<p>` would report every
 * empty state, action or not.
 *
 * The lexer records, for each element, the `{` of its enclosing JSX expression
 * container. Elements sharing a container are one conditional branch — exactly
 * how empty states are written:
 *
 *     {rows.length === 0 && (            ← container
 *       <div className="empty">          ← branch root, same container
 *         <p>No deadlines tracked yet</p>
 *       </div>
 *     )}
 *
 * So the branch root is the outermost ancestor sharing the text's container,
 * and the subtree searched for an action is exactly that branch. A component
 * that takes its empty copy as props (`emptyTitle="No sessions yet"`) is its own
 * root, and its action props are read the same way.
 *
 * Recall limit: copy held in a variable or returned from a helper is invisible
 * to a lexer, and an "action" reached only through a child component's internals
 * is assumed present when that component takes an action-shaped prop.
 *
 * ── A titled section's zero-state is not a dead end ──────────────────────────
 *
 * The one measured false-positive class, and the one that decides whether this
 * check survives contact with a team. A contract detail screen carries four
 * zero-states — "No parties recorded.", "No open findings.", "No resolved
 * findings yet.", "No renewal alerts configured." — one under each `<h2>`. None
 * of them strands anybody: the screen is full, the reader is oriented, and the
 * line is the honest label for a section that is empty. Reporting all four (and
 * a table's "No findings." beside its own Run button, and a kanban column's "No
 * filings") buries the defect this check exists for — the screen whose ENTIRE
 * body is "No deadlines tracked yet".
 *
 * So a branch whose nearest preceding SIBLING is a heading is a section label
 * and is not reported. Measured over two production verticals: 21 findings → 12,
 * removing 8 section labels and 1 success state, and keeping every page-level
 * dead end. The recall cost is a real one — a screen whose whole body is one
 * titled, actionless section reads as a section here — and `emptyState:
 * { reportSectionZeroStates: true }` turns it back on.
 */
import type { ScannedFile } from '../scan';
import type { EmptyStateOptions, RawFinding } from '../types';
/** Run the dead-end empty-state check over one lexed file. */
export declare function checkEmptyStates(file: ScannedFile, options?: EmptyStateOptions): RawFinding[];
