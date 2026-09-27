/**
 * The pure half of the editable record grid: the typed column vocabulary, the
 * per-cell parse/validate rules, display + editor formatting, and the
 * optimistic overlay a caller's rows are projected through.
 *
 * Zero React, zero DOM — a product can validate a row on a worker before it
 * ever reaches storage, and the component in `./record-grid` renders exactly
 * what these functions decide.
 *
 * Every domain word is a caller parameter: the module knows no column names,
 * no currencies, no option sets. What it owns is the mechanism four verticals
 * each re-derived — typed cells, an error a person can act on, and an
 * optimistic edit that can be taken back.
 */
import type { ProvenanceBasis } from './provenance-model';
/** The value one cell can hold. `null` is "no value on file". */
export type RecordGridValue = string | number | boolean | null;
/** Typed outcome for one cell. Callers MUST inspect `succeeded` before reading
 *  `value`; nothing here throws. */
export type RecordGridCellOutcome = {
    succeeded: true;
    value: RecordGridValue;
} | {
    succeeded: false;
    error: string;
};
/** Typed outcome for a whole row of inputs (the add form). `cellErrors` is
 *  keyed by column id so each control can render its own message. */
export type RecordGridRowOutcome = {
    succeeded: true;
    value: Record<string, RecordGridValue>;
} | {
    succeeded: false;
    error: string;
    cellErrors: Readonly<Record<string, string>>;
};
/** Build a cell success outcome. */
export declare function recordGridOk(value: RecordGridValue): RecordGridCellOutcome;
/** Build a cell failure outcome carrying the message shown next to the cell. */
export declare function recordGridFail(error: string): RecordGridCellOutcome;
/**
 * How a value came to sit in a cell. Rendered as the provenance tone.
 *
 * A type alias of `./provenance-model`'s `ProvenanceBasis`, not a lookalike:
 * two vocabularies for the same concept — a grid cell's origin — shipped one
 * day apart and would have drifted the moment either one added a value. The
 * grid gains `asserted` for free (a cell an agent claimed with nothing behind
 * it), where the caller previously had no way to say that.
 */
export type RecordGridSourceBasis = ProvenanceBasis;
/**
 * Where one cell's value came from. Optional on every row — a grid over data
 * with no lineage renders identically without it.
 */
export interface RecordGridCellSource {
    /** The text in the source that supports this value. */
    quote?: string;
    /** Human name of the source document, message, or system. */
    label?: string;
    /** Click-through to the source. */
    href?: string;
    /** Position inside the source: a page, a line, a span — the caller's words. */
    locator?: string;
    /** How the value got here. Absent renders as `asserted` — the weakest claim
     *  in the union — because a caller that stated no basis has established
     *  nothing about a document, and an omission must never read as one. */
    basis?: RecordGridSourceBasis;
}
/** One option of a `select` column. */
export interface RecordGridSelectOption {
    value: string;
    label: string;
}
/** A cell is only editable, rendered, and validated when the column it depends
 *  on holds `equals`. This is how a nested sub-form (a vesting schedule behind
 *  a "has vesting" toggle) stays a set of flat, individually-typed columns. */
export interface RecordGridDependency {
    column: string;
    equals: RecordGridValue;
}
/** Fields every column kind carries. */
export interface RecordGridColumnBase {
    /** Key into a row's `values` bag. */
    id: string;
    /** Column heading, and the accessible name of every control in the column. */
    header: string;
    /** Short hint rendered under the control in the add form. */
    hint?: string;
    /** An empty cell is rejected. */
    required?: boolean;
    /** Cells are editable unless this is `false`. */
    editable?: boolean;
    /** Cell alignment. Numeric kinds default to `right`. */
    align?: 'left' | 'right';
    /** Groups this column under a labelled sub-form in the add form. */
    group?: string;
    /** Only applicable when another column holds a given value. */
    dependsOn?: RecordGridDependency;
    /** Extra rule, run after the kind's own checks pass. Return the message to
     *  reject with, or `null` to accept. */
    validate?: (value: RecordGridValue) => string | null;
    /** Column summary rendered in the footer row. */
    footerValue?: (rows: readonly RecordGridRow[]) => RecordGridValue;
}
/** Free text, optionally length- or pattern-constrained. */
export interface RecordGridTextColumn extends RecordGridColumnBase {
    kind: 'text';
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    /** Message when `pattern` rejects. Without it the pattern source is shown. */
    patternMessage?: string;
    /** Render a textarea instead of a single-line input. */
    multiline?: boolean;
}
/** A plain number. */
export interface RecordGridNumberColumn extends RecordGridColumnBase {
    kind: 'number';
    min?: number;
    max?: number;
    integer?: boolean;
    /** Passed through to the editor's `step`. */
    step?: number;
}
/** A money amount. The currency is a caller parameter — this module bakes no
 *  domain value, so a product with two currencies declares two columns. */
