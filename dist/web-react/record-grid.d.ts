/**
 * `RecordGrid` — the editable record table four verticals each hand-rolled: a
 * cap table, two relationship record pages, a content board, and an entities
 * panel. Every copy re-derived the same mechanism and each one lost a
 * different part of it.
 *
 * What this owns:
 *
 *  - **Typed columns with correctable errors.** A cell is text / number /
 *    currency / date / select / boolean (`./record-grid-model`), so a rejected
 *    edit explains itself next to the control instead of storing a coerced
 *    value.
 *  - **Optimistic write with a real rollback.** The edit lands instantly, the
 *    caller's writer returns a typed outcome, and a failure puts the previous
 *    value back AND says why. A grid that keeps a value the server refused is
 *    the defect this replaces.
 *  - **Provenance per cell.** An optional quote + link + basis, so a
 *    record-backed grid shows where a value came from without the product
 *    building a second surface for it.
 *  - **Review of a proposed change set.** Hand the grid a `proposed` patch
 *    (`./record-grid-model`'s `diffRecordGridProposal`) and it becomes the
 *    red/green row-diff surface a tax/legal review needs: changed cells render
 *    the struck live value against the proposed one, added/removed rows are
 *    marked, and every diffed row carries accept/reject — per row and for the
 *    whole set. What accepting MEANS stays the caller's (a record-store review
 *    write); the grid reports decisions, it does not persist them.
 *  - **Three distinct data states, on `web-react/async`'s own contract.**
 *    `state: AsyncResourceState<Row[]>` and `empty: AsyncEmptySpec` are the
 *    same types every other screen fetches through — loading, error-with-
 *    retry and empty are different renders, a failed fetch never looks like
 *    "no data yet", and the empty state carries the CALLER's next action.
 *    The optimistic overlay is layered on top of whichever `ready`/`empty`
 *    value the caller last supplied, so a row created while the caller's own
 *    status is still `empty` renders immediately rather than waiting for a
 *    refetch.
 *  - **Keyboard-navigable, labelled controls.** Arrow keys move between cells,
 *    Enter edits, Escape cancels, and no destructive control is an unlabelled
 *    icon.
 *
 * Presentation is Tailwind against the shared design tokens, with no icon
 * library and no sandbox-ui — the same contract as the rest of `/web-react`.
 */
import { type ReactNode } from 'react';
import { type AsyncEmptySpec, type AsyncResourceState } from './async';
import { type RecordGridColumn, type RecordGridProposal, type RecordGridRow, type RecordGridValue } from './record-grid-model';
export * from './record-grid-model';
/** One committed cell edit, handed to `onUpdate`. */
export interface RecordGridCellChange {
    /** The row as it was BEFORE the edit — what rollback restores. */
    row: RecordGridRow;
    columnId: string;
    value: RecordGridValue;
    /** The full value bag after the edit: what a whole-row write would send. */
    values: Readonly<Record<string, RecordGridValue>>;
}
/** Outcome of an update or a delete. `value` optionally carries the server's
 *  canonical row, which replaces the optimistic one. */
export type RecordGridWriteOutcome = {
    succeeded: true;
    value?: RecordGridRow;
} | {
    succeeded: false;
    error: string;
};
/** Outcome of a create. The row is REQUIRED on success: a create that does not
 *  name the row it wrote leaves the grid unable to address it. */
export type RecordGridCreateOutcome = {
    succeeded: true;
    value: RecordGridRow;
} | {
    succeeded: false;
    error: string;
};
/** Properties for the editable, provenance-aware record grid. */
export interface RecordGridProps {
    /** Column definitions, in render order. */
    columns: readonly RecordGridColumn[];
    /** Fetch state over the caller's rows — `web-react/async`'s
     *  `AsyncResourceState`, the same three-state contract every other screen
     *  in the shell fetches through. `ready`/`empty`'s value is the base rows;
     *  optimistic edits are layered over it and dropped as a later value
     *  catches up. `error` always carries `retry` — there is no way to render a
     *  failed fetch with no recovery action, by construction. */
    state: AsyncResourceState<readonly RecordGridRow[]>;
    /** Accessible name for the grid. Required — an unnamed grid is unusable with
     *  a screen reader. */
    caption: string;
    /** What the empty state says, and what it offers next — `web-react/async`'s
     *  `AsyncEmptySpec`, so an empty grid reads in the same words as an empty
     *  list or panel elsewhere in the product. */
    empty: AsyncEmptySpec;
    /** Persist one created row. Absent → no add affordance. */
    onCreate?: (values: Readonly<Record<string, RecordGridValue>>) => Promise<RecordGridCreateOutcome>;
    /** Persist one cell edit. Absent → every cell renders read-only. */
    onUpdate?: (change: RecordGridCellChange) => Promise<RecordGridWriteOutcome>;
    /** Delete one row. Absent → no delete affordance. */
    onDelete?: (row: RecordGridRow) => Promise<RecordGridWriteOutcome>;
    /** A proposed change set to review against the live rows (see
     *  `diffRecordGridProposal`). While a non-empty diff is on the table the grid
     *  is a REVIEW surface, not an editor: cell editing, row add, and row delete
     *  are inert; changed cells render the struck live value against the
     *  proposed one; added/removed rows are marked; each diffed row carries
     *  accept/reject controls. A proposal that diffs to nothing renders the grid
     *  unchanged — there is nothing to review. */
    proposed?: RecordGridProposal;
    /** Accept one diffed row — write its proposed values, adopt the addition, or
     *  confirm the removal. The caller owns what accepting MEANS (a record-store
     *  review write); the grid reports the decision and the caller moves the row
     *  out of `proposed`. */
    onAcceptRow?: (rowId: string) => void;
    /** Reject one diffed row — the live row stands. */
    onRejectRow?: (rowId: string) => void;
    /** Accept every remaining diffed row at once. */
    onAcceptAll?: () => void;
    /** Reject every remaining diffed row at once. */
    onRejectAll?: () => void;
    /** Starting values for the add form. */
    newRowDefaults?: Readonly<Record<string, RecordGridValue>>;
    /** Label of the add control and of the add form. Defaults to `Add row`. */
    addLabel?: string;
    /** BCP-47 locale for number, currency, and date display. */
    locale?: string;
    /** Rendered above the grid — filters, counts, a product action row. */
    toolbar?: ReactNode;
    /** Skeleton rows in the loading state. Defaults to 3. */
    loadingRowCount?: number;
    className?: string;
}
/**
 * The shared editable record table. A row is a flat value bag keyed by column
 * id, so a record store's fold output maps straight on: one cell per entry,
 * its quote and link in `sources`.
 */
export declare function RecordGrid({ columns, caption, state, empty, onCreate, onUpdate, onDelete, proposed, onAcceptRow, onRejectRow, onAcceptAll, onRejectAll, newRowDefaults, addLabel, locale, toolbar, loadingRowCount, className, }: RecordGridProps): import("react").JSX.Element;