export interface RecordGridCurrencyColumn extends RecordGridColumnBase {
    kind: 'currency';
    /** ISO 4217 code, e.g. `USD`. */
    currency: string;
    min?: number;
    max?: number;
    /** Fraction digits for display. Defaults to the currency's own. */
    fractionDigits?: number;
}
/** A calendar date held as `YYYY-MM-DD`; no time, no zone. */
export interface RecordGridDateColumn extends RecordGridColumnBase {
    kind: 'date';
    /** Earliest accepted date, `YYYY-MM-DD`. */
    min?: string;
    /** Latest accepted date, `YYYY-MM-DD`. */
    max?: string;
}
/** One of a closed set of values. */
export interface RecordGridSelectColumn extends RecordGridColumnBase {
    kind: 'select';
    options: readonly RecordGridSelectOption[];
}
/** A checkbox. */
export interface RecordGridBooleanColumn extends RecordGridColumnBase {
    kind: 'boolean';
    /** Label for `true`. Defaults to `Yes`. */
    trueLabel?: string;
    /** Label for `false`. Defaults to `No`. */
    falseLabel?: string;
}
/** Every column shape the grid renders. */
export type RecordGridColumn = RecordGridTextColumn | RecordGridNumberColumn | RecordGridCurrencyColumn | RecordGridDateColumn | RecordGridSelectColumn | RecordGridBooleanColumn;
/** One row: an id, a flat value bag keyed by column id, and optional per-cell
 *  provenance. A record-backed product maps its fold output straight onto
 *  this — one entry per cell, its quote and link in `sources`. */
export interface RecordGridRow {
    id: string;
    values: Readonly<Record<string, RecordGridValue>>;
    /** Per-cell provenance, keyed by column id. */
    sources?: Readonly<Record<string, RecordGridCellSource>>;
    /** No cell in this row may be edited or deleted. */
    readOnly?: boolean;
    /** Accessible name for the row's own controls. Falls back to the first text
     *  or select column's value, then the row id. */
    label?: string;
}
/** True when the column's dependency (if any) is satisfied by the row's other
 *  values. An inapplicable cell is never required, never validated, and never
 *  editable. */
export declare function isRecordGridCellApplicable(column: RecordGridColumn, values: Readonly<Record<string, RecordGridValue>>): boolean;
/** Value equality across the grid's value union, treating `undefined` as
 *  `null` so an absent key and an explicit null never read as a change. */
export declare function sameRecordGridValue(a: RecordGridValue | undefined, b: RecordGridValue | undefined): boolean;
/**
 * A proposed change set, diffed against the live rows by
 * {@link diffRecordGridProposal}. The grid's review mode renders exactly what
 * this shape declares — it owns no opinion about where the proposal came from
 * (an agent's `submit_proposal` call, a record store's pending entries).
 */
export interface RecordGridProposal {
    /** Proposed new cell values for EXISTING rows: row id → column id → value.
     *  Only cells that differ from the live value diff; an update that restates
     *  the current value is not a change. An id with no live row is ignored —
     *  adding a row is `additions`' job. */
    updates?: Readonly<Record<string, Readonly<Record<string, RecordGridValue>>>>;
    /** Proposed new rows. An addition whose id already names a live row is
     *  ignored — changing an existing row is `updates`' job. */
    additions?: readonly RecordGridRow[];
    /** Live row ids proposed for removal. Unknown ids are ignored. */
    removals?: readonly string[];
}
/** One cell whose proposed value differs from the live one. */
export interface RecordGridCellDiff {
    columnId: string;
    /** The live value — what rejecting keeps. */
    before: RecordGridValue;
    /** The proposed value — what accepting writes. */
    after: RecordGridValue;
}
export type RecordGridRowDiffKind = 'changed' | 'added' | 'removed';
/** One row's verdict: what the proposal does to it. */
export interface RecordGridRowDiff {
    rowId: string;
    kind: RecordGridRowDiffKind;
    /** The differing cells. Empty for `added`/`removed` — every cell of those is
     *  part of the change by definition. */
    cells: readonly RecordGridCellDiff[];
    /** The live row for `changed`/`removed`, the proposed row for `added`. */
    row: RecordGridRow;
}
/**
 * Diff a proposal against the live rows. Pure and deterministic: input order
 * in, diff order out — updates follow `rows` order, removals follow `rows`
 * order, additions follow the proposal's order. A row whose update bag diffs
 * to nothing produces no entry, so a no-op proposal yields an empty diff and
 * the grid has nothing to review.
 */
export declare function diffRecordGridProposal(rows: readonly RecordGridRow[], proposal: RecordGridProposal): RecordGridRowDiff[];
/**
 * Turn what an editor control produced into a typed value. Syntax only —
 * range, length, and membership are {@link validateRecordGridCell}'s job.
 */
export declare function parseRecordGridInput(column: RecordGridColumn, raw: string): RecordGridCellOutcome;
/**
 * Check one already-typed value against its column. Returns the value the grid
 * should store (empty text normalizes to `null`) or the message a person can
 * act on.
 */
export declare function validateRecordGridCell(column: RecordGridColumn, value: RecordGridValue): RecordGridCellOutcome;
/** Parse editor text and validate it in one step — what a committing cell
 *  editor calls. */
export declare function readRecordGridCell(column: RecordGridColumn, raw: string): RecordGridCellOutcome;
/**
 * Validate a whole value bag against the columns. Inapplicable cells (an
 * unsatisfied `dependsOn`) are forced to `null` rather than carried, so a
 * sub-form the user turned off cannot smuggle stale values into a write.
 */
export declare function validateRecordGridRow(columns: readonly RecordGridColumn[], values: Readonly<Record<string, RecordGridValue>>): RecordGridRowOutcome;
/** Display text for a cell. `null` renders as the empty string; the component
 *  decides what a missing value looks like. */
export declare function formatRecordGridValue(column: RecordGridColumn, value: RecordGridValue, locale?: string): string;
/** The text an editor control starts with — the raw value, never the formatted
 *  one, so committing an untouched cell is a no-op. */
export declare function recordGridEditorText(column: RecordGridColumn, value: RecordGridValue): string;
/** Accessible name for a row's own controls. */
export declare function recordGridRowLabel(columns: readonly RecordGridColumn[], row: RecordGridRow): string;
/** Sum a numeric column over the rows that hold a number. Rows with no value
 *  are absent from the sum, not zero — a total over three of five filled cells
 *  is the total of what is on file. */
export declare function sumRecordGridColumn(rows: readonly RecordGridRow[], columnId: string): number;
/**
 * Edits the grid has applied locally but the caller's `rows` prop has not yet
 * caught up with. Every field is what rollback removes: drop the entry and the
 * caller's own data shows through again.
 */
export interface RecordGridOverlay {
    /** rowId → columnId → optimistic value. */
    updates: Readonly<Record<string, Readonly<Record<string, RecordGridValue>>>>;
    /** Rows created locally, in insertion order. */
    created: readonly RecordGridRow[];
    /** Row ids removed locally. */
    removed: readonly string[];
}
/** An overlay holding nothing. */
export declare const EMPTY_RECORD_GRID_OVERLAY: RecordGridOverlay;
/** The rows to render: caller rows minus local deletes, with local cell edits
 *  applied, then locally-created rows. */
export declare function projectRecordGridRows(rows: readonly RecordGridRow[], overlay: RecordGridOverlay): RecordGridRow[];
/** Record one optimistic cell edit. */
export declare function withRecordGridUpdate(overlay: RecordGridOverlay, rowId: string, columnId: string, value: RecordGridValue): RecordGridOverlay;
/** Take back one optimistic cell edit — the rollback path. */
export declare function withoutRecordGridUpdate(overlay: RecordGridOverlay, rowId: string, columnId: string): RecordGridOverlay;
/** Adopt a row the writer returned as canonical: for a locally-created row it
 *  replaces the draft; for an existing row it replaces the optimistic cells.
 *  Either way the draft's pending cell edits go with it — the canonical row IS
 *  the answer, and leaving an edit layered over it is how a grid keeps showing
 *  a value the server normalized away. */
export declare function withRecordGridServerRow(overlay: RecordGridOverlay, draftId: string, row: RecordGridRow): RecordGridOverlay;
/** Record an optimistic create. */
export declare function withRecordGridCreated(overlay: RecordGridOverlay, row: RecordGridRow): RecordGridOverlay;
/** Take back an optimistic create — the rollback path. Cell edits made against
 *  the draft go with it; the row they applied to no longer exists anywhere. */
export declare function withoutRecordGridCreated(overlay: RecordGridOverlay, rowId: string): RecordGridOverlay;
/** Record an optimistic delete. */
export declare function withRecordGridRemoved(overlay: RecordGridOverlay, rowId: string): RecordGridOverlay;
/** Take back an optimistic delete — the rollback path. */
export declare function withoutRecordGridRemoved(overlay: RecordGridOverlay, rowId: string): RecordGridOverlay;
/**
 * Drop the overlay entries the caller's own rows have caught up with: a cell
 * whose value now matches, a created row now present, a removed row now gone.
 * Without this an overlay would mask every later refresh of the same cell.
 *
 * Returns the SAME overlay object when nothing settled, so a caller can prune
 * on every render without looping.
 */
export declare function pruneRecordGridOverlay(rows: readonly RecordGridRow[], overlay: RecordGridOverlay): RecordGridOverlay;
